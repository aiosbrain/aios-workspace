// test/ui-output-context.test.mjs
//
// `scripts/ui/output-context.mjs` — the capability layer behind the CLI's colour (AIO-545,
// GRAIN W0-4). The palette's own behaviour is pinned in
// test/cli-common-color-characterization.test.mjs; this file pins the resolution rules
// underneath it, using fake streams so per-stream independence is actually observable
// (a subprocess has two pipes and cannot distinguish them).
//
// The four properties that matter, in the order they are asserted:
//   1. Detection order — every precedence edge between the seven rules, tested pairwise.
//   2. Per-stream independence — stdout and stderr resolve separately.
//   3. Machine modes are null-decoration BY CONSTRUCTION, not by call-site discipline.
//   4. `mode` is an argument. This module must never look at `process.argv`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COLOR_DEPTH,
  DEFAULT_WIDTH,
  ENV_KEYS,
  GLYPH_SETS,
  MODES,
  TIERS,
  resolveOutputContext,
} from "../scripts/ui/output-context.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_SRC = path.join(REPO, "scripts", "ui", "output-context.mjs");

/** A stand-in for a WriteStream. Only `isTTY` and `columns` are ever consulted. */
function fakeStream({ isTTY = false, columns } = {}) {
  return { isTTY, columns };
}

const tty = () => fakeStream({ isTTY: true, columns: 120 });
const pipe = () => fakeStream({ isTTY: false });

function depth(env, stream = pipe()) {
  return resolveOutputContext({ stream, env }).colorDepth;
}

// ── 1. Detection order ──────────────────────────────────────────────────────

test("a pipe gets no colour; a TTY gets 16", () => {
  assert.equal(depth({}), COLOR_DEPTH.NONE);
  assert.equal(depth({}, tty()), COLOR_DEPTH.ANSI16);
});

test("FORCE_COLOR is the highest-precedence env rule and carries a depth", () => {
  // Highest precedence: it beats NO_COLOR, CLICOLOR=0, TERM=dumb and a non-TTY stream.
  assert.equal(depth({ FORCE_COLOR: "1" }), COLOR_DEPTH.ANSI16);
  assert.equal(depth({ FORCE_COLOR: "2" }), COLOR_DEPTH.ANSI256);
  assert.equal(depth({ FORCE_COLOR: "3" }), COLOR_DEPTH.TRUECOLOR);
  assert.equal(depth({ FORCE_COLOR: "true" }), COLOR_DEPTH.ANSI16);
  assert.equal(depth({ FORCE_COLOR: "" }), COLOR_DEPTH.ANSI16, "empty means on, per convention");
  assert.equal(depth({ FORCE_COLOR: "0" }), COLOR_DEPTH.NONE);
  assert.equal(depth({ FORCE_COLOR: "false" }), COLOR_DEPTH.NONE);

  for (const beaten of [{ NO_COLOR: "1" }, { CLICOLOR: "0" }, { TERM: "dumb" }]) {
    assert.equal(
      depth({ ...beaten, FORCE_COLOR: "1" }, tty()),
      COLOR_DEPTH.ANSI16,
      `FORCE_COLOR=1 must outrank ${JSON.stringify(beaten)}`
    );
    assert.equal(
      depth({ ...beaten, FORCE_COLOR: "0" }, tty()),
      COLOR_DEPTH.NONE,
      `FORCE_COLOR=0 must outrank ${JSON.stringify(beaten)}`
    );
  }
});

test("FORCE_COLOR=0 beats an otherwise perfect TTY", () => {
  assert.equal(depth({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, tty()), COLOR_DEPTH.NONE);
});

test("NO_COLOR disables only when present AND non-empty", () => {
  // no-color.org is explicit that an empty value must not disable. Asserted on a TTY so
  // the stream is not what decides the outcome.
  assert.equal(depth({ NO_COLOR: "1" }, tty()), COLOR_DEPTH.NONE);
  assert.equal(depth({ NO_COLOR: "0" }, tty()), COLOR_DEPTH.NONE, "any non-empty value disables");
  assert.equal(depth({ NO_COLOR: "" }, tty()), COLOR_DEPTH.ANSI16);
  assert.equal(depth({}, tty()), COLOR_DEPTH.ANSI16);
});

test("NO_COLOR outranks CLICOLOR_FORCE", () => {
  assert.equal(depth({ CLICOLOR_FORCE: "1", TERM: "xterm" }), COLOR_DEPTH.ANSI16);
  assert.equal(depth({ CLICOLOR_FORCE: "1", TERM: "xterm", NO_COLOR: "1" }), COLOR_DEPTH.NONE);
});

test("CLICOLOR_FORCE forces colour onto a pipe; CLICOLOR=0 disables on a TTY", () => {
  assert.equal(depth({ CLICOLOR_FORCE: "1", COLORTERM: "truecolor" }), COLOR_DEPTH.TRUECOLOR);
  assert.equal(depth({ CLICOLOR_FORCE: "0" }), COLOR_DEPTH.NONE, "an explicit 0 does not force");
  assert.equal(depth({ CLICOLOR: "0" }, tty()), COLOR_DEPTH.NONE);
  assert.equal(depth({ CLICOLOR: "1" }, tty()), COLOR_DEPTH.ANSI16);
  assert.equal(depth({ CLICOLOR: "1" }), COLOR_DEPTH.NONE, "CLICOLOR=1 does not force onto a pipe");
});

test("TERM=dumb disables even on a TTY, and outranks the COLORTERM upgrade", () => {
  assert.equal(depth({ TERM: "dumb" }, tty()), COLOR_DEPTH.NONE);
  assert.equal(depth({ TERM: "dumb", COLORTERM: "truecolor" }, tty()), COLOR_DEPTH.NONE);
});

test("TERM=dumb is detected, so either explicit opt-in overrides it", () => {
  // A user who exported CLICOLOR_FORCE or FORCE_COLOR under TERM=dumb has said something
  // the process cannot second-guess — e.g. a wrapper that strips TERM but renders SGR fine.
  assert.equal(depth({ TERM: "dumb", FORCE_COLOR: "1" }, tty()), COLOR_DEPTH.ANSI16);
  assert.equal(depth({ TERM: "dumb", CLICOLOR_FORCE: "1" }), COLOR_DEPTH.ANSI16);
});

test("depth on a colour-capable TTY comes from COLORTERM then TERM", () => {
  assert.equal(depth({ COLORTERM: "truecolor" }, tty()), COLOR_DEPTH.TRUECOLOR);
  assert.equal(depth({ COLORTERM: "24bit" }, tty()), COLOR_DEPTH.TRUECOLOR);
  assert.equal(depth({ TERM: "xterm-256color" }, tty()), COLOR_DEPTH.ANSI256);
  assert.equal(depth({ TERM: "xterm-direct" }, tty()), COLOR_DEPTH.TRUECOLOR);
  assert.equal(depth({ TERM: "xterm" }, tty()), COLOR_DEPTH.ANSI16);
  assert.equal(depth({}, tty()), COLOR_DEPTH.ANSI16, "an unset TERM still renders 16 colours");
});

test("CI needs no rule of its own — its stdout is a pipe", () => {
  // Recorded because it is a tempting special case. CI=true on a TTY (a local `CI=true`
  // run, or a CI runner with a pty) must still colour; only motion is suppressed.
  assert.equal(depth({ CI: "true" }), COLOR_DEPTH.NONE);
  assert.equal(depth({ CI: "true" }, tty()), COLOR_DEPTH.ANSI16);
  assert.equal(resolveOutputContext({ stream: tty(), env: { CI: "true" } }).motion, false);
});

test("an explicit colorDepth option outranks every environment rule", () => {
  const env = { NO_COLOR: "1", TERM: "dumb" };
  assert.equal(resolveOutputContext({ stream: pipe(), env, colorDepth: 24 }).colorDepth, 24);
  assert.equal(resolveOutputContext({ stream: tty(), env: {}, colorDepth: 0 }).colorDepth, 0);
  // Off-rung values clamp down to a supported rung rather than being trusted verbatim.
  assert.equal(resolveOutputContext({ stream: pipe(), env: {}, colorDepth: 99 }).colorDepth, 24);
  assert.equal(resolveOutputContext({ stream: pipe(), env: {}, colorDepth: 7 }).colorDepth, 4);
  assert.equal(resolveOutputContext({ stream: pipe(), env: {}, colorDepth: -1 }).colorDepth, 0);
});

// ── 2. Per-stream independence ──────────────────────────────────────────────

test("stdout and stderr resolve independently", () => {
  // `aios … | tee` — piped stdout, TTY stderr — is the normal shape, and progress on
  // stderr must stay coloured in it. This is the reason capabilities are per-stream.
  const env = {};
  const out = resolveOutputContext({ stream: pipe(), env });
  const err = resolveOutputContext({ stream: tty(), env });
  assert.equal(out.colorDepth, COLOR_DEPTH.NONE);
  assert.equal(err.colorDepth, COLOR_DEPTH.ANSI16);
  assert.equal(out.motion, false);
  assert.equal(err.motion, true);
});

test("a missing stream resolves to no colour rather than throwing", () => {
  // `env: {}` explicitly: this asserts what the absent STREAM does, so it must not inherit
  // the runner's colour environment. Without it, a shell with FORCE_COLOR or CLICOLOR_FORCE
  // set forces a depth and the case fails for a reason it does not test.
  const ctx = resolveOutputContext({ env: {} });
  assert.equal(ctx.colorDepth, COLOR_DEPTH.NONE);
  assert.equal(ctx.motion, false);
  assert.equal(ctx.width, DEFAULT_WIDTH);
});

test("env defaults to process.env when not supplied", () => {
  // The default that the case above deliberately opts out of. Pinned separately so opting
  // out never quietly becomes "this module ignores the ambient environment".
  const saved = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "3";
  try {
    assert.equal(resolveOutputContext({ stream: pipe() }).colorDepth, COLOR_DEPTH.TRUECOLOR);
  } finally {
    if (saved === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = saved;
  }
});

// ── 3. Machine modes are null-decoration by construction ────────────────────

for (const mode of ["json", "porcelain"]) {
  test(`mode=${mode} is null-decoration even on a truecolour TTY with FORCE_COLOR`, () => {
    const ctx = resolveOutputContext({
      mode,
      stream: tty(),
      env: { FORCE_COLOR: "3", COLORTERM: "truecolor", AIOS_UI_MOTION: "1" },
    });
    assert.equal(ctx.colorDepth, COLOR_DEPTH.NONE, "machine output must never carry SGR");
    assert.equal(ctx.motion, false);
    assert.equal(ctx.glyphs, "ascii");
    assert.equal(ctx.tier, "plain");
  });
}

test("an unknown mode throws rather than silently decorating", () => {
  assert.throws(() => resolveOutputContext({ mode: "yaml" }), /unknown mode/);
  for (const mode of MODES) {
    assert.equal(resolveOutputContext({ mode, stream: pipe(), env: {} }).mode, mode);
  }
});

// ── 4. `mode` is supplied, never sniffed ────────────────────────────────────

test("the module never reads process.argv", () => {
  // 30+ scripts accept --json/--porcelain, several with their own local flag branches, and
  // commands are also invoked programmatically and nested. Global argv sniffing would
  // misclassify all of those, so the source must not contain the escape hatch at all.
  // Comments stripped first — the module header discusses `process.argv` at length in
  // explaining why it must never read it, and that prose must not satisfy the test.
  const code = readFileSync(MODULE_SRC, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/process\s*\.\s*argv/.test(code),
    "output-context.mjs must not reference process.argv"
  );
});

test("the default mode is human", () => {
  assert.equal(resolveOutputContext({ stream: tty(), env: {} }).mode, "human");
});

// ── Tier, glyphs, width, background ─────────────────────────────────────────

test("tier: rich = motion, basic = colour without motion, plain = neither", () => {
  // `basic` is "rich minus motion", NOT "rich minus truecolour" — depth is a separate
  // scalar so a 16-colour TTY still gets progress.
  assert.equal(resolveOutputContext({ stream: tty(), env: {} }).tier, "rich");
  assert.equal(
    resolveOutputContext({ stream: pipe(), env: { FORCE_COLOR: "1" } }).tier,
    "basic",
    "a forced-colour pipe has colour but no motion"
  );
  assert.equal(resolveOutputContext({ stream: pipe(), env: {} }).tier, "plain");
  assert.equal(
    resolveOutputContext({ stream: tty(), env: { TERM: "xterm-256color", AIOS_UI_MOTION: "0" } })
      .tier,
    "basic",
    "256-colour with motion off is basic, not plain"
  );
});

test("AIOS_UI_* overrides win, and an unrecognised value falls back to detection", () => {
  const tierCtx = resolveOutputContext({ stream: tty(), env: { AIOS_UI_TIER: "plain" } });
  assert.equal(tierCtx.tier, "plain");
  assert.equal(tierCtx.colorDepth, COLOR_DEPTH.ANSI16, "tier does not overwrite colour depth");

  assert.equal(resolveOutputContext({ stream: tty(), env: { AIOS_UI_TIER: "nope" } }).tier, "rich");

  for (const glyphs of GLYPH_SETS) {
    assert.equal(resolveOutputContext({ env: { AIOS_UI_GLYPHS: glyphs } }).glyphs, glyphs);
  }
  assert.equal(resolveOutputContext({ env: {} }).glyphs, "unicode", "undetectable ⇒ safe default");
  assert.equal(resolveOutputContext({ env: { AIOS_UI_GLYPHS: "emoji" } }).glyphs, "unicode");

  assert.equal(resolveOutputContext({ stream: tty(), env: { AIOS_UI_MOTION: "0" } }).motion, false);
  assert.equal(resolveOutputContext({ stream: pipe(), env: { AIOS_UI_MOTION: "1" } }).motion, true);

  assert.equal(resolveOutputContext({ env: { AIOS_UI_BG: "light" } }).background, "light");
  assert.equal(resolveOutputContext({ env: {} }).background, "dark", "no OSC 11 probe");
  assert.equal(resolveOutputContext({ env: { AIOS_UI_BG: "beige" } }).background, "dark");
});

test("width: AIOS_UI_WIDTH, then stream.columns, then 80", () => {
  assert.equal(resolveOutputContext({ stream: tty(), env: { AIOS_UI_WIDTH: "40" } }).width, 40);
  assert.equal(resolveOutputContext({ stream: tty(), env: {} }).width, 120);
  assert.equal(resolveOutputContext({ stream: pipe(), env: {} }).width, DEFAULT_WIDTH);
  assert.equal(
    resolveOutputContext({ stream: fakeStream({ isTTY: true, columns: 0 }), env: {} }).width,
    DEFAULT_WIDTH,
    "a 0-column stream is not a width"
  );
  assert.equal(resolveOutputContext({ stream: tty(), env: { AIOS_UI_WIDTH: "x" } }).width, 120);
});

// ── Value-object and memoisation contracts ──────────────────────────────────

test("the returned context is frozen and exposes the documented shape", () => {
  const ctx = resolveOutputContext({ stream: tty(), env: {} });
  assert.ok(Object.isFrozen(ctx));
  assert.deepEqual(Object.keys(ctx).sort(), [
    "background",
    "colorDepth",
    "glyphs",
    "mode",
    "motion",
    "stream",
    "tier",
    "width",
  ]);
  assert.ok(TIERS.includes(ctx.tier));
});

test("identical (stream, mode, env) is memoised; a changed env is not", () => {
  const stream = tty();
  const env = { TERM: "xterm" };
  assert.equal(resolveOutputContext({ stream, env }), resolveOutputContext({ stream, env }));
  assert.notEqual(
    resolveOutputContext({ stream, env }),
    resolveOutputContext({ stream, env: { TERM: "xterm-256color" } }),
    "a different env must not hit the cache"
  );
  assert.notEqual(
    resolveOutputContext({ stream, env }),
    resolveOutputContext({ stream: tty(), env }),
    "a different stream must not hit the cache"
  );
  assert.notEqual(
    resolveOutputContext({ stream, env }),
    resolveOutputContext({ stream, env, mode: "json" }),
    "a different mode must not hit the cache"
  );
});

test("only ENV_KEYS participate in the cache key", () => {
  const stream = tty();
  const a = resolveOutputContext({ stream, env: { TERM: "xterm", IRRELEVANT: "1" } });
  const b = resolveOutputContext({ stream, env: { TERM: "xterm", IRRELEVANT: "2" } });
  assert.equal(a, b, "an unrelated variable must not bust the cache");
  assert.ok(!ENV_KEYS.includes("IRRELEVANT"));
  assert.ok(ENV_KEYS.includes("NO_COLOR") && ENV_KEYS.includes("FORCE_COLOR"));
});

test("a present-but-empty variable is distinguished from an absent one", () => {
  // The whole NO_COLOR rule turns on this distinction, so the cache must not erase it.
  const stream = tty();
  assert.notEqual(
    resolveOutputContext({ stream, env: {} }),
    resolveOutputContext({ stream, env: { NO_COLOR: "" } })
  );
});

test("changed stream capabilities invalidate the memoised context", () => {
  const stream = fakeStream({ isTTY: true, columns: 80 });
  const env = { TERM: "xterm" };
  const initial = resolveOutputContext({ stream, env });
  assert.equal(initial.width, 80);
  assert.equal(initial.colorDepth, COLOR_DEPTH.ANSI16);

  stream.columns = 120;
  const resized = resolveOutputContext({ stream, env });
  assert.equal(resized.width, 120);

  stream.isTTY = false;
  const piped = resolveOutputContext({ stream, env });
  assert.equal(piped.colorDepth, COLOR_DEPTH.NONE);
  assert.equal(piped.motion, false);
});

test("an explicit colorDepth is never memoised into the shared entry", () => {
  const stream = tty();
  const env = { TERM: "xterm" };
  resolveOutputContext({ stream, env, colorDepth: 0 });
  assert.equal(
    resolveOutputContext({ stream, env }).colorDepth,
    COLOR_DEPTH.ANSI16,
    "a one-off override must not poison the cache for later callers"
  );
});
