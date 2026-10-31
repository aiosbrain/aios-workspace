/**
 * editorial-slides.mjs: the starter slides new-deck.mjs emits by default.
 *
 * Markup is reference/slide-catalog.md's "Editorial layer" section, verbatim,
 * and styles come from assets/editorial.css (the `ed-` classes). Placeholder
 * copy is sized so a fresh deck passes qa-deck.mjs check (c) at 1280x720 and
 * 1440x810 before an author touches it.
 *
 * The classic (deck-base.css only) slides stay in new-deck.mjs behind --classic.
 */

/* Line icons. Stroke and fill come from .ed-icon svg in editorial.css, so these
   carry no color and follow the theme. */
export const ICONS = {
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>',
  lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  doc: '<path d="M6 3h9l3 3v15H6z"/><path d="M9 12h6M9 16h6"/>',
};
export const icon = (name) => `<div class="ed-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg></div>`;

/** Extra placeholder artwork the editorial slides need on top of new-deck's IMG set. */
export function editorialImages(dataSvg) {
  /* A neutral wordmark block. Dark grey on purpose: .ed-logos--on-photo
     inverts it to white over a photograph, .ed-logos--mono greys it on paper. */
  const wordmark = (w) => dataSvg(`
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="24" viewBox="0 0 ${w} 24">
  <rect x="0" y="2" width="20" height="20" rx="5" fill="#4b5058"/>
  <rect x="28" y="7" width="${w - 28}" height="10" rx="5" fill="#4b5058"/>
</svg>`);
  /* A still frame for the video component: soft shapes, no people. */
  const still = (hue) => dataSvg(`
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#2b2f3a"/><stop offset="1" stop-color="${hue}"/>
  </linearGradient></defs>
  <rect width="800" height="500" fill="url(#g)"/>
  <rect x="70" y="70" width="420" height="300" rx="14" fill="#ffffff" opacity="0.1"/>
  <rect x="100" y="110" width="240" height="14" rx="7" fill="#ffffff" opacity="0.35"/>
  <rect x="100" y="140" width="320" height="10" rx="5" fill="#ffffff" opacity="0.2"/>
  <rect x="100" y="162" width="280" height="10" rx="5" fill="#ffffff" opacity="0.2"/>
  <circle cx="640" cy="330" r="90" fill="#ffffff" opacity="0.08"/>
  <text x="770" y="40" text-anchor="end" font-family="monospace" font-size="18" fill="#ffffff" opacity="0.4">PLACEHOLDER STILL</text>
</svg>`);
  return {
    logos: [wordmark(96), wordmark(120), wordmark(84), wordmark(108)],
    stills: [still('#3d4a5e'), still('#4a4054'), still('#2f4f4a')],
  };
}

const logoRow = (logos, cls) => `<div class="ed-logos ${cls}">
${logos.map((src, i) => `          <img alt="Client logo placeholder ${i + 1}" src="${src}">`).join('\n')}
          <span class="ed-logo-note">Note on the row</span>
        </div>`;

/**
 * Build the editorial slide table.
 * @param {{ esc: (s: string) => string, IMG: Record<string, any>, ED: ReturnType<typeof editorialImages> }} h
 */
export function editorialSlides({ esc, IMG, ED }) {
  return {
    cover: {
      desc: 'Photo cover: lockup on top, centered headline, logo row at the foot.',
      html: (c) => `    <section class="slide ed-photo ed-cover" style="--photo-bg-image:url('${IMG.photo}')">
      <div class="ed-lockup">
        <img alt="Company logo" src="${IMG.logo}">
      </div>
      <div class="ed-cover-mid">
        <h1 class="ed-h1 ed-h1--lg">${esc(c.title)}</h1>
        <p class="ed-lede">${esc(c.subtitle)}</p>
        <p class="ed-small">${esc(c.presenter)} · ${esc(c.dateHuman)}</p>
      </div>
      <div class="ed-cover-foot">
        <p class="ed-small">Clients and partners</p>
        ${logoRow(ED.logos, 'ed-logos--on-photo')}
      </div>
    </section>`,
    },

    statement: {
      desc: 'One large sentence and one line of lede. The thesis or an act break.',
      html: () => `    <section class="slide">
      <div class="ed-stack">
        <h1 class="ed-h1 ed-h1--lg">One sentence that earns the whole slide.</h1>
        <p class="ed-lede">At most one line of qualification. Usually none.</p>
      </div>
    </section>`,
    },

    content: {
      desc: 'The workhorse: heading, lede, a short list of large points.',
      html: () => `    <section class="slide">
      <div class="ed-split ed-split--narrow">
        <div class="ed-stack">
          <h1 class="ed-h1">The claim this slide proves</h1>
          <p class="ed-lede">The one-line version of the argument.</p>
        </div>
        <ul class="ed-list">
          <li><strong>Named thing.</strong> What it is and why it matters here.</li>
          <li><strong>Named thing.</strong> What it is and why it matters here.</li>
          <li><strong>Named thing.</strong> What it is and why it matters here.</li>
          <li><strong>Named thing.</strong> What it is and why it matters here.</li>
        </ul>
      </div>
    </section>`,
    },

    quote: {
      desc: 'What we heard: a quote with portrait beside four short cards.',
      html: () => `    <section class="slide">
      <div class="ed-split" style="--ed-split-cols: 0.9fr 1.15fr">
        <div class="ed-stack">
          <p class="ed-quote">"The sentence someone actually said, in their words."</p>
          <div class="ed-who">
            <img class="ed-portrait" alt="Portrait of A. Rivera" src="${IMG.pA}">
            <div>
              <p class="ed-body ed-strong">A. Rivera</p>
              <p class="ed-small">Role, Company</p>
            </div>
          </div>
        </div>
        <div class="ed-grid2">
          <div class="ed-card ed-card--voice-a">
            ${icon('shield')}
            <h3 class="ed-h3">First need</h3>
            <p class="ed-body">One sentence on what they asked for.</p>
          </div>
          <div class="ed-card ed-card--voice-b">
            ${icon('spark')}
            <h3 class="ed-h3">Second need</h3>
            <p class="ed-body">One sentence on what they asked for.</p>
          </div>
          <div class="ed-card">
            ${icon('lock')}
            <h3 class="ed-h3">Third need</h3>
            <p class="ed-body">One sentence on what they asked for.</p>
          </div>
          <div class="ed-card">
            ${icon('chart')}
            <h3 class="ed-h3">Fourth need</h3>
            <p class="ed-body">One sentence on what they asked for.</p>
          </div>
        </div>
      </div>
    </section>`,
    },

    'two-voice': {
      desc: 'Who does what: a voice-A card, a voice-B card, one feature number.',
      html: () => `    <section class="slide">
      <div class="ed-head">
        <h1 class="ed-h1">One side does this. The other does that.</h1>
      </div>
      <div class="ed-grid3" style="--ed-grid-cols: 1fr 1fr 0.85fr">
        <div class="ed-card ed-card--voice-a">
          <span class="ed-pill ed-pill--a">Voice A</span>
          <h3 class="ed-h3">What A owns</h3>
          <ul class="ed-list">
            <li>First responsibility</li>
            <li>Second responsibility</li>
            <li>Third responsibility</li>
          </ul>
        </div>
        <div class="ed-card ed-card--voice-b">
          <span class="ed-pill ed-pill--b">Voice B</span>
          <h3 class="ed-h3">What B handles</h3>
          <ul class="ed-list">
            <li>First responsibility</li>
            <li>Second responsibility</li>
            <li>Third responsibility</li>
          </ul>
        </div>
        <div class="ed-card ed-card--feature ed-card--center">
          <div class="ed-num">00</div>
          <h3 class="ed-h3">the number that proves it</h3>
          <p class="ed-body">One sentence saying why that number matters.</p>
        </div>
      </div>
    </section>`,
    },

    cards: {
      desc: 'Four peer cards with icons, in a 2x2 beside the heading.',
      html: () => `    <section class="slide">
      <div class="ed-split ed-split--narrow">
        <div class="ed-stack">
          <h1 class="ed-h1">Four things, one grid</h1>
          <p class="ed-lede">Peers, none recommended over another.</p>
        </div>
        <div class="ed-grid2">
          <div class="ed-card">${icon('shield')}<h3 class="ed-h3">Principle one</h3><p class="ed-body">One or two sentences, not a list.</p></div>
          <div class="ed-card">${icon('pin')}<h3 class="ed-h3">Principle two</h3><p class="ed-body">One or two sentences, not a list.</p></div>
          <div class="ed-card">${icon('doc')}<h3 class="ed-h3">Principle three</h3><p class="ed-body">One or two sentences, not a list.</p></div>
          <div class="ed-card">${icon('lock')}<h3 class="ed-h3">Principle four</h3><p class="ed-body">One or two sentences, not a list.</p></div>
        </div>
      </div>
    </section>`,
    },

    steps: {
      desc: 'Numbered steps beside a screenshot. A real sequence only.',
      html: () => `    <section class="slide">
      <div class="ed-split ed-split--visual">
        <div class="ed-stack">
          <h1 class="ed-h1">How it works, in order</h1>
          <ol class="ed-steps">
            <li><strong>First move</strong>What happens, in one line.</li>
            <li><strong>Second move</strong>What happens, in one line.</li>
            <li><strong>Third move</strong>What happens, in one line.</li>
          </ol>
        </div>
        <img class="ed-shot" alt="Product screen placeholder" src="${IMG.hero}">
      </div>
    </section>`,
    },

    timeline: {
      desc: 'A timeline track: four dated steps, one milestone.',
      html: () => `    <section class="slide">
      <div class="ed-head">
        <h1 class="ed-h1">From start to handover</h1>
        <p class="ed-lede">One line on what is true at the end.</p>
      </div>
      <div class="ed-track" style="--ed-track-n: 4">
        <div class="ed-step"><span class="ed-when">When</span><h3 class="ed-h3">Phase one</h3><p class="ed-body">What happens, in one line.</p></div>
        <div class="ed-step ed-step--b"><span class="ed-when">When</span><h3 class="ed-h3">Phase two</h3><p class="ed-body">What happens, in one line.</p></div>
        <div class="ed-step ed-step--milestone"><span class="ed-when">When</span><h3 class="ed-h3">The milestone</h3><p class="ed-body">What the audience sees here.</p></div>
        <div class="ed-step ed-step--a"><span class="ed-when">When</span><h3 class="ed-h3">Phase three</h3><p class="ed-body">What is true at the end.</p></div>
      </div>
    </section>`,
    },

    numbers: {
      desc: 'Targets: a bar chart card beside two big-number cards.',
      html: () => `    <section class="slide">
      <div class="ed-head">
        <h1 class="ed-h1">Measures of success</h1>
      </div>
      <div class="ed-split ed-split--wide ed-split--stretch">
        <div class="ed-card ed-card--outline ed-card--center">
          <svg class="ed-svg" viewBox="0 0 540 200" role="img" aria-label="Placeholder chart: two measures, each shown today and at target.">
            <text class="ed-svg-t1" x="0" y="20">First measure</text>
            <rect class="ed-svg-bar" x="0" y="32" width="520" height="24" rx="6"/>
            <rect class="ed-svg-bar--target" x="0" y="60" width="330" height="24" rx="6"/>
            <text class="ed-svg-t-on" x="12" y="78">Target</text>
            <text class="ed-svg-t1" x="0" y="126">Second measure</text>
            <rect class="ed-svg-bar" x="0" y="138" width="520" height="24" rx="6"/>
            <rect class="ed-svg-bar--target" x="0" y="166" width="410" height="24" rx="6"/>
            <text class="ed-svg-t-on" x="12" y="184">Target</text>
          </svg>
          <div class="ed-row"><span class="ed-pill">Today</span><span class="ed-pill ed-pill--a">Target</span></div>
        </div>
        <div class="ed-stack ed-snug">
          <div class="ed-card ed-card--voice-a"><div class="ed-num">00<small>unit</small></div><p class="ed-body">What this number counts.</p></div>
          <div class="ed-card ed-card--voice-b"><div class="ed-num">00<small>unit</small></div><p class="ed-body">What this number counts.</p></div>
        </div>
      </div>
    </section>`,
    },

    diagram: {
      desc: 'An inline SVG flow using the ed-svg classes (theme-safe, no literal colors).',
      html: () => `    <section class="slide">
      <div class="ed-head">
        <h1 class="ed-h1 ed-h1--wide">Three stages, one record</h1>
        <div class="ed-row"><span class="ed-pill ed-pill--a">Voice A owns it</span><span class="ed-pill ed-pill--b">Voice B assists</span><span class="ed-pill">Dashed: a gate</span></div>
      </div>
      <svg class="ed-svg" viewBox="0 0 1000 150" role="img" aria-label="Four placeholder stages: one owned by voice A, one assisted by voice B, a gate, then a final stage owned by voice A.">
        <rect class="ed-svg-voice-a" x="0" y="30" width="220" height="90" rx="12"/>
        <text class="ed-svg-t1" x="18" y="68">Stage one</text>
        <text class="ed-svg-t2" x="18" y="94">who owns it</text>
        <line class="ed-svg-line" x1="220" y1="75" x2="260" y2="75"/>
        <rect class="ed-svg-voice-b" x="260" y="30" width="220" height="90" rx="12"/>
        <text class="ed-svg-t1" x="278" y="68">Stage two</text>
        <text class="ed-svg-t2" x="278" y="94">who owns it</text>
        <line class="ed-svg-line" x1="480" y1="75" x2="520" y2="75"/>
        <rect class="ed-svg-gate" x="520" y="30" width="220" height="90" rx="12"/>
        <text class="ed-svg-t1" x="538" y="68">A gate?</text>
        <text class="ed-svg-t2" x="538" y="94">the check it runs</text>
        <line class="ed-svg-line" x1="740" y1="75" x2="780" y2="75"/>
        <rect class="ed-svg-voice-a" x="780" y="30" width="220" height="90" rx="12"/>
        <text class="ed-svg-t1" x="798" y="68">Stage three</text>
        <text class="ed-svg-t2" x="798" y="94">who owns it</text>
      </svg>
      <p class="ed-body ed-after">One sentence on what the diagram means for the reader.</p>
    </section>`,
    },

    video: {
      desc: 'Recorded walkthroughs: three video frames under a heading.',
      html: () => `    <section class="slide">
      <div class="ed-head">
        <h1 class="ed-h1">Watch it before the call</h1>
        <p class="ed-lede">Three short recordings, one per question.</p>
      </div>
      <div class="ed-grid3 ed-snug">
${ED.stills.map((src, i) => `        <div class="ed-video"><img class="ed-video__img" alt="Still from walkthrough ${i + 1}" src="${src}"><div class="ed-video__bar"><span class="ed-video__play"></span><span class="ed-video__title">Walkthrough ${i + 1}</span><span class="ed-video__len">4 min</span></div></div>`).join('\n')}
      </div>
    </section>`,
    },

    options: {
      desc: 'Options and investment: a feature card, an outline card, a plain card.',
      html: () => `    <section class="slide">
      <div class="ed-head ed-head--row">
        <h1 class="ed-h1">Options and investment</h1>
        <span class="ed-pill ed-pill--draft">Draft figures</span>
      </div>
      <div class="ed-grid3">
        <div class="ed-card ed-card--feature">
          <span class="ed-pill">Recommended</span>
          <h3 class="ed-h3">Option A</h3>
          <div class="ed-num">00,000</div>
          <p class="ed-body">Scope and length. The one-line case for it.</p>
        </div>
        <div class="ed-card ed-card--outline">
          <span class="ed-pill">Go further</span>
          <h3 class="ed-h3">Option B</h3>
          <div class="ed-num">00,000</div>
          <p class="ed-body">Scope and length. What the extra buys.</p>
        </div>
        <div class="ed-card">
          <span class="ed-pill">Ongoing</span>
          <h3 class="ed-h3">Support</h3>
          <div class="ed-num">000<small>/period</small></div>
          <p class="ed-body">What the ongoing fee covers.</p>
        </div>
      </div>
    </section>`,
    },

    placeholder: {
      desc: 'A visibly unfinished section, for someone else to complete.',
      html: () => `    <section class="slide">
      <div class="ed-split ed-split--even">
        <h1 class="ed-h1">Section title</h1>
        <div class="ed-placeholder">
          <span class="ed-pill ed-pill--draft">For a named owner to complete</span>
          <p class="ed-lede">What this slide needs to say, and who will write it.</p>
          <p class="ed-small">Move or delete this slide before the deck goes out.</p>
        </div>
      </div>
    </section>`,
    },

    team: {
      desc: 'Who you will work with: three large portraits with one-line bios.',
      html: () => `    <section class="slide">
      <div class="ed-head"><h1 class="ed-h1">Who you'll work with</h1></div>
      <div class="ed-grid3">
${[[IMG.pA, 'A. Rivera', 'Lead'], [IMG.pB, 'B. Okafor', 'Engineering'], [IMG.pC, 'C. Moreau', 'Design']].map(([src, name, role]) => `        <div class="ed-stack ed-stack--tight">
          <img class="ed-portrait ed-portrait--lg" alt="Portrait of ${name}" src="${src}">
          <h3 class="ed-h3">${name}</h3>
          <span class="ed-pill">${role}</span>
          <p class="ed-body">One or two lines of relevant background.</p>
        </div>`).join('\n')}
      </div>
    </section>`,
    },

    close: {
      desc: 'Photo close: centered ask, one CTA, the lockup at the foot.',
      html: (c) => `    <section class="slide ed-photo ed-cover" style="--photo-bg-image:url('${IMG.photo}')">
      <div></div>
      <div class="ed-cover-mid">
        <h1 class="ed-h1 ed-h1--lg">The concrete ask</h1>
        <p class="ed-lede">One line on what happens next and when.</p>
        <a class="ed-cta" href="mailto:hello@example.com">Book the next call</a>
      </div>
      <div class="ed-lockup">
        <img alt="${esc(c.brand)} logo" src="${IMG.logo}">
      </div>
    </section>`,
    },
  };
}

export const EDITORIAL_DEFAULT_SLIDES = 'cover,statement,content,two-voice,steps,timeline,options,team,close';
