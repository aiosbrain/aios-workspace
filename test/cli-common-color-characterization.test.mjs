// test/cli-common-color-characterization.test.mjs
//
// CHARACTERIZATION baseline for `c`, the ANSI colour helper in scripts/cli-common.mjs.
//
// `c` is imported by 29 files and is the single choke point for roughly 1,053 `console.*`
// calls across the CLI. A capability-aware replacement (GRAIN W0-4) will change how it
// behaves in pipes, under NO_COLOR, and when styles nest. This file pins what it does
// TODAY — including the two behaviours that are known to be WRONG — so that change lands
// as a reviewable diff against a recorded baseline instead of an unverifiable claim.
//
// Read the sections in this order:
//
//   A. THE FROZEN BYTES. The exact SGR sequences. These are the 16-colour rendering and
//      must survive W0-4 byte-for-byte on a colour-capable TTY, so a terminal that renders
//      AIOS today renders it identically after.
//   B. VALUE COERCION. What `c` does with non-strings.
//   C. NESTING — KNOWN WRONG. An inner reset terminates the outer style. W0-4 fixes this;
//      when it does, the assertions in this section MUST be updated in the same commit.
//   D. ENVIRONMENT — KNOWN WRONG. `c` ignores isTTY, NO_COLOR, FORCE_COLOR, CLICOLOR and
//      TERM=dumb, so escape codes leak into pipes, files and CI logs. W0-4 fixes this;
//      those assertions MUST be updated in the same commit.
//   E. RE-EXPORT IDENTITY. `relay-core.mjs` re-exports the same object; importers must not
//      be able to observe two different palettes.
//
// Sections C and D are deliberately asserted as-is rather than skipped. A characterization
// test that omits the broken behaviour cannot prove the fix changed anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { c } from "../scripts/cli-common.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_COMMON = path.join(REPO, "scripts", "cli-common.mjs");

const ESC = "\x1b";
const RESET = `${ESC}[0m`;

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
    { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }
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
  test(`A: c.${method} wraps in ${JSON.stringify(open)} … reset`, () => {
    assert.equal(c[method]("x"), `${open}x${RESET}`);
  });
}

test("A: every helper closes with a full reset, never a targeted off-code", () => {
  for (const method of Object.keys(FROZEN_SGR)) {
    assert.ok(c[method]("x").endsWith(RESET), `c.${method} must end with ${JSON.stringify(RESET)}`);
  }
});

// ── B. VALUE COERCION ───────────────────────────────────────────────────────

test("B: values are coerced by template interpolation, not validated", () => {
  assert.equal(c.red(""), `${ESC}[0;31m${RESET}`, "empty string still emits the wrapper");
  assert.equal(c.red(undefined), `${ESC}[0;31mundefined${RESET}`);
  assert.equal(c.red(null), `${ESC}[0;31mnull${RESET}`);
  assert.equal(c.red(0), `${ESC}[0;31m0${RESET}`, "0 must not be treated as falsy/empty");
  assert.equal(c.red(false), `${ESC}[0;31mfalse${RESET}`);
  assert.equal(c.red([1, 2]), `${ESC}[0;31m1,2${RESET}`);
  assert.equal(c.red({ a: 1 }), `${ESC}[0;31m[object Object]${RESET}`);
});

// ── C. NESTING — KNOWN WRONG ────────────────────────────────────────────────

test("C: KNOWN WRONG — a nested style's reset terminates the OUTER style", () => {
  // Everything after the inner reset renders unstyled. With ~345 c.dim() call sites and
  // nesting common in this CLI, this mis-renders in production today.
  //
  // W0-4 fixes it by re-opening the outer style after each nested reset. When it does,
  // this assertion must be updated in the same commit — that is the point of pinning it.
  assert.equal(
    c.dim(`a ${c.red("b")} c`),
    `${ESC}[2ma ${ESC}[0;31mb${RESET} c${RESET}`,
    "baseline: the trailing ' c' carries NO dim attribute"
  );

  const rendered = c.dim(`a ${c.red("b")} c`);
  const afterInnerReset = rendered.slice(rendered.indexOf(RESET) + RESET.length);
  assert.ok(
    !afterInnerReset.startsWith(`${ESC}[2m`),
    "baseline: dim is NOT re-opened after the nested reset"
  );
});

test("C: KNOWN WRONG — the same holds for bold wrapping a colour", () => {
  assert.equal(c.bold(`a ${c.green("b")} c`), `${ESC}[1ma ${ESC}[0;32mb${RESET} c${RESET}`);
});

// ── D. ENVIRONMENT — KNOWN WRONG ────────────────────────────────────────────

// Each case: a fresh process, stdout piped (so isTTY is false), under the named env.
// Today every one of these still emits escape codes.
const ENV_CASES = [
  ["a plain pipe (stdout is not a TTY)", {}],
  ["NO_COLOR=1", { NO_COLOR: "1" }],
  ["NO_COLOR= (empty — per spec must NOT disable)", { NO_COLOR: "" }],
  ["FORCE_COLOR=0", { FORCE_COLOR: "0" }],
  ["CLICOLOR=0", { CLICOLOR: "0" }],
  ["TERM=dumb", { TERM: "dumb" }],
  ["CI=true", { CI: "true" }],
];

for (const [label, env] of ENV_CASES) {
  test(`D: KNOWN WRONG — escape codes are emitted under ${label}`, () => {
    // W0-4 makes all of these except "NO_COLOR= (empty)" emit a bare "x". When it does,
    // this table becomes the expectation table for the new behaviour.
    assert.equal(
      renderInSubprocess("red", "x", env),
      `${ESC}[0;31mx${RESET}`,
      `baseline: c.red is insensitive to ${label}`
    );
  });
}

test("D: KNOWN WRONG — `c` reads no environment variable at all", () => {
  // The stronger statement behind the table above: the implementation is a pure function
  // of its argument. Recording it here makes the W0-4 diff unambiguous.
  const src = String(c.red);
  for (const name of ["process", "env", "isTTY", "NO_COLOR", "FORCE_COLOR"]) {
    assert.ok(!src.includes(name), `baseline: c.red must not reference ${name}; got ${src}`);
  }
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

test("E: `die` writes a red error to stderr and exits non-zero", () => {
  const src = `import(${JSON.stringify(CLI_COMMON)}).then(({die}) => die("boom"))`;
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", src], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    status = e.status;
    stderr = e.stderr ?? "";
  }
  assert.equal(status, 1, "die must exit 1");
  assert.match(stderr, /error: boom/, "die must prefix with 'error: '");
  assert.ok(stderr.includes(`${ESC}[0;31m`), "baseline: die colours stderr unconditionally");
});
