#!/usr/bin/env node
/**
 * new-deck.mjs — scaffold a self-contained aios-deck deck folder.
 *
 * Usage:
 *   node new-deck.mjs <target-dir> --theme <slug> [--title "..."] [--slides <list>]
 *                     [--subtitle "..."] [--presenter "..."] [--horizontal]
 *                     [--force] [--list-slides] [--list-themes]
 *
 * Writes deck.html + deck-base.css + theme.css + deck-nav.js + assets/ + MANIFEST.md.
 * Every file is COPIED into the folder, never symlinked or @import-ed from the
 * skill: a handover deck is opened from file:// and must resolve nothing outside
 * its own directory (reference/gotchas.md #13).
 *
 * The emitted markup comes verbatim from reference/slide-catalog.md, with
 * placeholder copy sized so the deck passes `scripts/qa-deck.mjs` — including the
 * 1280x720 / 1440x810 overflow check — the moment it is generated. All imagery is
 * an inline data: URI, so a brand-new deck renders with zero missing assets.
 *
 * Zero dependencies beyond node: builtins. Exit 0 on success, 2 on usage/IO error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
/* Resolve skill assets from the SCRIPT's own location — never process.cwd(),
   because this is run from inside a scaffolded workspace, not from the skill. */
const SKILL = path.resolve(HERE, '..');
const ASSETS = path.join(SKILL, 'assets');
const THEMES = path.join(ASSETS, 'themes');

const DEFAULT_SLIDES = 'cover,statement,content,two-col,cards,demo,close';

/* ------------------------------------------------------------------ utils */

const die = (msg) => { process.stderr.write(`new-deck: ${msg}\n`); process.exit(2); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Encode an SVG string as a data: URI safe inside both an HTML attribute and CSS url(). */
function dataSvg(svg) {
  const flat = svg.replace(/\s+/g, ' ').trim();
  return 'data:image/svg+xml,' + encodeURIComponent(flat)
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/* --------------------------------------------------- placeholder artwork */
/* Neutral greys on purpose: these live in their own SVG document and cannot see
   the deck's theme tokens, so they must not pretend to be brand colour. */

const uiShot = (w, h, label) => {
  const r = Math.round;
  const bar = r(h * 0.11);                       /* window chrome */
  const side = r(w * 0.22);                      /* left rail */
  const mx = r(w * 0.26), mw = r(w * 0.68);      /* main column */
  const pad = r(h * 0.06);
  const rowH = r(h * 0.26);                      /* bottom card row */
  const rowY = h - pad - rowH;
  const chartY = bar + pad + r(h * 0.09);
  const chartH = rowY - chartY - r(h * 0.05);
  return dataSvg(`
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#f2f3f5"/>
  <rect x="0" y="${bar}" width="${side}" height="${h - bar}" fill="#e8eaee"/>
  <rect x="0" y="0" width="${w}" height="${bar}" fill="#e2e4e8"/>
  <circle cx="${r(bar * 0.6)}" cy="${r(bar / 2)}" r="${r(bar * 0.17)}" fill="#c7cad0"/>
  <circle cx="${r(bar * 1.2)}" cy="${r(bar / 2)}" r="${r(bar * 0.17)}" fill="#c7cad0"/>
  <circle cx="${r(bar * 1.8)}" cy="${r(bar / 2)}" r="${r(bar * 0.17)}" fill="#c7cad0"/>
  <text x="${w - 12}" y="${r(bar * 0.68)}" text-anchor="end" font-family="monospace" font-size="${Math.max(9, r(h * 0.045))}" fill="#9aa0a8">${label}</text>
  <rect x="${r(w * 0.04)}" y="${bar + pad}" width="${r(w * 0.14)}" height="8" rx="4" fill="#cdd1d8"/>
  <rect x="${r(w * 0.04)}" y="${bar + pad + 22}" width="${r(w * 0.16)}" height="8" rx="4" fill="#cdd1d8"/>
  <rect x="${r(w * 0.04)}" y="${bar + pad + 44}" width="${r(w * 0.12)}" height="8" rx="4" fill="#cdd1d8"/>
  <rect x="${mx}" y="${bar + pad}" width="${r(mw * 0.62)}" height="12" rx="6" fill="#c9ccd3"/>
  <rect x="${mx}" y="${chartY}" width="${mw}" height="${chartH}" rx="8" fill="#ffffff" stroke="#dcdfe4"/>
  <rect x="${mx}" y="${rowY}" width="${r(mw * 0.46)}" height="${rowH}" rx="8" fill="#ffffff" stroke="#dcdfe4"/>
  <rect x="${mx + r(mw * 0.52)}" y="${rowY}" width="${r(mw * 0.48)}" height="${rowH}" rx="8" fill="#ffffff" stroke="#dcdfe4"/>
</svg>`);
};

const photoBg = dataSvg(`
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b2f3a"/><stop offset="0.55" stop-color="#4a4054"/>
      <stop offset="1" stop-color="#1d2430"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#g)"/>
  <circle cx="1180" cy="300" r="240" fill="#ffffff" opacity="0.06"/>
  <circle cx="1420" cy="640" r="180" fill="#ffffff" opacity="0.05"/>
  <circle cx="960" cy="720" r="140" fill="#ffffff" opacity="0.04"/>
  <text x="1560" y="870" text-anchor="end" font-family="monospace" font-size="20" fill="#ffffff" opacity="0.35">PLACEHOLDER PHOTO</text>
</svg>`);

const logoSvg = dataSvg(`
<svg xmlns="http://www.w3.org/2000/svg" width="132" height="26" viewBox="0 0 132 26">
  <rect x="0" y="3" width="20" height="20" rx="5" fill="#ffffff" opacity="0.9"/>
  <rect x="6" y="9" width="8" height="8" rx="2" fill="#2b2f3a"/>
  <rect x="28" y="8" width="64" height="10" rx="5" fill="#ffffff" opacity="0.85"/>
  <rect x="98" y="8" width="30" height="10" rx="5" fill="#ffffff" opacity="0.45"/>
</svg>`);

const glyphSvg = dataSvg(`
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
  <rect x="2" y="2" width="36" height="36" rx="9" fill="none" stroke="#9aa0a8" stroke-width="2"/>
  <circle cx="20" cy="20" r="7" fill="#9aa0a8"/>
</svg>`);

const portrait = (initials) => dataSvg(`
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
  <rect width="320" height="320" fill="#dfe2e7"/>
  <circle cx="160" cy="128" r="52" fill="#bcc1c9"/>
  <path d="M40 300 C40 214 120 190 160 190 C200 190 280 214 280 300 Z" fill="#bcc1c9"/>
  <text x="160" y="52" text-anchor="middle" font-family="monospace" font-size="24" fill="#8d939c">${initials}</text>
</svg>`);

const fullDiagram = dataSvg(`
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="380" viewBox="0 0 900 380">
  <rect width="900" height="380" fill="#f4f5f7"/>
  <rect x="60" y="120" width="180" height="90" rx="10" fill="#ffffff" stroke="#c9ccd3"/>
  <rect x="360" y="120" width="180" height="90" rx="10" fill="#ffffff" stroke="#c9ccd3"/>
  <rect x="660" y="120" width="180" height="90" rx="10" fill="#ffffff" stroke="#c9ccd3"/>
  <line x1="240" y1="165" x2="360" y2="165" stroke="#c9ccd3" stroke-width="2"/>
  <line x1="540" y1="165" x2="660" y2="165" stroke="#c9ccd3" stroke-width="2"/>
  <text x="150" y="170" text-anchor="middle" font-family="monospace" font-size="16" fill="#6b7178">INPUT</text>
  <text x="450" y="170" text-anchor="middle" font-family="monospace" font-size="16" fill="#6b7178">PROCESS</text>
  <text x="750" y="170" text-anchor="middle" font-family="monospace" font-size="16" fill="#6b7178">OUTPUT</text>
  <text x="450" y="300" text-anchor="middle" font-family="monospace" font-size="14" fill="#9aa0a8">PLACEHOLDER DIAGRAM — replace with a real export</text>
</svg>`);

const IMG = {
  photo: photoBg,
  logo: logoSvg,
  glyph: glyphSvg,
  hero: uiShot(640, 400, 'hero'),
  wide: uiShot(760, 428, 'screen'),
  before: uiShot(560, 340, 'before'),
  after: uiShot(560, 340, 'after'),
  t1: uiShot(420, 260, 'view 1'),
  t2: uiShot(420, 260, 'view 2'),
  diagram: fullDiagram,
  pA: portrait('AR'), pB: portrait('BO'), pC: portrait('CM'),
  pD: portrait('DK'), pE: portrait('EL'),
};

/* ------------------------------------------------------------ slide types */
/* Markup is the catalog's, verbatim. Copy is deliberately short: a scaffold has
   to be green under qa-deck check (c) at 1280x720 before an author touches it. */

const CARD_MEDIA = `<div class="card-media">
          <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid meet">
            <rect class="svg-box" x="118" y="58" width="84" height="64" rx="9"/>
            <circle class="svg-accent" cx="160" cy="90" r="10"/>
            <line class="svg-rule" x1="40" y1="90" x2="112" y2="90"/>
            <line class="svg-rule" x1="208" y1="90" x2="280" y2="90"/>
          </svg>
        </div>`;

const card = (n) => `      <div class="principle-card">
        ${CARD_MEDIA}
        <h3>Principle ${n}</h3>
        <p>One or two sentences. Not a list disguised as a card.</p>
      </div>`;

const person = (src, name, role, bio) => `        <div class="person-card">
          <img src="${src}" alt="Portrait of ${name}">
          <div class="p-name">${name}</div>
          <div class="p-role">${role}</div>
          <div class="p-bio">${bio}</div>
        </div>`;

const SLIDES = {
  cover: {
    desc: 'Slide 1. Photo + logo + title over a three-column grid.',
    html: (c) => `    <section class="slide cover" style="--photo-bg-image:url('${IMG.photo}')">
      <div class="cover-left">
        <img class="deck-logo" src="${IMG.logo}" alt="Company logo">
        <h1 class="slide-title">${esc(c.title)}</h1>
        <h2 class="slide-sub">${esc(c.subtitle)}</h2>
        <div class="brandline">${esc(c.presenter)} · ${esc(c.dateHuman)}</div>
      </div>
      <div class="cover-mid">
        <div class="shot"><img src="${IMG.hero}" alt="Product dashboard placeholder"></div>
      </div>
      <div class="cover-right"></div>
    </section>`,
  },

  hero: {
    desc: 'Text-only hero over a photograph (horizontal scrim, text pinned left).',
    html: () => `    <section class="slide photo-slide" style="--photo-bg-image:url('${IMG.photo}')">
      <div class="kicker">Eyebrow</div>
      <h1 class="slide-title slide-title--lg">Headline over a photograph.</h1>
      <h2 class="slide-sub">One line of sub-copy that says why the image is here.</h2>
      <div class="brandline">Attribution line</div>
    </section>`,
  },

  statement: {
    desc: 'One sentence, centred. The thesis, an act break, a question to sit with.',
    html: () => `    <section class="slide center-slide">
      <div class="kicker">Section</div>
      <h1 class="slide-title slide-title--lg">One sentence that earns the whole slide.</h1>
      <h2 class="slide-sub">At most one line of qualification. Usually none.</h2>
    </section>`,
  },

  content: {
    desc: 'The workhorse: title, sub, argued list, footnote.',
    html: () => `    <section class="slide">
      <div class="kicker">Eyebrow</div>
      <h1 class="slide-title">The claim this slide proves.</h1>
      <h2 class="slide-sub">The one-line version of the argument.</h2>
      <ul class="clean">
        <li><strong>Named thing.</strong> What it is and why it matters here.</li>
        <li><strong>Named thing.</strong> What it is and why it matters here.</li>
        <li><strong>Named thing.</strong> What it is and why it matters here.</li>
      </ul>
      <div class="footnote">Source or caveat.</div>
    </section>`,
  },

  'two-col': {
    desc: 'Two columns: before/after, cause/consequence, text beside a visual.',
    html: () => `    <section class="slide">
      <div class="kicker">Eyebrow</div>
      <h1 class="slide-title">Two columns, one comparison</h1>
      <h2 class="slide-sub">Say what the reader should compare.</h2>
      <div class="two-col">
        <div>
          <div class="shot shot--col"><img src="${IMG.before}" alt="Before state"></div>
          <div class="col-heading--plain">Before</div>
          <ul class="check-list">
            <li>Point</li>
            <li>Point</li>
          </ul>
        </div>
        <div>
          <div class="shot shot--col"><img src="${IMG.after}" alt="After state"></div>
          <div class="col-heading--plain">After</div>
          <ul class="check-list">
            <li>Point</li>
            <li>Point</li>
          </ul>
        </div>
      </div>
    </section>`,
  },

  cards: {
    desc: 'Card grid — 3 or 4 peer principles, values or capabilities.',
    html: () => `    <section class="slide">
      <div class="kicker">Eyebrow</div>
      <h1 class="slide-title">Four things, one grid</h1>
      <div class="principle-grid" style="--cols: 4">
${[1, 2, 3, 4].map(card).join('\n')}
      </div>
    </section>`,
  },

  options: {
    desc: 'Three option cards, one carrying the Recommended ribbon.',
    html: () => `    <section class="slide">
      <div class="kicker">The options</div>
      <h1 class="slide-title slide-title--sm">Three paths, one recommendation</h1>
      <div class="grid3">
        <div class="option-card">
          <h3>Option A</h3>
          <div class="thesis">The one-line case for it.</div>
          <ul class="tight"><li>Detail</li><li>Detail</li></ul>
          <div class="chip-row"><span class="chip">4 weeks</span><span class="chip">1 person</span></div>
        </div>
        <div class="option-card recommended">
          <div class="badge">Recommended</div>
          <h3>Option B</h3>
          <div class="thesis">The one-line case for it.</div>
          <ul class="tight"><li>Detail</li><li>Detail</li></ul>
          <div class="chip-row"><span class="chip">8 weeks</span><span class="chip">2 people</span></div>
        </div>
        <div class="option-card">
          <h3>Option C</h3>
          <div class="thesis">The one-line case for it.</div>
          <ul class="tight"><li>Detail</li><li>Detail</li></ul>
          <div class="chip-row"><span class="chip">12 weeks</span><span class="chip">4 people</span></div>
        </div>
      </div>
      <div class="note"><strong>Why B.</strong> The reason, in one sentence.</div>
    </section>`,
  },

  spectrum: {
    desc: 'A continuous trade-off with named stops, one recommended.',
    html: () => `    <section class="slide">
      <div class="kicker">The trade-off</div>
      <h1 class="slide-title slide-title--sm">It's a dial, not three buttons</h1>
      <div class="spectrum">
        <div class="spectrum-track"></div>
        <div class="spectrum-stops">
          <div class="spectrum-stop">
            <div class="spectrum-dot" style="background: var(--violet)"></div>
            <h3>Narrow</h3>
            <p>What this end buys you.</p>
          </div>
          <div class="spectrum-stop recommended">
            <div class="badge badge--center">Recommended</div>
            <div class="spectrum-dot" style="background: var(--blue)"></div>
            <h3>Balanced</h3>
            <p>What this position buys you.</p>
          </div>
          <div class="spectrum-stop">
            <div class="spectrum-dot" style="background: var(--cyan-strong)"></div>
            <h3>Broad</h3>
            <p>What this end buys you.</p>
          </div>
        </div>
        <div class="spectrum-axis"><span>Faster, cheaper</span><span>Slower, more durable</span></div>
      </div>
    </section>`,
  },

  table: {
    desc: 'A table — anything with more than two dimensions.',
    html: () => `    <section class="slide">
      <div class="kicker">Eyebrow</div>
      <h1 class="slide-title slide-title--sm">What it comprises</h1>
      <table class="deck-table">
        <thead>
          <tr><th>Item</th><th>What it covers</th><th class="num">Weeks</th></tr>
        </thead>
        <tbody>
          <tr><td>Discovery</td><td>Interviews, systems map</td><td class="num">2</td></tr>
          <tr><td>Build</td><td>Two working modules</td><td class="num">4</td></tr>
          <tr><td>Handover</td><td>Docs, training, QA gate</td><td class="num">1</td></tr>
          <tr><td class="total">Total</td><td></td><td class="num total">7</td></tr>
        </tbody>
      </table>
      <div class="cite">Assumes a single workstream and no parallel review cycle.</div>
    </section>`,
  },

  screenshot: {
    desc: 'One centred screenshot with card chrome and a caption.',
    html: () => `    <section class="slide center-slide">
      <div class="kicker">Eyebrow</div>
      <h1 class="slide-title slide-title--sm">What you are looking at</h1>
      <div class="shot"><img src="${IMG.wide}" alt="Describe what the screen shows"></div>
      <div class="shot-cap">Caption naming the screen.</div>
    </section>`,
  },

  'diagram-shot': {
    desc: 'A full exported diagram, no card chrome, never cropped.',
    html: () => `    <section class="slide center-slide">
      <h1 class="slide-title slide-title--sm">System map</h1>
      <div class="shot shot--plain"><img src="${IMG.diagram}" alt="Architecture diagram"></div>
    </section>`,
  },

  demo: {
    desc: 'Live-demo placeholder with a thumbnail row as the fallback.',
    html: () => `    <section class="slide center-slide">
      <div class="kicker"><span class="live-dot"></span>Live demo</div>
      <h1 class="slide-title slide-title--sm">What we'll show you</h1>
      <div class="demo-frame">
        <img class="deck-logo deck-logo--sm" src="${IMG.glyph}" alt="" aria-hidden="true">
        <div class="demo-label">Live demo</div>
        <div class="demo-note">What you'll click through and why it matters.</div>
        <div class="thumb-row">
          <div class="shot shot--sm"><img src="${IMG.t1}" alt="First view of the product"></div>
          <div class="shot shot--sm"><img src="${IMG.t2}" alt="Second view of the product"></div>
        </div>
      </div>
    </section>`,
  },

  diagram: {
    desc: 'Inline themed SVG diagram (no literal colours — theme-safe).',
    html: () => `    <section class="slide">
      <div class="kicker">How it works</div>
      <h1 class="slide-title slide-title--sm">Three stages, one loop</h1>
      <svg viewBox="0 0 900 260" style="width:100%;height:auto">
        <rect class="svg-box" x="20" y="60" width="200" height="90" rx="10"/>
        <text class="svg-strong" x="120" y="100" text-anchor="middle">Capture</text>
        <text class="svg-cap" x="120" y="122" text-anchor="middle">inputs land here</text>
        <line class="svg-rule" x1="230" y1="105" x2="330" y2="105"/>
        <rect class="svg-box" x="340" y="60" width="200" height="90" rx="10"/>
        <text class="svg-strong" x="440" y="100" text-anchor="middle">Synthesise</text>
        <text class="svg-num" x="440" y="126" text-anchor="middle">3x</text>
        <line class="svg-rule" x1="550" y1="105" x2="650" y2="105"/>
        <rect class="svg-box" x="660" y="60" width="200" height="90" rx="10"/>
        <text class="svg-strong" x="760" y="100" text-anchor="middle">Publish</text>
        <text class="svg-cap" x="760" y="122" text-anchor="middle">reviewable output</text>
        <text class="svg-tick" x="20" y="200">0</text>
        <text class="svg-tick" x="860" y="200" text-anchor="end">100</text>
        <text class="svg-label" x="440" y="230" text-anchor="middle">Axis label</text>
      </svg>
      <div class="cite">Illustrative.</div>
    </section>`,
  },

  stats: {
    desc: 'A row of three to five stat tiles.',
    html: () => `    <section class="slide">
      <div class="kicker">Where it stands</div>
      <h1 class="slide-title">The numbers behind the claim</h1>
      <h2 class="slide-sub">One line saying what period these cover.</h2>
      <div class="stats-row">
        <div class="stat"><span class="stat-num">8</span><span class="stat-label">First metric, named plainly</span></div>
        <div class="stat"><span class="stat-num">3</span><span class="stat-label">Second metric</span></div>
        <div class="stat"><span class="stat-num">&lt;1h</span><span class="stat-label">Third metric</span></div>
      </div>
      <div class="footnote">Measured over the last six weeks.</div>
    </section>`,
  },

  number: {
    desc: 'The one headline number the audience should leave with. One per deck.',
    html: () => `    <section class="slide center-slide">
      <div class="kicker">The number</div>
      <div class="price-hero">42 days</div>
      <div class="price-sub">median, across the last six engagements</div>
      <div class="price-note">One sentence saying what the number means and what it excludes.</div>
    </section>`,
  },

  quote: {
    desc: 'One or two quotes with attribution. Never more than two.',
    html: () => `    <section class="slide">
      <div class="kicker">In their words</div>
      <h1 class="slide-title slide-title--sm">What the people using it said</h1>
      <div class="quote">
        "The sentence someone actually said."
        <span class="quote__cite">Role, context — date</span>
      </div>
      <div class="quote quote--accent-blue">
        "A second, contrasting voice on the same point."
        <span class="quote__cite">Role, context — date</span>
      </div>
    </section>`,
  },

  people: {
    desc: 'Team row, five-up, photo above name.',
    html: () => `    <section class="slide">
      <div class="kicker">The team</div>
      <h1 class="slide-title slide-title--sm">Who does the work</h1>
      <div class="people-grid" style="--people-cols: 5">
${person(IMG.pA, 'A. Rivera', 'Founder', 'One line.')}
${person(IMG.pB, 'B. Okafor', 'Engineering', 'One line.')}
${person(IMG.pC, 'C. Moreau', 'Design', 'One line.')}
${person(IMG.pD, 'D. Karlsen', 'Delivery', 'One line.')}
${person(IMG.pE, 'E. Lawson', 'Research', 'One line.')}
      </div>
    </section>`,
  },

  'people-duo': {
    desc: 'Two-up bios with real copy, photo beside text.',
    html: () => `    <section class="slide slide-people">
      <div class="people-wrap">
        <div class="kicker">Who's presenting</div>
        <h1 class="slide-title slide-title--sm">Built by people who've shipped this before</h1>
        <div class="people-grid people-grid--duo">
          <div class="person-card person-card--row">
            <img src="${IMG.pA}" alt="Portrait of A. Rivera">
            <div>
              <div class="p-name">A. Rivera</div>
              <div class="p-role">Founder</div>
              <div class="p-bio">Two or three lines of relevant background.</div>
            </div>
          </div>
          <div class="person-card person-card--row">
            <img src="${IMG.pB}" alt="Portrait of B. Okafor">
            <div>
              <div class="p-name">B. Okafor</div>
              <div class="p-role">Engineering</div>
              <div class="p-bio">Two or three lines of relevant background.</div>
            </div>
          </div>
        </div>
      </div>
    </section>`,
  },

  terminal: {
    desc: 'A terminal panel — a command-line product without a screenshot.',
    /* NOT a .center-slide: .center-slide sets text-align:center, which centres
       every terminal line and instantly reads as fake. Keep this one left-aligned. */
    html: () => `    <section class="slide">
      <div class="kicker">The interface</div>
      <h1 class="slide-title slide-title--sm">It runs where the work already is</h1>
      <h2 class="slide-sub">One line saying what the command does.</h2>
      <div class="term">
        <div class="term__bar">
          <span class="term__dot"></span><span class="term__dot"></span><span class="term__dot"></span>
          <span class="term__title">~/workspace</span>
        </div>
        <div class="term__body">
          <div class="term__line"><span class="term__prompt">$</span>tool status</div>
          <div class="term__line">3 items ready to sync</div>
          <div class="term__line"><span class="term__prompt">$</span><span class="term__caret"></span></div>
        </div>
      </div>
      <div class="footnote">Caption naming the command.</div>
    </section>`,
  },

  detail: {
    desc: 'The dense appendix slide — what is under the hood.',
    html: () => `    <section class="slide">
      <div class="kicker">Under the hood</div>
      <h1 class="slide-title slide-title--sm">What it actually runs on</h1>
      <div class="tech-blurb">
        <ul class="tight">
          <li>Detail</li><li>Detail</li><li>Detail</li>
          <li>Detail</li><li>Detail</li><li>Detail</li>
        </ul>
      </div>
      <div class="footnote footnote--micro">Versions as of the deck date.</div>
    </section>`,
  },

  close: {
    desc: 'The close — the ask, a CTA and one mission line.',
    html: () => `    <section class="slide close-slide center-slide" style="--photo-bg-image:url('${IMG.photo}')">
      <div class="kicker">Next step</div>
      <h1 class="slide-title">The question you want them thinking about.</h1>
      <h2 class="slide-sub">Or the concrete ask.</h2>
      <div class="cta-btn">Book the next session</div>
      <div class="mission-line">One or two sentences. No more.</div>
    </section>`,
  },
};

/* ---------------------------------------------------------------- themes */

function listThemeSlugs() {
  if (!fs.existsSync(THEMES)) return [];
  return fs.readdirSync(THEMES).filter((f) => f.endsWith('.css'))
    .map((f) => f.replace(/\.css$/, '')).sort();
}

/** One-line role-card description: first prose paragraph of themes/<slug>.md. */
function themeDescription(slug) {
  const md = path.join(THEMES, `${slug}.md`);
  if (!fs.existsSync(md)) return '(no role card)';
  for (const block of fs.readFileSync(md, 'utf8').split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || t.startsWith('#') || t.startsWith('|') || /^\*\*Mode:/.test(t)) continue;
    const line = t.replace(/\s+/g, ' ').replace(/[*`]/g, '');
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
  return '(no description)';
}

/* ------------------------------------------------------------- generation */

function buildHtml(o) {
  const sections = o.slides.map((k, i) =>
    `    <!-- ${i + 1} · ${k} -->\n${SLIDES[k].html(o)}`).join('\n\n');
  const deckClass = o.horizontal ? ' class="deck--horizontal"' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="deck-base.css">
<link rel="stylesheet" href="theme.css">
</head>
<body>
<div id="deck" data-deck-id="${esc(o.deckId)}"${deckClass}>

${sections}

</div>
<div class="side-brand">${esc(o.brand)}</div>
<div class="progress" id="progress">1 / ${o.slides.length}</div>
<div class="navhint">&larr; &uarr; &rarr; &darr; to navigate</div>
<script src="deck-nav.js"></script>
</body>
</html>
`;
}

function buildManifest(o) {
  return `---
status: draft
owner: ${o.owner}
created: ${o.dateIso}
access: team
---

# ${o.title}

| Field | Value |
|---|---|
| Deck id | \`${o.deckId}\` |
| Theme | \`${o.theme}\` |
| Orientation | ${o.horizontal ? 'horizontal' : 'vertical'} |
| Slides | ${o.slides.length} |
| Entry point | \`deck.html\` (open from \`file://\`) |

## Slide order

${o.slides.map((k, i) => `${i + 1}. \`${k}\` — ${SLIDES[k].desc}`).join('\n')}

## Assets to replace

Every image in the scaffold is an inline \`data:image/svg+xml\` placeholder, so
the deck renders with nothing missing. Swap each one for the real asset before
this goes anywhere, and put the file in \`assets/\`.

- [ ] Cover photograph — wide and busy on the RIGHT, quiet on the left (the scrim is opaque on the left).
- [ ] Logo — SVG, or a 2x PNG. A light theme needs the dark logo variant and vice versa.
- [ ] Product screenshots — **PNG, never JPEG**, for anything with small UI text. Region-targeted capture, not a full-viewport grab.
- [ ] Portraits — square crops.
- [ ] Exported diagrams — or rebuild them as inline SVG using the \`.svg-*\` classes so they follow the theme.
- [ ] Every \`<img>\` keeps a real \`alt\`; decorative images need \`alt="" aria-hidden="true"\`.

## Revision log

| Round | Date | Change | QA result |
|---|---|---|---|
| 0 | ${o.dateIso} | scaffolded from aios-deck | not yet run |

## QA

Run the gate after every revision round and record the verdict in the table above.

\`\`\`
node ${path.join(HERE, 'qa-deck.mjs')} deck.html
node ${path.join(HERE, 'deck-pdf.mjs')} deck.html
\`\`\`
`;
}

/* -------------------------------------------------------------------- CLI */

const HELP = `new-deck ${VERSION} — scaffold an aios-deck deck folder

Usage:
  new-deck.mjs <target-dir> --theme <slug> [options]

Options:
  --theme <slug>       Theme to copy in (required). See --list-themes.
  --title "..."        Deck title: <title>, cover headline, MANIFEST heading.
  --subtitle "..."     Cover sub-copy.
  --presenter "..."    Cover brandline, e.g. "Name · Company".
  --slides <list>      Comma-separated slide types. See --list-slides.
                       Default: ${DEFAULT_SLIDES}
  --horizontal         Horizontal (side-scrolling) deck.
  --force              Overwrite an existing, non-empty target directory.
  --list-themes        Print available themes and exit.
  --list-slides        Print available slide types and exit.
  -h, --help           This message.

Writes: deck.html, deck-base.css, theme.css, deck-nav.js, assets/, MANIFEST.md
`;

function parseArgs(argv) {
  const o = {
    dir: null, theme: null, title: null, subtitle: null, presenter: null,
    slides: null, horizontal: false, force: false, listThemes: false, listSlides: false,
  };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) die(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--theme') { o.theme = need(i, a); i++; }
    else if (a === '--title') { o.title = need(i, a); i++; }
    else if (a === '--subtitle') { o.subtitle = need(i, a); i++; }
    else if (a === '--presenter') { o.presenter = need(i, a); i++; }
    else if (a === '--slides') { o.slides = need(i, a); i++; }
    else if (a === '--horizontal') o.horizontal = true;
    else if (a === '--force') o.force = true;
    else if (a === '--list-themes') o.listThemes = true;
    else if (a === '--list-slides') o.listSlides = true;
    else if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
    else if (a.startsWith('-')) die(`unknown flag ${a}`);
    else if (!o.dir) o.dir = a;
    else die(`unexpected argument ${a}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));

  if (o.listThemes) {
    const slugs = listThemeSlugs();
    if (!slugs.length) die(`no themes found in ${THEMES}`);
    const w = Math.max(...slugs.map((s) => s.length));
    process.stdout.write(`Themes (${THEMES}):\n\n`);
    for (const s of slugs) process.stdout.write(`  ${s.padEnd(w)}  ${themeDescription(s)}\n`);
    process.exit(0);
  }

  if (o.listSlides) {
    const keys = Object.keys(SLIDES);
    const w = Math.max(...keys.map((s) => s.length));
    process.stdout.write('Slide types (see reference/slide-catalog.md):\n\n');
    for (const k of keys) process.stdout.write(`  ${k.padEnd(w)}  ${SLIDES[k].desc}\n`);
    process.stdout.write(`\nDefault --slides: ${DEFAULT_SLIDES}\n`);
    process.exit(0);
  }

  if (!o.dir) die('no target directory given (try --help)');
  if (!o.theme) die('--theme is required (try --list-themes)');

  const themeCss = path.join(THEMES, `${o.theme}.css`);
  if (!fs.existsSync(themeCss)) {
    const slugs = listThemeSlugs();
    die(`theme "${o.theme}" not found at ${themeCss}\n  available: ${slugs.length ? slugs.join(', ') : '(none)'}`);
  }
  const baseCss = path.join(ASSETS, 'deck-base.css');
  const navJs = path.join(ASSETS, 'deck-nav.js');
  for (const f of [baseCss, navJs]) if (!fs.existsSync(f)) die(`missing skill asset: ${f}`);

  const slideKeys = (o.slides || DEFAULT_SLIDES).split(',').map((s) => s.trim()).filter(Boolean);
  if (!slideKeys.length) die('--slides resolved to an empty list');
  const bad = slideKeys.filter((k) => !SLIDES[k]);
  if (bad.length) die(`unknown slide type(s): ${bad.join(', ')}\n  available: ${Object.keys(SLIDES).join(', ')}`);

  const target = path.resolve(o.dir);
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) die(`target exists and is not a directory: ${target}`);
    if (fs.readdirSync(target).length && !o.force) die(`target directory is not empty: ${target}\n  pass --force to overwrite`);
  }

  const now = new Date();
  const dateIso = now.toISOString().slice(0, 10);
  const title = o.title || 'Untitled deck';
  const ctx = {
    title,
    subtitle: o.subtitle || 'One sentence of sub-copy. State the outcome, not the process.',
    presenter: o.presenter || 'Presenter name · Company',
    dateHuman: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    dateIso,
    deckId: path.basename(target),
    brand: title.length > 28 ? `${title.slice(0, 27)}…` : title,
    theme: o.theme,
    horizontal: o.horizontal,
    slides: slideKeys,
    owner: process.env.USER || process.env.LOGNAME || 'unknown',
  };

  try {
    fs.mkdirSync(path.join(target, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(target, 'deck.html'), buildHtml(ctx));
    fs.copyFileSync(baseCss, path.join(target, 'deck-base.css'));
    fs.copyFileSync(themeCss, path.join(target, 'theme.css'));
    fs.copyFileSync(navJs, path.join(target, 'deck-nav.js'));
    fs.writeFileSync(path.join(target, 'assets', '.gitkeep'), '');
    fs.writeFileSync(path.join(target, 'MANIFEST.md'), buildManifest(ctx));
  } catch (e) {
    die(`could not write the deck: ${e.message}`);
  }

  const rel = path.relative(process.cwd(), target) || '.';
  process.stdout.write([
    `new-deck ${VERSION} — scaffolded ${ctx.slides.length} slide(s), theme "${o.theme}"`,
    `  ${target}`,
    '',
    '  deck.html      the deck (open it from file://)',
    '  deck-base.css  component library (copied)',
    '  theme.css      brand tokens (copied)',
    '  deck-nav.js    arrow-key nav + progress HUD (copied)',
    '  assets/        put real images here',
    '  MANIFEST.md    revision log + assets-to-replace checklist',
    '',
    'Next:',
    `  node ${path.join(HERE, 'qa-deck.mjs')} ${path.join(rel, 'deck.html')}`,
    '',
  ].join('\n'));
  process.exit(0);
}

main();
