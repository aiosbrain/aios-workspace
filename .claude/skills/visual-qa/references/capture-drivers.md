# Capture drivers (the portability seam)

`visual-qa` Step 0 binds to the first driver available in the current runtime. The contract is
always the same: **produce a PNG of the page at a named, matched viewport** (same viewport,
scroll position, colour mode, and state as the reference you diff against). Everything after the
capture — `image-diff` / `tui-check`, the two review passes — is identical regardless of driver.

## 1. Claude Code — `claude-in-chrome` MCP

Already available in a Claude Code session. Typical flow:

- `navigate` to the URL.
- `resize_window` to the target viewport (e.g. 1280×800, then 768, then 375).
- screenshot via the `computer` tool (or the page-capture action) → save as `actual.png`.
- `read_console_messages` to catch runtime errors that a screenshot won't show.

## 2. Any runtime with Playwright (the common denominator)

Works under Codex, OpenCode, Cursor, and Claude alike. Minimal fixed-viewport shot:

```js
// capture.mjs — node capture.mjs <url> <out.png> <width> <height>
import { chromium } from '@playwright/test'; // or 'playwright'
const [, , url, out, w = '1280', h = '800'] = process.argv;
const b = await chromium.launch();
const p = await b.newPage();
const errors = [];
p.on('console', m => m.type() === 'error' && errors.push(m.text()));
p.on('pageerror', e => errors.push(String(e)));
await p.setViewportSize({ width: +w, height: +h });
await p.goto(url, { waitUntil: 'networkidle' });
await p.screenshot({ path: out, fullPage: true });
await b.close();
if (errors.length) console.error('PAGE ERRORS:\n' + errors.join('\n'));
```

Wait for *state*, not time (`waitUntil: 'networkidle'` / an explicit selector), or captures flake.
The four listeners that surface "the UI rendered nothing" bugs a screenshot hides: `console` (error),
`pageerror`, `requestfailed`, and a failed-response check.

## 3. Fallback — `agent-browser`

```bash
npm install -g agent-browser && agent-browser install   # one-time
agent-browser open <url>
agent-browser set viewport 1280 800
agent-browser screenshot actual.png
agent-browser close --all
```

Full setup (fixed-viewport shots, auth, waits) is in `agent-browser-setup.md` next to this file.

## TUI capture

No universal driver. If the repo has a real-pty → headless-xterm → PNG capturer, use it (true-colour
PNG + `terminal.txt`). Otherwise capture the plain text output to `terminal.txt` and run
`tui-check <terminal.txt> --cols <N>` — the width/alignment/wide-char checks run on text alone, so a
plain capture still catches overflow, border misalignment, and CJK column drift. Never `tmux
capture-pane` for fidelity work: it degrades true-colour and misaligns wide (CJK) glyphs.
