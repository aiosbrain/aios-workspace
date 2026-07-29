#!/usr/bin/env node
/**
 * deck-pdf.mjs — print an aios-deck HTML deck to PDF, one slide per page.
 *
 * Usage:
 *   node deck-pdf.mjs <deck.html> [--out <file.pdf>] [--landscape|--portrait]
 *                     [--format A4|Letter] [--chrome <path>]
 *
 * WHY THIS EXISTS — the workspace's existing markdown-to-PDF script cannot do
 * this job, and reaching for it wastes a round every time:
 *   1. It takes MARKDOWN as input. A deck is HTML; there is nothing to convert.
 *   2. Its renderer executes NO JavaScript, so `deck-nav.js` never runs and the
 *      progress HUD is whatever the static markup says.
 *   3. Its renderer supports neither `color-mix()`, CSS `scroll-snap`, nor
 *      `aspect-ratio` — and this deck system depends on all three: every note,
 *      callout, paperwhite surface and zebra table row is a `color-mix()`, the
 *      slide mechanics are scroll-snap, and `.person-card img` is `aspect-ratio: 1`.
 * A real browser engine is the requirement, not a preference. That is all this
 * script is: the shortest path to one.
 *
 * Strategy 1 — an installed playwright / playwright-core / puppeteer, if one
 *   resolves from this script, the cwd, or the deck's own folder.
 * Strategy 2 — spawn headless Chrome/Chromium directly with --print-to-pdf.
 *
 * The file URL always carries `?print`, which tells deck-nav.js not to restore
 * the reader's last slide, so the export starts at slide 1.
 *
 * Zero dependencies beyond node: builtins (+ the optional browser import).
 * Exit 0 on success, 2 on usage / missing-browser / IO error.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const CHROME_ON_PATH = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

const HELP = `deck-pdf ${VERSION} — print an aios-deck HTML deck to PDF

Usage:
  deck-pdf.mjs <deck.html> [options]

Options:
  --out <file.pdf>     Output path. Default: the deck path with .pdf
  --landscape          16:9 slides across the page (default)
  --portrait           Portrait pages instead
  --format A4|Letter   Paper size. Default: A4
  --chrome <path>      Explicit Chrome/Chromium binary
  -h, --help           This message

Browser resolution order:
  playwright / playwright-core / puppeteer (if installed), then
  --chrome → $CHROME_PATH → the standard Chrome/Chromium install locations → PATH
`;

const die = (msg) => { process.stderr.write(`deck-pdf: ${msg}\n`); process.exit(2); };
const human = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB`
  : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

/* -------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const o = { deck: null, out: null, landscape: true, format: 'A4', chrome: null };
  const need = (i, flag) => { if (i + 1 >= argv.length) die(`${flag} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { o.out = need(i, a); i++; }
    else if (a === '--chrome') { o.chrome = need(i, a); i++; }
    else if (a === '--format') { o.format = need(i, a); i++; }
    else if (a === '--landscape') o.landscape = true;
    else if (a === '--portrait') o.landscape = false;
    else if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
    else if (a.startsWith('-')) die(`unknown flag ${a}`);
    else if (!o.deck) o.deck = a;
    else die(`unexpected argument ${a}`);
  }
  if (!o.deck) die('no deck file given (try --help)');
  const FORMATS = { a4: 'A4', a3: 'A3', letter: 'Letter', legal: 'Legal' };
  const fmt = FORMATS[String(o.format).toLowerCase()];
  if (!fmt) die(`unsupported --format ${o.format} (A4, A3, Letter, Legal)`);
  o.format = fmt;
  return o;
}

/* ------------------------------------------------ strategy 1: node driver */

async function loadDriver(deckDir) {
  const bases = [null, process.cwd(), deckDir, HERE, path.resolve(process.execPath, '../../lib/node_modules')];
  for (const name of ['playwright', 'playwright-core', 'puppeteer']) {
    for (const base of bases) {
      try {
        let mod;
        if (base === null) mod = await import(name);
        else {
          const req = createRequire(path.join(base, '__deck-pdf__.cjs'));
          mod = await import(pathToFileURL(req.resolve(name)).href);
        }
        return { name, mod: (mod.default && !mod.chromium) ? mod.default : mod };
      } catch { /* try the next candidate */ }
    }
  }
  return null;
}

async function viaDriver(driver, url, out, o, chromePath) {
  const isPw = driver.name !== 'puppeteer';
  const launcher = isPw ? driver.mod.chromium : driver.mod;
  const attempts = [{ headless: true }];
  if (chromePath) attempts.push({ headless: true, executablePath: chromePath });

  let browser = null;
  let lastErr = null;
  for (const opts of attempts) {
    try { browser = await launcher.launch(opts); break; } catch (e) { lastErr = e; }
  }
  if (!browser) throw lastErr || new Error('browser launch failed');

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: isPw ? 'load' : 'networkidle0', timeout: 60000 });
    if (isPw && page.waitForLoadState) {
      await page.waitForLoadState('networkidle').catch(() => {});
    }
    await page.pdf({
      path: out,
      printBackground: true,          /* the gradient accent bar + photo scrims */
      landscape: o.landscape,
      format: o.format,
      preferCSSPageSize: false,
      /* Zero margin: the slide IS the page. Both drivers accept the object form. */
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ----------------------------------------------- strategy 2: raw Chrome */

function findChrome(flagPath) {
  const ok = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
  if (flagPath) {
    if (!ok(flagPath)) die(`--chrome path is not executable: ${flagPath}`);
    return flagPath;
  }
  if (process.env.CHROME_PATH && ok(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const p of CHROME_CANDIDATES) if (ok(p)) return p;
  for (const name of CHROME_ON_PATH) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (r.status === 0) {
      const p = r.stdout.split('\n')[0].trim();
      if (p && ok(p)) return p;
    }
  }
  return null;
}

function viaChrome(chrome, url, out, o) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-pdf-header-footer',
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pdf-'))}`,
      `--print-to-pdf=${out}`,
      '--virtual-time-budget=8000',
      url,
    ];
    /* Chrome's --print-to-pdf has no page-size flag; the deck's @media print block
       does the work. --landscape is honoured, --format is not (driver path only). */
    if (o.landscape) args.splice(args.length - 1, 0, '--landscape');
    const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || fs.existsSync(out)) resolve();
      else reject(new Error(`chrome exited ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
    });
  });
}

/* ------------------------------------------------------------------- main */

/** Cheap page count: PDFs list one /Type /Page object per page. */
function pdfPageCount(file) {
  try {
    const buf = fs.readFileSync(file).toString('latin1');
    const m = buf.match(/\/Type\s*\/Page[^s]/g);
    return m ? m.length : null;
  } catch { return null; }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const deck = path.resolve(o.deck);
  if (!fs.existsSync(deck) || !fs.statSync(deck).isFile()) die(`deck not found: ${deck}`);
  const out = path.resolve(o.out || deck.replace(/\.html?$/i, '') + '.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out)) fs.rmSync(out);

  /* ?print — deck-nav.js reads this and does NOT restore the saved slide, so the
     export always begins at slide 1. */
  const url = `${pathToFileURL(deck).href}?print`;

  const chrome = findChrome(o.chrome);
  const driver = await loadDriver(path.dirname(deck));
  let how = null;

  if (driver) {
    try {
      await viaDriver(driver, url, out, o, chrome);
      how = driver.name;
    } catch (e) {
      process.stderr.write(`deck-pdf: ${driver.name} failed (${e.message}); falling back to raw Chrome\n`);
    }
  }
  if (!how) {
    if (!chrome) {
      die([
        'no usable browser found. Two ways to fix it:',
        '  1. Install a driver next to the deck or in this project:',
        '       npm i -D playwright && npx playwright install chromium',
        '  2. Point this script at a Chrome/Chromium binary:',
        '       deck-pdf.mjs <deck.html> --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
        '     or export CHROME_PATH=/path/to/chrome',
      ].join('\n'));
    }
    try {
      await viaChrome(chrome, url, out, o);
      how = `chrome (${path.basename(chrome)})`;
    } catch (e) {
      die(`headless Chrome failed: ${e.message}`);
    }
  }

  if (!fs.existsSync(out)) die(`no PDF was written to ${out}`);
  const size = fs.statSync(out).size;
  if (!size) { fs.rmSync(out, { force: true }); die(`the PDF written to ${out} was empty (0 bytes)`); }

  const pages = pdfPageCount(out);
  process.stdout.write([
    `deck-pdf ${VERSION} — via ${how}`,
    `  ${out}`,
    `  ${human(size)}${pages ? ` · ${pages} page(s)` : ''} · ${o.landscape ? 'landscape' : 'portrait'} ${o.format}`,
    '',
  ].join('\n'));
  process.exit(0);
}

main().catch((e) => { process.stderr.write(`deck-pdf: ${e.stack || e.message}\n`); process.exit(2); });
