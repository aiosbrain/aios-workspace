// test/cli-common-color-characterization.test.mjs
//
// CHARACTERIZATION baseline for `c`, the ANSI colour helper in scripts/cli-common.mjs.
//
// `c` is imported by 29 files and is the single choke point for roughly 1,053 `console.*`
// calls across the CLI. This file was written BEFORE GRAIN W0-4 (AIO-543/#422) to pin what
// `c` did then — including two behaviours recorded as KNOWN WRONG — so that the change
// would land as a reviewable diff against a recorded baseline instead of an unverifiable
// claim.
//
// **AIO-545 (GRAIN W0-4) has now landed, and sections C and D are that diff.** They no
// longer describe bugs; they are the specification of the fixed behaviour. Each one records
// what it used to assert, so the change stays legible in `git log -p` rather than only in a
// merged PR description.
//
//   A. THE FROZEN BYTES. The exact SGR sequences. UNCHANGED by W0-4 — this is the promise
//      that a terminal rendering AIOS before the change renders it identically after. They
//      are now asserted under a forced-colour environment, because the helper no longer
//      emits SGR unconditionally and `node --test` runs with a piped stdout.
//   B. VALUE COERCION. What `c` does with non-strings, coloured and uncoloured.
//   C. NESTING — FIXED. An inner reset used to terminate the outer style; the outer style
//      is now re-opened after it.
//   D. ENVIRONMENT — FIXED. `c` used to ignore isTTY, NO_COLOR, FORCE_COLOR, CLICOLOR and
//      TERM=dumb, leaking escape codes into pipes, files and CI logs. This section is now
//      the expectation table for capability-aware output.
//   E. RE-EXPORT IDENTITY. `relay-core.mjs` re-exports the same object; importers must not
//      be able to observe two different palettes. `die` is capability-aware on **stderr**,
//      resolved independently of stdout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { c, cErr, createPalette } from "../scripts/cli-common.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_COMMON = path.join(REPO, "scripts", "cli-common.mjs");

const ESC = "\x1b";
const RESET = `${ESC}[0m`;

/**
 * Every variable that can change a colour verdict. Both helpers below clear all of them, so
 * a case declares its whole colour environment rather than inheriting part of it.
 *
 * Without this the suite is not hermetic: a developer with `NO_COLOR=1` exported, a CI job
 * that sets `FORCE_COLOR=0`, or the `TERM=dumb` that automation and agent shells commonly
 * use would each fail a case for a reason that has nothing to do with the code.
 */
const COLOR_ENV_KEYS = [
  "NO_COLOR",
  "FORCE_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "COLORTERM",
  "TERM",
  "CI",
];

/** A colour-capable baseline: 16-colour `TERM`, nothing else set. */
const NEUTRAL_TERM = "xterm";

/** `process.env` with the colour environment reset to that baseline, for a subprocess. */
function neutralEnv() {
  const env = { ...process.env };
  for (const key of COLOR_ENV_KEYS) delete env[key];
  env.TERM = NEUTRAL_TERM;
  return env;
}

/**
 * Run `fn` with the *live* colour environment reset to the same baseline, plus any
 * overrides. In-process rather than in a subprocess, for the cases that need the real
 * module objects (`c`, `cErr`, `createPalette`) rather than just their output.
 */
function withColorEnv(overrides, fn) {
  const saved = Object.fromEntries(COLOR_ENV_KEYS.map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  for (const key of COLOR_ENV_KEYS) delete process.env[key];
  process.env.TERM = NEUTRAL_TERM;
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    restore();
  }
}

/**
 * Run `fn` with `FORCE_COLOR=1` so the stdout-bound palette resolves to colour depth 4.
 * The test runner's stdout is a pipe, which now (correctly) means no colour — so every
 * in-process assertion about SGR bytes has to say which capability it is asserting for.
 */
function withForcedColor(fn) {
  return withColorEnv({ FORCE_COLOR: "1" }, fn);
}

/**
 * Run `c[method](input)` in a FRESH node process whose stdout is a pipe (never a TTY),
 * under the given env, and return the produced string. Subprocess rather than in-process
 * because capability detection is a property of the real stream and the real environment;
 * an in-process test cannot observe it.
 */
function renderInSubprocess(method, input, env = {}) {
  const src =
    `import({url}).then(({c}) => ` +
    `process.stdout.write(JSON.stringify(c[${JSON.stringify(method)}](${JSON.stringify(input)}))))`;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", src.replace("{url}", JSON.stringify(CLI_COMMON))],
    { encoding: "utf8", env: { ...neutralEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(out);
}

// ── A. THE FROZEN BYTES ─────────────────────────────────────────────────────

const FROZEN_SGR = {
  red: `${ESC}[0;31m`,
  green: `${ESC}[0;32m`,
  yellow: `${ESC}[1;33m`,
  blue: `${ESC}[0;34m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
};

test("A: `c` exposes exactly the six documented keys, in order", () => {
  assert.deepEqual(Object.keys(c), ["red", "green", "yellow", "blue", "dim", "bold"]);
});

for (const [method, open] of Object.entries(FROZEN_SGR)) {
  test(`A: c.${method} wraps in ${JSON.stringify(open)} … reset on a colour-capable stream`, () => {
    assert.equal(
      withForcedColor(() => c[method]("x")),
      `${open}x${RESET}`
    );
  });
}

test("A: every helper closes with a full reset, never a targeted off-code", () => {
  withForcedColor(() => {
    for (const method of Object.keys(FROZEN_SGR)) {
      assert.ok(
        c[method]("x").endsWith(RESET),
        `c.${method} must end with ${JSON.stringify(RESET)}`
      );
    }
  });
});

// ── B. VALUE COERCION ───────────────────────────────────────────────────────

test("B: values are coerced by template interpolation, not validated", () => {
  withForcedColor(() => {
    assert.equal(c.red(""), `${ESC}[0;31m${RESET}`, "empty string still emits the wrapper");
    assert.equal(c.red(undefined), `${ESC}[0;31mundefined${RESET}`);
    assert.equal(c.red(null), `${ESC}[0;31mnull${RESET}`);
    assert.equal(c.red(0), `${ESC}[0;31m0${RESET}`, "0 must not be treated as falsy/empty");
    assert.equal(c.red(false), `${ESC}[0;31mfalse${RESET}`);
    assert.equal(c.red([1, 2]), `${ESC}[0;31m1,2${RESET}`);
    assert.equal(c.red({ a: 1 }), `${ESC}[0;31m[object Object]${RESET}`);
  });
});

test("B: coercion is identical when colour is suppressed — only the wrapper disappears", () => {
  // The uncoloured path must not become a different function. In particular it must still
  // return a STRING for every input: ~1,053 call sites interpolate the result, and handing
  // back `0` or `undefined` unchanged would change what they print.
  const cases = [
    ["", ""],
    [undefined, "undefined"],
    [null, "null"],
    [0, "0"],
    [false, "false"],
    [[1, 2], "1,2"],
    [{ a: 1 }, "[object Object]"],
  ];
  for (const [input, expected] of cases) {
    const got = renderInSubprocess("red", input, { NO_COLOR: "1" });
    assert.equal(got, expected, `c.red(${JSON.stringify(input)}) with colour off`);
    assert.equal(typeof got, "string");
  }
});

// ── C. NESTING — FIXED ──────────────────────────────────────────────────────

test("C: a nested style's reset re-opens the OUTER style", () => {
  // WAS (pre-W0-4): "\x1b[2ma \x1b[0;31mb\x1b[0m c\x1b[0m" — everything after the inner
  // reset rendered UNSTYLED. With ~345 c.dim() call sites and nesting common in this CLI,
  // that mis-rendered in production.
  //
  // The full reset is KEPT and the outer open is re-emitted after it. Dropping the reset
  // (chalk's approach) is not available here: chalk's closes are targeted off-codes, while
  // every close in this palette is `\x1b[0m`. Dropping it would leave the inner colour
  // switched on for the remainder of the outer span.
  withForcedColor(() => {
    assert.equal(
      c.dim(`a ${c.red("b")} c`),
      `${ESC}[2ma ${ESC}[0;31mb${RESET}${ESC}[2m c${RESET}`,
      "the trailing ' c' must carry the dim attribute"
    );

    const rendered = c.dim(`a ${c.red("b")} c`);
    const afterInnerReset = rendered.slice(rendered.indexOf(RESET) + RESET.length);
    assert.ok(
      afterInnerReset.startsWith(`${ESC}[2m`),
      "dim must be re-opened immediately after the nested reset"
    );
  });
});

test("C: the same holds for bold wrapping a colour", () => {
  assert.equal(
    withForcedColor(() => c.bold(`a ${c.green("b")} c`)),
    `${ESC}[1ma ${ESC}[0;32mb${RESET}${ESC}[1m c${RESET}`
  );
});

test("C: every nested reset is repaired, not just the first", () => {
  assert.equal(
    withForcedColor(() => c.dim(`${c.red("a")}|${c.green("b")}`)),
    `${ESC}[2m${ESC}[0;31ma${RESET}${ESC}[2m|${ESC}[0;32mb${RESET}${ESC}[2m${RESET}`
  );
});

test("C: nesting is a no-op when colour is suppressed — plain text, no stray opens", () => {
  const src =
    `import(${JSON.stringify(CLI_COMMON)}).then(({c}) => ` +
    `process.stdout.write(JSON.stringify(c.dim("a " + c.red("b") + " c"))))`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", src], {
    encoding: "utf8",
    env: { ...neutralEnv(), NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(JSON.parse(out), "a b c");
});

// ── D. ENVIRONMENT — FIXED ──────────────────────────────────────────────────

// Each case: a fresh process, stdout piped (so isTTY is false), under the named env.
// Pre-W0-4 EVERY one of these emitted escape codes. They are now the expectation table.
const PLAIN = "x";
const COLOURED = `${ESC}[0;31mx${RESET}`;

const ENV_CASES = [
  ["a plain pipe (stdout is not a TTY)", {}, PLAIN],
  ["NO_COLOR=1", { NO_COLOR: "1" }, PLAIN],
  ["FORCE_COLOR=0", { FORCE_COLOR: "0" }, PLAIN],
  ["CLICOLOR=0", { CLICOLOR: "0" }, PLAIN],
  ["TERM=dumb", { TERM: "dumb" }, PLAIN],
  ["CI=true", { CI: "true" }, PLAIN],
  ["FORCE_COLOR=1 (an explicit opt-in outranks the pipe)", { FORCE_COLOR: "1" }, COLOURED],
  ["CLICOLOR_FORCE=1", { CLICOLOR_FORCE: "1", TERM: "xterm" }, COLOURED],
];

for (const [label, env, expected] of ENV_CASES) {
  test(`D: ${label} → ${expected === PLAIN ? "no escape codes" : "coloured"}`, () => {
    assert.equal(renderInSubprocess("red", "x", env), expected, `c.red under ${label}`);
  });
}

test("D: both explicit opt-ins outrank TERM=dumb; NO_COLOR outranks CLICOLOR_FORCE", () => {
  // Detection order: FORCE_COLOR → NO_COLOR → CLICOLOR_FORCE → CLICOLOR → TERM=dumb → isTTY.
  // TERM=dumb is a *detected* property, so a user who set either forcing variable wins over
  // it; NO_COLOR is an explicit refusal, so it wins over CLICOLOR_FORCE.
  assert.equal(renderInSubprocess("red", "x", { TERM: "dumb", FORCE_COLOR: "1" }), COLOURED);
  assert.equal(renderInSubprocess("red", "x", { TERM: "dumb", CLICOLOR_FORCE: "1" }), COLOURED);
  assert.equal(
    renderInSubprocess("red", "x", { CLICOLOR_FORCE: "1", TERM: "xterm", NO_COLOR: "1" }),
    PLAIN
  );
});

test("D: NO_COLOR= (empty) does NOT disable colour — it must be present AND non-empty", () => {
  // no-color.org: "when present and not an empty string". Asserted against a context that
  // would otherwise be coloured (CLICOLOR_FORCE), so the pipe is not what decides it.
  // FORCE_COLOR is deliberately NOT used here — it outranks NO_COLOR either way and would
  // make the assertion vacuous.
  const forcing = { CLICOLOR_FORCE: "1", TERM: "xterm" };
  assert.equal(renderInSubprocess("red", "x", { ...forcing, NO_COLOR: "" }), COLOURED);
  assert.equal(renderInSubprocess("red", "x", { ...forcing, NO_COLOR: "1" }), PLAIN);
});

test("D: `c` is capability-aware — the same input renders differently under two envs", () => {
  // WAS (pre-W0-4): an assertion that `String(c.red)` mentions no `process`, `env`,
  // `isTTY`, `NO_COLOR` or `FORCE_COLOR` — i.e. that `c` was a pure function of its
  // argument. That is precisely what W0-4 changed. The replacement is behavioural rather
  // than source-shaped, so it survives the palette being refactored again.
  assert.notEqual(
    renderInSubprocess("red", "x", { FORCE_COLOR: "1" }),
    renderInSubprocess("red", "x", { FORCE_COLOR: "0" })
  );
});

// ── E. RE-EXPORT IDENTITY ───────────────────────────────────────────────────

test("E: relay-core re-exports the SAME `c` object, not a copy", async () => {
  // Two palettes reachable through two import paths is precisely the drift AIO-315
  // collapsed. Importers must not be able to observe a difference.
  const [common, relay] = await Promise.all([
    import("../scripts/cli-common.mjs"),
    import("../scripts/relay-core.mjs"),
  ]);
  assert.equal(relay.c, common.c, "relay-core.c must be the identical object");
  for (const method of Object.keys(FROZEN_SGR)) {
    assert.equal(relay.c[method], common.c[method], `relay-core.c.${method} must be identical`);
  }
  assert.equal(typeof relay.die, "function", "relay-core must keep re-exporting die");
});

test("E: rails.mjs no longer defines a private palette", () => {
  // AIO-315 collapsed three copies of `c`; scripts/rails.mjs kept a fourth (bold, no blue)
  // until W0-4 deleted it. A reintroduced local copy would silently be capability-blind.
  const src = readFileSync(path.join(REPO, "scripts", "rails.mjs"), "utf8");
  assert.ok(
    !/^const c = \{/m.test(src),
    "rails.mjs must import `c` from cli-common.mjs, never redefine it"
  );
  assert.match(src, /import \{[^}]*\bc\b[^}]*\} from "\.\/cli-common\.mjs"/);
});

function runDie(env = {}) {
  const src = `import(${JSON.stringify(CLI_COMMON)}).then(({die}) => die("boom"))`;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", src], {
      encoding: "utf8",
      env: { ...neutralEnv(), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { status: e.status, stderr: e.stderr ?? "" };
  }
  throw new Error("die must not exit 0");
}

test("E: `die` writes `error: <msg>` to stderr and exits 1", () => {
  const { status, stderr } = runDie();
  assert.equal(status, 1, "die must exit 1");
  assert.match(stderr, /error: boom/, "die must prefix with 'error: '");
});

test("E: `c` is stdout-bound and `cErr` is stderr-bound, resolved independently", () => {
  // The two palettes must not be the same object, and each must follow ITS OWN stream.
  // Asserted with a fake stream through the factory, because a subprocess has two pipes
  // and cannot tell them apart.
  const ttyPalette = createPalette(() => ({ isTTY: true, columns: 80 }));
  const pipePalette = createPalette(() => ({ isTTY: false }));
  // The whole colour environment is reset, not just NO_COLOR/FORCE_COLOR: this case turns
  // on `isTTY` being the deciding rule, and an inherited TERM=dumb would pre-empt it and
  // make a passing implementation look broken.
  withColorEnv({}, () => {
    assert.equal(ttyPalette.red("x"), `${ESC}[0;31mx${RESET}`, "a TTY-bound palette colours");
    assert.equal(pipePalette.red("x"), "x", "a pipe-bound palette does not");
  });
  assert.notEqual(c, cErr, "the two palettes are distinct objects");
});

test("E: KNOWN GAP — stderr call sites still go through the stdout-bound `c`", () => {
  // Recorded, not fixed. ~93 `console.error(c.…)` sites across 15 scripts write stderr
  // through the stdout-bound palette, so they lose colour under `aios … | tee`. See the
  // `cErr` docblock for why a 93-site swap through the marker emitters is the wrong trade
  // for W0-4; they move when their command is migrated (GRAIN §2.5, Wave 1).
  //
  // This test exists so the gap is a recorded state rather than an accident: if someone
  // migrates the sites, `cErr` usage grows and this assertion is the prompt to update the
  // docblock in the same commit.
  const cliCommon = readFileSync(CLI_COMMON, "utf8");
  assert.match(cliCommon, /export const c = createPalette\(\(\) => process\.stdout\)/);
  assert.match(cliCommon, /export const cErr = createPalette\(\(\) => process\.stderr\)/);
  assert.match(cliCommon, /KNOWN GAP/, "the gap must stay documented while it exists");
});

test("E: `die` is capability-aware on stderr", () => {
  // WAS (pre-W0-4): "die colours stderr unconditionally". It now resolves stderr's OWN
  // capabilities, independently of stdout — because `aios … | tee` (piped stdout, TTY
  // stderr) is normal and diagnostics must stay coloured in it.
  assert.ok(!runDie().stderr.includes(ESC), "piped stderr must receive no escape codes");
  assert.ok(
    runDie({ FORCE_COLOR: "1" }).stderr.includes(`${ESC}[0;31m`),
    "an explicit opt-in must still colour the error"
  );
});
