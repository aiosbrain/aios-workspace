#!/usr/bin/env node
/**
 * qa-deck.mjs — QA gate for aios-deck single-file HTML decks.
 *
 * Usage: node qa-deck.mjs <deck.html> [--out <dir>] [--json] [--no-shots] [--strict]
 *                                     [--base-css <path>]
 *
 * Checks: (a) theme-token contract completeness, (b) hardcoded colours outside :root,
 * (c) per-slide overflow at 1280x720 + 1440x810, (d) progress counter vs real slide
 * count, (e) <img> alt text, (f) total asset weight.
 *
 * Zero dependencies beyond node: builtins. The browser-dependent checks (c) and the
 * per-slide screenshots use an OPTIONAL dynamic import of playwright / playwright-core /
 * puppeteer. If none resolve, those checks SKIP loudly and the static checks still gate.
 *
 * Exit: 0 = no FAILs, 1 = at least one FAIL, 2 = usage/IO error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOL = 2; // px tolerance for overflow measurement
const VIEWPORTS = [{ w: 1280, h: 720 }, { w: 1440, h: 810 }];
const SHOT_VIEWPORT = { w: 1440, h: 810 };
const SOFT_ASSET_BUDGET = 8 * 1024 * 1024;
const HARD_ASSET_BUDGET = 25 * 1024 * 1024;
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* ------------------------------------------------------------------ utils */

const human = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB`
  : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

function lineIndex(text) {
  const offs = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') offs.push(i + 1);
  return offs;
}
function lineAt(offs, idx) {
  let lo = 0, hi = offs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= idx) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}
const isExternal = (u) => !u || /^(?:data:|https?:|mailto:|tel:|javascript:|#|\/\/)/i.test(u.trim());

/* ------------------------------------------------------- report accumulator */

const report = {
  tool: 'qa-deck', version: VERSION, deck: null, generatedAt: new Date().toISOString(),
  browser: 'unavailable', strict: false, checks: [], findings: [],
  slides: {}, assets: {}, screenshots: [], counts: { fail: 0, warn: 0 }, verdict: 'FAIL',
};
const CHECK_NAMES = {
  a: 'theme-token contract', b: 'hardcoded colour outside :root', c: 'slide overflow',
  d: 'progress counter', e: 'img alt text', f: 'asset weight',
};
/** severity: 'fail' | 'warn' | 'note' ('note' is an explicitly allowlisted warn — never promoted). */
function finding(check, severity, message, extra = {}) {
  report.findings.push({ check, severity, message, ...extra });
}
function setCheck(id, status, summary) {
  report.checks.push({ id, name: CHECK_NAMES[id], status, summary });
}

/* --------------------------------------------------------------- CSS model */

/**
 * Walk CSS tracking brace depth so we know the enclosing selector of every
 * declaration. Comments and strings are skipped. Returns declarations with the
 * absolute char index into the source text (for line mapping).
 */
function parseCss(css) {
  const decls = []; const stack = [];
  let buf = '', bufStart = 0, i = 0;
  const flush = (end) => {
    const raw = buf.trim();
    buf = '';
    if (!raw) return;
    const c = raw.indexOf(':');
    if (c < 0) return;
    decls.push({
      prop: raw.slice(0, c).trim(), value: raw.slice(c + 1).trim(), raw,
      index: bufStart, end, selector: stack.length ? stack[stack.length - 1] : '',
      stack: stack.slice(),
    });
  };
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 2; continue; }
    if (ch === '"' || ch === "'") {
      const q = ch; let j = i + 1;
      while (j < css.length && css[j] !== q) { if (css[j] === '\\') j++; j++; }
      buf += css.slice(i, Math.min(j + 1, css.length)); i = j + 1; continue;
    }
    if (ch === '{') { stack.push(buf.trim().replace(/\s+/g, ' ')); buf = ''; i++; continue; }
    if (ch === '}') { flush(i); stack.pop(); i++; continue; }
    if (ch === ';') { flush(i); i++; continue; }
    if (!buf) bufStart = i;
    buf += ch; i++;
  }
  flush(css.length);
  return decls;
}
const isRootSelector = (sel) =>
  sel.split(',').some((s) => /(^|\s|>)?:root\b/.test(s.trim()) && !/\s\S/.test(s.trim().replace(/^:root/, '')));

/** Collect <style> blocks + linked local stylesheets, with line offsets back to source. */
function resolveCss(deckPath, html, htmlLines) {
  const sources = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const contentStart = m.index + m[0].indexOf('>') + 1;
    sources.push({ label: path.basename(deckPath), file: deckPath, text: m[1], lineOffset: lineAt(htmlLines, contentStart) - 1, kind: 'inline' });
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    if (!rel.split(/\s+/).includes('stylesheet')) continue;
    const href = attr(tag, 'href');
    if (isExternal(href)) continue;
    const abs = path.resolve(path.dirname(deckPath), href.split('?')[0]);
    if (!fs.existsSync(abs)) { finding('a', 'warn', `linked stylesheet not found: ${href}`, { file: deckPath }); continue; }
    sources.push({ label: path.relative(path.dirname(deckPath), abs), file: abs, text: fs.readFileSync(abs, 'utf8'), lineOffset: 0, kind: 'link' });
  }
  for (const s of sources) { s.lines = lineIndex(s.text); s.decls = parseCss(s.text); }
  return sources;
}

/* ----------------------------------------------- (a) theme-token contract */

function locateBaseCss(deckPath, html, argBase) {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = attr(m[0], 'href');
    if (href && !isExternal(href) && path.basename(href.split('?')[0]) === 'deck-base.css') {
      const abs = path.resolve(path.dirname(deckPath), href.split('?')[0]);
      if (fs.existsSync(abs)) return abs;
    }
  }
  if (argBase) { const abs = path.resolve(argBase); if (fs.existsSync(abs)) return abs; }
  const sibling = path.resolve(HERE, '../assets/deck-base.css');
  return fs.existsSync(sibling) ? sibling : null;
}

function parseTokenContract(baseCssText) {
  const begin = baseCssText.indexOf('/* @token-contract:begin */');
  const end = baseCssText.indexOf('/* @token-contract:end */');
  if (begin >= 0 && end > begin) {
    const required = [], optional = [];
    for (const line of baseCssText.slice(begin, end).split('\n')) {
      const m = /^\s*(--[a-z0-9-]+)\s+(required|optional)\b/.exec(line);
      if (m) (m[2] === 'required' ? required : optional).push(m[1]);
    }
    return { required, optional, source: 'marker-block' };
  }
  // Fallback: every var(--x) the base CSS consumes is treated as required.
  const used = new Set();
  for (const m of baseCssText.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) used.add(m[1]);
  return { required: [...used], optional: [], source: 'var()-scan' };
}

function checkTokens(sources, baseCssPath, strict) {
  if (!baseCssPath) {
    finding('a', 'warn', 'deck-base.css not found (no link, no --base-css, no ../assets/deck-base.css) — token contract unverified');
    setCheck('a', 'warn', 'contract source missing'); return;
  }
  const contract = parseTokenContract(fs.readFileSync(baseCssPath, 'utf8'));
  const defined = new Map(); // token -> Set(source labels)
  for (const s of sources) {
    for (const d of s.decls) {
      if (!d.prop.startsWith('--') || !isRootSelector(d.selector)) continue;
      if (!defined.has(d.prop)) defined.set(d.prop, new Set());
      defined.get(d.prop).add(s.label);
    }
  }
  const baseLabel = sources.find((s) => s.file === baseCssPath)?.label;
  const missing = [], baseOnly = [], missingOptional = [];
  for (const t of contract.required) {
    const where = defined.get(t);
    if (!where) missing.push(t);
    else if (baseLabel && where.size === 1 && where.has(baseLabel)) baseOnly.push(t);
  }
  for (const t of contract.optional) if (!defined.has(t)) missingOptional.push(t);

  for (const t of missing) finding('a', 'fail', `required theme token ${t} is not defined in any :root rule — the deck will render unstyled for that token`, { file: baseCssPath, detail: `contract source: ${contract.source}` });
  for (const t of baseOnly) finding('a', 'warn', `required token ${t} is only defined by deck-base.css — the theme should own it`);
  for (const t of missingOptional) finding('a', 'warn', `optional theme token ${t} is not defined`);

  /* Shape checks. Presence is not enough for tokens whose VALUE has a required
     form — a wrong shape is defined, so the missing-token check passes, and the
     component silently renders nothing. --photo-scrim-rgb is the documented
     worst offender: it is consumed as `rgba(var(--photo-scrim-rgb), 0.88)`, so
     it must be a bare comma-separated triplet. Write `#060608` there and every
     photo slide in the deck loses its scrim with no error anywhere. */
  const shapeBad = [];
  for (const s of sources) {
    for (const d of s.decls) {
      if (!isRootSelector(d.selector)) continue;
      const v = d.value.trim().replace(/!important\s*$/i, '').trim();
      if (d.prop === '--photo-scrim-rgb' && !/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(v)) {
        shapeBad.push({ prop: d.prop, v, label: s.label,
          why: 'must be a bare RGB triplet like `6, 6, 8` — it is consumed inside rgba(), so a hex or a colour name silently breaks every photo slide' });
      }
      if ((d.prop === '--weight-display' || d.prop === '--weight-heading') && !/^(?:[1-9]00|normal|bold)$/.test(v)) {
        shapeBad.push({ prop: d.prop, v, label: s.label, why: 'must be a CSS font-weight (100-900, normal, bold)' });
      }
      if (d.prop === '--accent-bar-height' && !/^\d+(?:\.\d+)?(?:px|rem|em|vh|vw)$/.test(v)) {
        shapeBad.push({ prop: d.prop, v, label: s.label, why: 'must be a CSS length with a unit' });
      }
    }
  }
  for (const b of shapeBad) finding('a', 'fail', `theme token ${b.prop} has the wrong shape (\`${b.v}\`) — ${b.why}`, { file: b.label });

  const status = (missing.length || shapeBad.length) ? 'fail'
    : (baseOnly.length + missingOptional.length) ? (strict ? 'fail' : 'warn') : 'pass';
  setCheck('a', status, `${contract.required.length} required / ${contract.optional.length} optional tokens (${contract.source}); ${missing.length} missing, ${shapeBad.length} malformed`);
}

/* --------------------------------------- (b) hardcoded colour outside :root */

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const FN_RE = /\b(?:rgba?|hsla?)\(\s*[^)]*\)/gi;
const NEUTRAL_RGBA = /\brgba\(\s*(?:0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)\s*[,/]/i;

/* `rgba(var(--photo-scrim-rgb), 0.88)` is the OPPOSITE of a hardcoded colour —
   it is the documented way to consume the one token in the contract that is an
   RGB triplet rather than a colour. Any rgb()/hsl() whose arguments are a
   var() reference is therefore tokenized, not literal. Stripping these before
   the literal scan keeps every photo slide in the system from failing check (b). */
const FN_TOKENIZED_RE = /\b(?:rgba?|hsla?)\(\s*var\(\s*--[a-z0-9-]+\s*\)[^)]*\)/gi;

function colourLiterals(value) {
  const scanned = value.replace(FN_TOKENIZED_RE, '');
  const hits = [...scanned.matchAll(HEX_RE), ...scanned.matchAll(FN_RE)].map((m) => m[0]);
  return [...new Set(hits)];
}
function checkColours(sources, html, htmlLines, deckPath, strict) {
  let fails = 0, warns = 0;
  const record = (sev, where, line, decl, lit) => {
    if (sev === 'fail') fails++; else warns++;
    finding('b', sev, `hardcoded colour ${lit} outside :root — use a var(--…) token`, { file: where, line, detail: decl });
  };
  for (const s of sources) {
    for (const d of s.decls) {
      if (isRootSelector(d.selector)) continue;
      if (/url\(\s*['"]?data:image\/svg\+xml/i.test(d.value)) continue; // allowlisted: inline SVG data URI
      const lits = colourLiterals(d.value);
      if (!lits.length) continue;
      const line = s.lineOffset + lineAt(s.lines, d.index);
      const shadow = /(^|-)(text-shadow|box-shadow)$/i.test(d.prop);
      for (const lit of lits) {
        // Allowlist: neutral rgba() in shadows is idiomatic, not a theming bug.
        if (shadow && NEUTRAL_RGBA.test(lit)) {
          warns++;
          finding('b', 'note', `neutral shadow colour ${lit} in ${d.prop} (allowlisted)`, { file: s.label, line, detail: d.raw });
          continue;
        }
        record(strict ? 'fail' : 'warn', s.label, line, d.raw, lit);
      }
    }
  }
  for (const m of html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)) {
    const lits = colourLiterals(m[1]);
    if (!lits.length || /url\(\s*['"]?data:image\/svg\+xml/i.test(m[1])) continue;
    const line = lineAt(htmlLines, m.index);
    for (const lit of lits) record(strict ? 'fail' : 'warn', path.basename(deckPath), line, `style="${m[1]}"`, lit);
  }
  setCheck('b', fails ? 'fail' : warns ? 'warn' : 'pass', `${fails} fail / ${warns} warn colour literal(s) outside :root`);
}

/* --------------------------------- static structure (fallback + agreement) */

function staticStructure(html) {
  const slides = [...html.matchAll(/<section\b[^>]*\bclass\s*=\s*(?:"[^"]*\bslide\b[^"]*"|'[^']*\bslide\b[^']*')[^>]*>/gi)].length;
  const pm = /<([a-z]+)\b[^>]*(?:\bid\s*=\s*"progress"|\bclass\s*=\s*"[^"]*\bprogress\b[^"]*")[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => ({
    outerHTML: m[0], hasAlt: /\balt\s*=/i.test(m[0]), alt: attr(m[0], 'alt') ?? '',
    role: attr(m[0], 'role'), ariaHidden: attr(m[0], 'aria-hidden'), src: attr(m[0], 'src'),
  }));
  return { slideCount: slides, progressText: pm ? pm[2].replace(/<[^>]*>/g, '').trim() : null, imgs };
}

/* --------------------------------------------- (d) progress counter, (e) alt */

function checkProgress(progressText, slideCount) {
  if (progressText == null) { finding('d', 'warn', 'no #progress / .progress element found'); setCheck('d', 'warn', 'counter element missing'); return; }
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(progressText);
  if (!m) { finding('d', 'warn', `progress text "${progressText}" is not of the form "N / M"`); setCheck('d', 'warn', `unparsed: "${progressText}"`); return; }
  const total = Number(m[2]);
  report.slides.progressTotal = total;
  if (total !== slideCount) {
    // The static text is what renders before nav JS runs, and what print/PDF captures.
    finding('d', 'fail', `progress counter says "${progressText}" but the deck has ${slideCount} slides (static text is what shows pre-JS and in PDF)`);
    setCheck('d', 'fail', `${total} != ${slideCount}`); return;
  }
  setCheck('d', 'pass', `${progressText} matches ${slideCount} slides`);
}

function checkAlt(imgs) {
  let bad = 0;
  for (const im of imgs) {
    const decorative = im.role === 'presentation' || im.role === 'none' || im.ariaHidden === 'true';
    const ok = im.hasAlt && (im.alt.trim() !== '' || decorative);
    if (!ok) {
      bad++;
      finding('e', 'fail', im.hasAlt
        ? `<img> has empty alt="" without role="presentation"/aria-hidden="true" (src: ${im.src || '?'})`
        : `<img> is missing an alt attribute (src: ${im.src || '?'})`, { detail: im.outerHTML.slice(0, 200) });
    }
  }
  setCheck('e', bad ? 'fail' : 'pass', `${imgs.length} image(s), ${bad} without usable alt`);
}

/* ------------------------------------------------------ (f) asset weight */

function checkAssets(deckPath, html, sources, strict) {
  const dir = path.dirname(deckPath);
  const seen = new Map();
  const add = (abs) => { if (!seen.has(abs)) { try { seen.set(abs, fs.statSync(abs).size); } catch { seen.set(abs, null); } } };
  add(deckPath);
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const u = m[1] ?? m[2];
    if (isExternal(u)) continue;
    add(path.resolve(dir, u.split(/[?#]/)[0]));
  }
  for (const s of sources) {
    // Strip CSS comments first: deck-base.css documents usage in comments
    // (e.g. `style="--photo-bg-image:url('assets/hero.jpg')"`), and counting
    // those as referenced assets reports a missing file for every example.
    const scanned = s.text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of scanned.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      const u = m[2].trim();
      if (isExternal(u)) continue;
      add(path.resolve(s.kind === 'link' ? path.dirname(s.file) : dir, u.split(/[?#]/)[0]));
    }
  }
  const entries = [...seen.entries()].map(([p, bytes]) => ({ path: path.relative(dir, p) || path.basename(p), bytes }));
  for (const e of entries) if (e.bytes === null) finding('f', 'warn', `referenced local asset missing: ${e.path}`);
  const total = entries.reduce((n, e) => n + (e.bytes || 0), 0);
  const largest = entries.filter((e) => e.bytes).sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  report.assets = { totalBytes: total, human: human(total), count: entries.length, largest: largest.map((e) => ({ ...e, human: human(e.bytes) })) };

  let status = 'pass';
  if (total > HARD_ASSET_BUDGET) {
    finding('f', strict ? 'fail' : 'warn', `total asset weight ${human(total)} exceeds the 25 MB hard budget (FAIL under --strict)`);
    status = strict ? 'fail' : 'warn';
  } else if (total > SOFT_ASSET_BUDGET) {
    finding('f', 'warn', `total asset weight ${human(total)} exceeds the 8 MB soft budget`);
    status = strict ? 'fail' : 'warn';
  }
  if (entries.some((e) => e.bytes === null) && status === 'pass') status = strict ? 'fail' : 'warn';
  setCheck('f', status, `${human(total)} across ${entries.length} file(s)`);
}

/* ------------------------------------------------------------ browser layer */

/* Resolution bases, in order. `AIOS_DECK_BROWSER_DIR` is the documented escape
   hatch: this skill deliberately adds no npm dependency, so on a machine where
   playwright/puppeteer lives in some OTHER project you point at it rather than
   installing a browser here. Note NODE_PATH does NOT work for this — ESM
   ignores it — which is why the lookup uses createRequire against each base. */
async function loadBrowser(deckPath) {
  const bases = [
    null,
    process.env.AIOS_DECK_BROWSER_DIR || null,
    process.env.AIOS_DECK_BROWSER_DIR ? path.join(process.env.AIOS_DECK_BROWSER_DIR, 'node_modules') : null,
    process.cwd(),
    path.dirname(path.resolve(deckPath)),
    path.resolve(process.execPath, '../../lib/node_modules'),
  ].filter((b, i) => i === 0 || b);
  for (const name of ['playwright', 'playwright-core', 'puppeteer']) {
    for (const base of bases) {
      try {
        let mod;
        if (base === null) mod = await import(name);
        else {
          const req = createRequire(path.join(base, '__qa-deck__.cjs'));
          mod = await import(pathToFileURL(req.resolve(name)).href);
        }
        return { name, mod: mod.default && !mod.chromium ? mod.default : mod };
      } catch { /* try next */ }
    }
  }
  return null;
}

async function openBrowser(deckPath) {
  const found = await loadBrowser(deckPath);
  if (!found) return null;
  const isPw = found.name !== 'puppeteer';
  const launcher = isPw ? found.mod.chromium : found.mod;
  const attempts = [{ headless: true }];
  if (fs.existsSync(MAC_CHROME)) attempts.push({ headless: true, executablePath: MAC_CHROME });
  for (const opts of attempts) {
    try {
      const browser = await launcher.launch(opts);
      const page = await browser.newPage();
      return {
        name: found.name, browser, page,
        setViewport: (w, h) => (isPw ? page.setViewportSize({ width: w, height: h }) : page.setViewport({ width: w, height: h })),
      };
    } catch (e) { if (opts === attempts[attempts.length - 1]) process.stderr.write(`qa-deck: browser launch failed: ${e.message}\n`); }
  }
  return null;
}

/* The functions below are serialized and executed INSIDE the page, so they legitimately
   reference browser globals that do not exist in Node. */
/* global document, getComputedStyle, requestAnimationFrame, sessionStorage */

/** Runs in-page: structural facts, so the browser path and the static path agree. */
const PAGE_STRUCTURE = () => {
  const slides = document.querySelectorAll('#deck .slide, .slide');
  const prog = document.querySelector('#progress, .progress');
  return {
    slideCount: slides.length,
    progressLive: prog ? prog.textContent.trim() : null,
    imgs: [...document.images].map((im) => ({
      outerHTML: im.outerHTML.slice(0, 200), hasAlt: im.hasAttribute('alt'), alt: im.getAttribute('alt') || '',
      role: im.getAttribute('role'), ariaHidden: im.getAttribute('aria-hidden'), src: im.getAttribute('src'),
    })),
  };
};

/** Runs in-page: overflow of slide i against its own padded content box. */
const PAGE_OVERFLOW = (arg) => {
  const { i, tol } = arg;
  const slide = document.querySelectorAll('#deck .slide, .slide')[i];
  if (!slide) return null;
  const cs = getComputedStyle(slide);
  const r = slide.getBoundingClientRect();
  const num = (v) => parseFloat(v) || 0;
  const top = r.top + num(cs.borderTopWidth) + num(cs.paddingTop);
  const bottom = r.bottom - num(cs.borderBottomWidth) - num(cs.paddingBottom);
  const left = r.left + num(cs.borderLeftWidth) + num(cs.paddingLeft);
  const right = r.right - num(cs.borderRightWidth) - num(cs.paddingRight);
  const out = {
    selfV: Math.max(0, slide.scrollHeight - slide.clientHeight),
    selfH: Math.max(0, slide.scrollWidth - slide.clientWidth),
    overV: 0, overH: 0, worstV: null, worstH: null,
  };
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== slide; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (!/^(visible)$/.test(s.overflowX) || !/^(visible)$/.test(s.overflowY)) return true;
    }
    return false;
  };
  const label = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') +
    (el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '');
  for (const el of slide.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.position === 'fixed' || s.opacity === '0') continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) continue;
    if (clipped(el)) continue;
    const dv = Math.max(b.bottom - bottom, top - b.top);
    const dh = Math.max(b.right - right, left - b.left);
    if (dv > tol && dv > out.overV) { out.overV = dv; out.worstV = label(el); }
    if (dh > tol && dh > out.overH) { out.overH = dh; out.worstH = label(el); }
  }
  out.overV = Math.max(out.overV, out.selfV > tol ? out.selfV : 0);
  out.overH = Math.max(out.overH, out.selfH > tol ? out.selfH : 0);
  return out;
};

/**
 * GOTCHA #8 — DO NOT "fix" this back to keyboard navigation.
 * Simulated arrow/PageDown key presses against a CSS scroll-snap container silently
 * no-op roughly every other press (the snap animation swallows the second event), so a
 * key-driven walk quietly measures the same slide twice and misses real overflow.
 * scrollIntoView({behavior:'instant'}) is deterministic. Keep it.
 */
/* Scroll, settle, then VERIFY the slide actually landed at the origin — and retry
   if it did not. A deck's own nav script restores the last-viewed slide from
   sessionStorage on load, and sessionStorage survives page.goto within one
   browser context. So after the first pass the deck scrolls itself away right
   after we position it, and we measure (and screenshot) a half-scrolled frame
   with two slides visible. Waiting longer does not fix a race; checking the
   result does. */
async function gotoSlide(page, i) {
  const settle = () => page.evaluate(() => new Promise((res) => {
    setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(res)), 250);
  }));
  for (let attempt = 0; attempt < 3; attempt++) {
    const landed = await page.evaluate((idx) => {
      const el = document.querySelectorAll('#deck .slide, .slide')[idx];
      if (!el) return true;
      el.scrollIntoView({ behavior: 'instant', block: 'start', inline: 'start' });
      return null;
    }, i);
    if (landed === true) return;
    await settle();
    const off = await page.evaluate((idx) => {
      const el = document.querySelectorAll('#deck .slide, .slide')[idx];
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return Math.abs(r.top) + Math.abs(r.left);
    }, i);
    if (off <= 2) return;
  }
  process.stderr.write(`qa-deck: slide ${i + 1} would not settle at the viewport origin after 3 attempts — ` +
    `measurements for it may be unreliable (does the deck have a script that moves the scroll position?)\n`);
}

/* Clear the deck's own per-deck sessionStorage so a fresh pass always starts at
   slide 1 (matches what a recipient sees opening the file for the first time). */
async function resetDeckState(page) {
  await page.evaluate(() => { try { sessionStorage.clear(); } catch { /* private mode */ } });
}

async function runBrowserChecks(bp, deckPath, outDir, wantShots) {
  const url = pathToFileURL(path.resolve(deckPath)).href;
  const { page } = bp;
  await bp.setViewport(SHOT_VIEWPORT.w, SHOT_VIEWPORT.h);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await resetDeckState(page);
  const structure = await page.evaluate(PAGE_STRUCTURE);

  let fails = 0;
  for (const vp of VIEWPORTS) {
    await bp.setViewport(vp.w, vp.h);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await resetDeckState(page);
    for (let i = 0; i < structure.slideCount; i++) {
      await gotoSlide(page, i);
      const o = await page.evaluate(PAGE_OVERFLOW, { i, tol: TOL });
      if (!o) continue;
      if (o.overV > TOL) {
        fails++;
        finding('c', 'fail', `slide ${i + 1} overflows by ${Math.round(o.overV)}px vertically at ${vp.w}x${vp.h}`, { detail: o.worstV ? `worst offender: ${o.worstV}` : 'slide scrollHeight > clientHeight' });
      }
      if (o.overH > TOL) {
        fails++;
        finding('c', 'fail', `slide ${i + 1} overflows by ${Math.round(o.overH)}px horizontally at ${vp.w}x${vp.h}`, { detail: o.worstH ? `worst offender: ${o.worstH}` : 'slide scrollWidth > clientWidth' });
      }
    }
  }
  setCheck('c', fails ? 'fail' : 'pass', `${structure.slideCount} slide(s) x ${VIEWPORTS.map((v) => `${v.w}x${v.h}`).join(', ')}; ${fails} overflow(s)`);

  if (wantShots) {
    const shotDir = path.join(outDir, 'slides');
    fs.mkdirSync(shotDir, { recursive: true });
    await bp.setViewport(SHOT_VIEWPORT.w, SHOT_VIEWPORT.h);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await resetDeckState(page);
    for (let i = 0; i < structure.slideCount; i++) {
      await gotoSlide(page, i);
      const p = path.join(shotDir, `slide-${String(i + 1).padStart(2, '0')}.png`);
      await page.screenshot({ path: p });
      report.screenshots.push(p);
    }
  }
  return structure;
}

/* ------------------------------------------------------------------- main */

function usage(msg) {
  process.stderr.write(`${msg ? `qa-deck: ${msg}\n\n` : ''}Usage: qa-deck.mjs <deck.html> [--out <dir>] [--json] [--no-shots] [--strict] [--base-css <path>]\n`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { json: false, shots: true, strict: false, out: null, baseCss: null, deck: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--no-shots') opts.shots = false;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--base-css') opts.baseCss = argv[++i];
    else if (a === '-h' || a === '--help') usage('');
    else if (a.startsWith('-')) usage(`unknown flag ${a}`);
    else if (!opts.deck) opts.deck = a;
    else usage('more than one deck path given');
  }
  if (!opts.deck) usage('no deck file given');
  const deckPath = path.resolve(opts.deck);
  if (!fs.existsSync(deckPath) || !fs.statSync(deckPath).isFile()) usage(`deck not found: ${deckPath}`);
  const outDir = path.resolve(opts.out || path.join(path.dirname(deckPath), 'qa'));
  report.deck = deckPath; report.strict = opts.strict;

  const html = fs.readFileSync(deckPath, 'utf8');
  const htmlLines = lineIndex(html);
  const sources = resolveCss(deckPath, html, htmlLines);
  const stat = staticStructure(html);

  // Browser-backed structure when available; conservative regex otherwise.
  const bp = await openBrowser(deckPath);
  let structure = null;
  if (bp) {
    report.browser = bp.name;
    try {
      structure = await runBrowserChecks(bp, deckPath, outDir, opts.shots);
    } catch (e) {
      finding('c', 'warn', `browser checks aborted: ${e.message}`);
      setCheck('c', 'warn', 'browser error');
    } finally { await bp.browser.close().catch(() => {}); }
  } else {
    process.stderr.write('qa-deck: WARNING — no playwright / playwright-core / puppeteer resolvable; overflow checks and screenshots SKIPPED (static checks still gate).\n');
    setCheck('c', 'skip', 'browser unavailable');
  }

  const slideCount = structure ? structure.slideCount : stat.slideCount;
  if (structure && structure.slideCount !== stat.slideCount) {
    finding('d', 'warn', `slide count disagreement: DOM says ${structure.slideCount}, static scan says ${stat.slideCount}`);
  }
  report.slides = { count: slideCount, staticCount: stat.slideCount, progressText: stat.progressText, progressLive: structure?.progressLive ?? null };

  checkTokens(sources, locateBaseCss(deckPath, html, opts.baseCss), opts.strict);
  checkColours(sources, html, htmlLines, deckPath, opts.strict);
  checkProgress(stat.progressText, slideCount); // static text on purpose — see checkProgress
  checkAlt(structure ? structure.imgs : stat.imgs);
  checkAssets(deckPath, html, sources, opts.strict);

  // --strict promotes warns to fails ('note' = explicitly allowlisted, never promoted).
  if (opts.strict) for (const f of report.findings) if (f.severity === 'warn') f.severity = 'fail';
  report.counts.fail = report.findings.filter((f) => f.severity === 'fail').length;
  report.counts.warn = report.findings.filter((f) => f.severity !== 'fail').length;
  // Re-derive each check's status from its findings so the per-check lines and the
  // verdict can never disagree (notably under --strict).
  for (const c of report.checks) {
    if (c.status === 'skip') continue;
    const mine = report.findings.filter((f) => f.check === c.id);
    c.status = mine.some((f) => f.severity === 'fail') ? 'fail' : mine.length ? 'warn' : 'pass';
  }
  report.checks.sort((x, y) => x.id.localeCompare(y.id));
  report.verdict = report.counts.fail ? 'FAIL' : report.counts.warn ? 'PASS (warnings)' : 'PASS';

  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'qa-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const out = [];
    out.push(`qa-deck ${VERSION} — ${path.relative(process.cwd(), deckPath)}`);
    out.push(`browser: ${report.browser}${opts.strict ? ' · strict' : ''} · slides: ${slideCount} · assets: ${report.assets.human}`);
    out.push('');
    for (const c of report.checks) out.push(`  ${c.status.toUpperCase().padEnd(5)} (${c.id}) ${c.name} — ${c.summary}`);
    if (report.findings.length) {
      out.push('', 'Findings:');
      for (const f of report.findings) {
        const loc = f.file ? ` [${f.file}${f.line ? `:${f.line}` : ''}]` : '';
        out.push(`  ${f.severity === 'fail' ? 'FAIL' : 'WARN'} (${f.check}) ${f.message}${loc}`);
        if (f.detail) out.push(`         ${String(f.detail).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    if (report.assets.largest?.length) {
      out.push('', 'Largest assets:');
      for (const a of report.assets.largest) out.push(`  ${a.human.padStart(10)}  ${a.path}`);
    }
    if (report.screenshots.length) out.push('', `Screenshots: ${report.screenshots.length} → ${path.join(outDir, 'slides')}`);
    out.push('', `Report: ${reportPath}`);
    out.push(`Verdict: ${report.verdict} (${report.counts.fail} fail, ${report.counts.warn} warn)`);
    process.stdout.write(`${out.join('\n')}\n`);
  }
  process.exit(report.counts.fail ? 1 : 0);
}

main().catch((e) => { process.stderr.write(`qa-deck: ${e.stack || e.message}\n`); process.exit(2); });
