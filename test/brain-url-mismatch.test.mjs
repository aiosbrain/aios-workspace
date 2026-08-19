// test/brain-url-mismatch.test.mjs
//
// The `aios status` / `aios push` brain-URL guard: `AIOS_BRAIN_URL` silently overrides
// `aios.yaml`'s `brain_url`, and a DISAGREEMENT between the two means one of them is not the
// brain the operator meant. These tests exist because the guard's whole value is its false-positive
// rate: a warning that fires on a trailing slash or a capitalised hostname is one operators learn
// to scroll past, at which point it stops protecting the real case (a stray export from another
// workspace's direnv silently pushing content into someone else's brain).
//
// `statusJson` is covered here too. It was extracted from `cmdStatus` on the explicit argument
// that it is a machine-readable interface "nobody notices they are changing" — an argument that
// only holds if something actually locks the shape.
//
// Zero-dep, no network, no filesystem. Run: node --test test/brain-url-mismatch.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBrainUrl,
  detectBrainUrlMismatch,
  brainUrlMismatchWarning,
  warnBrainUrlMismatch,
} from "../scripts/brain-config.mjs";
import { statusJson } from "../scripts/status-json.mjs";

const A = "https://brain.example.com";

// ── detectBrainUrlMismatch: differences that CANNOT change which brain is addressed ──────

test("agreeing URLs never warn, however they are spelled", () => {
  const same = [
    ["identical", A, A],
    ["trailing slash on the env value", A, `${A}/`],
    ["trailing slash on the yaml value", `${A}/`, A],
    ["several trailing slashes", A, `${A}///`],
    ["surrounding whitespace", `  ${A}  `, A],
    ["whitespace and a trailing slash together", ` ${A}/ `, A],
    ["a doubled path separator", `${A}//api`, `${A}/api`],
    ["a doubled separator mid-path", `${A}/a//b`, `${A}/a/b`],
    ["a trailing slash after a path", `${A}/api/`, `${A}/api`],
    ["host case (hostnames are case-insensitive)", "https://Brain.Example.COM", A],
    ["scheme case", "HTTPS://brain.example.com", A],
    ["host case plus a trailing slash", "https://BRAIN.example.com/", A],
    ["an explicit default port", "https://brain.example.com:443", A],
  ];
  for (const [label, declared, effective] of same) {
    assert.equal(detectBrainUrlMismatch(declared, effective), null, label);
  }
});

// ── detectBrainUrlMismatch: differences that DO change which brain is addressed ──────────

test("genuinely different URLs warn", () => {
  const different = [
    ["a different host", A, "https://other.example.com"],
    ["a sibling host one character apart", A, "https://brainn.example.com"],
    ["a different path", `${A}/api`, `${A}/v2`],
    ["a path present on one side only", A, `${A}/api`],
    ["a different scheme", "http://brain.example.com", A],
    ["a non-default port", A, "https://brain.example.com:8443"],
    ["a different query string", `${A}?team=a`, `${A}?team=b`],
  ];
  for (const [label, declared, effective] of different) {
    assert.deepEqual(detectBrainUrlMismatch(declared, effective), { declared, effective }, label);
  }
});

test("the PATH stays case-sensitive — only the host is folded", () => {
  // The bug this guards: fixing the host-case false positive by lower-casing the whole URL
  // would silence a real mismatch, because RFC 3986 makes only scheme + host case-insensitive.
  assert.deepEqual(detectBrainUrlMismatch(`${A}/Api`, `${A}/api`), {
    declared: `${A}/Api`,
    effective: `${A}/api`,
  });
});

test("the reported pair is the operator's ORIGINAL text, not the normalised form", () => {
  // The operator has to recognise the string well enough to go and find where it is set.
  const declared = "  https://Brain.Example.com/api/  ";
  const effective = "https://other.example.com";
  assert.deepEqual(detectBrainUrlMismatch(declared, effective), { declared, effective });
});

// ── detectBrainUrlMismatch: silence when there is nothing to compare ─────────────────────

test("one side missing is not a mismatch — silent when the env var is unset", () => {
  // The overwhelmingly common case: aios.yaml declares a brain, no AIOS_BRAIN_URL anywhere.
  // Warning here would fire on every command in every healthy workspace.
  for (const absent of ["", "   ", undefined, null]) {
    assert.equal(detectBrainUrlMismatch(A, absent), null, `effective=${JSON.stringify(absent)}`);
    assert.equal(detectBrainUrlMismatch(absent, A), null, `declared=${JSON.stringify(absent)}`);
  }
  assert.equal(detectBrainUrlMismatch("", ""), null);
  assert.equal(detectBrainUrlMismatch(undefined, undefined), null);
});

// ── normalizeBrainUrl: the scheme-less fallback ──────────────────────────────────────────

test("normalizeBrainUrl trims and strips trailing slashes", () => {
  assert.equal(normalizeBrainUrl(`  ${A}//  `), A);
  assert.equal(normalizeBrainUrl(""), "");
  assert.equal(normalizeBrainUrl(undefined), "");
  assert.equal(normalizeBrainUrl(null), "");
});

test("a value with no scheme keeps its case rather than guessing where the host ends", () => {
  // `new URL` cannot parse it, so there is no way to tell host from path. Folding case would
  // risk silencing a real path difference; the conservative answer is to compare as written.
  assert.equal(normalizeBrainUrl("Brain.Example.com/"), "Brain.Example.com");
  assert.deepEqual(detectBrainUrlMismatch("Brain.example.com", "brain.example.com"), {
    declared: "Brain.example.com",
    effective: "brain.example.com",
  });
  // ...but the differences that are unambiguous are still removed.
  assert.equal(detectBrainUrlMismatch(" brain.example.com/ ", "brain.example.com"), null);
});

// ── the message ─────────────────────────────────────────────────────────────────────────

test("no message when there is no mismatch", () => {
  assert.equal(brainUrlMismatchWarning(null), "");
  assert.equal(brainUrlMismatchWarning(undefined), "");
});

test("the message names both URLs and which one is actually in use", () => {
  const msg = brainUrlMismatchWarning({ declared: A, effective: "https://other.example.com" });
  assert.match(msg, /brain URL mismatch/);
  assert.ok(msg.includes(A), "names the aios.yaml value");
  assert.ok(msg.includes("https://other.example.com"), "names the env value");
  assert.match(msg, /environment wins/, "says which one the command is talking to");
});

test("the remedy covers every source the value can come from, not just the shell", () => {
  // `envGet` reads AIOS_BRAIN_URL from process.env, the workspace .env, OR the toolkit .env.
  // "unset AIOS_BRAIN_URL" is advice that works for one of those three: an operator whose value
  // comes from a .env would unset a shell variable that was never set, see the warning survive,
  // and reasonably conclude the guard is broken.
  const msg = brainUrlMismatchWarning({ declared: A, effective: "https://other.example.com" });
  assert.doesNotMatch(msg, /\bunset AIOS_BRAIN_URL\b/);
  assert.match(msg, /\.env/, "points at the .env files");
  assert.match(msg, /shell/, "points at the shell");
  assert.match(msg, /toolkit/, "points at the toolkit .env");
});

// ── warnBrainUrlMismatch ────────────────────────────────────────────────────────────────

test("warnBrainUrlMismatch says nothing when the config is clean", () => {
  const lines = [];
  const log = (l) => lines.push(l);
  warnBrainUrlMismatch({ brain_url_mismatch: null }, { log });
  warnBrainUrlMismatch({}, { log });
  warnBrainUrlMismatch(null, { log });
  warnBrainUrlMismatch(undefined, { log });
  assert.deepEqual(lines, []);
});

test("warnBrainUrlMismatch emits exactly one colorized line for a mismatch", () => {
  const lines = [];
  warnBrainUrlMismatch(
    { brain_url_mismatch: { declared: A, effective: "https://other.example.com" } },
    { log: (l) => lines.push(l), colorize: (s) => `<y>${s}</y>` }
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^<y>.*<\/y>$/);
  assert.match(lines[0], /brain URL mismatch/);
});

test("the default sink is stderr, so --json/--porcelain stdout stays a clean payload", () => {
  // docs/cli-output-contract.md §3: under a machine-readable flag stdout carries the payload and
  // nothing else. cmdStatus warns ahead of both early returns, which is only safe because of this.
  const realError = console.error;
  const realLog = console.log;
  const err = [];
  const out = [];
  console.error = (l) => err.push(l);
  console.log = (l) => out.push(l);
  try {
    warnBrainUrlMismatch({
      brain_url_mismatch: { declared: A, effective: "https://other.example.com" },
    });
  } finally {
    console.error = realError;
    console.log = realLog;
  }
  assert.equal(err.length, 1);
  assert.deepEqual(out, []);
});

// ── statusJson: the shape is the contract ───────────────────────────────────────────────

const PLAN = {
  push: [
    { rel: "2-work/a.md", kind: "deliverable", tier: "team", isNew: true },
    { rel: "2-work/b.md", kind: "deliverable", tier: "team", isNew: false },
  ],
  blocked: [{ rel: "5-personal/x.md", reason: "tier admin" }],
  clean: [{ rel: "0-context/charter.md" }],
};

function cfg(extra = {}) {
  return { project: "demo", brain_url: A, ...extra };
}

test("statusJson emits exactly the documented top-level keys, in order", () => {
  // Order, not just membership: the payload is read by humans debugging a sync as often as by
  // scripts, and a silently reshuffled object makes every diff of a captured payload noise.
  const out = statusJson(cfg(), PLAN, false);
  assert.deepEqual(Object.keys(out), [
    "project",
    "brain_url",
    "brain_url_mismatch",
    "items",
    "loop_critical_blocked",
  ]);
  assert.deepEqual(Object.keys(out.items), ["new", "modified", "blocked", "clean"]);
});

test("loop_critical_blocked is passed straight through, whatever its producer returns", () => {
  // statusJson takes it as a VALUE rather than importing its producer (that would be circular),
  // so this module must not assume a shape. Today it is an array of paths; it has been a boolean.
  for (const value of [false, true, [], ["3-log/decision-log.md"]]) {
    assert.deepEqual(statusJson(cfg(), PLAN, value).loop_critical_blocked, value);
  }
});

test("statusJson partitions the plan and shapes each item", () => {
  const out = statusJson(cfg(), PLAN, true);
  assert.equal(out.project, "demo");
  assert.equal(out.brain_url, A);
  assert.deepEqual(out.items.new, [
    { rel: "2-work/a.md", kind: "deliverable", tier: "team", isNew: true },
  ]);
  assert.deepEqual(out.items.modified, [
    { rel: "2-work/b.md", kind: "deliverable", tier: "team", isNew: false },
  ]);
  assert.deepEqual(out.items.blocked, [{ rel: "5-personal/x.md", reason: "tier admin" }]);
  assert.deepEqual(out.items.clean, [{ rel: "0-context/charter.md" }]);
});

test("missing item fields become null, and isNew is always a boolean", () => {
  const plan = { push: [{ rel: "x.md" }], blocked: [], clean: [] };
  assert.deepEqual(statusJson(cfg(), plan, false).items.modified, [
    { rel: "x.md", kind: null, tier: null, isNew: false },
  ]);
});

test("an offline workspace reports brain_url as null, not an empty string", () => {
  assert.equal(statusJson(cfg({ brain_url: "" }), PLAN, false).brain_url, null);
});

test("brain_url_mismatch SURVIVES JSON.stringify even when the config never set it", () => {
  // The real hazard: JSON.stringify DROPS an undefined value, so `brain_url_mismatch: undefined`
  // would ship a payload with the key absent — indistinguishable, to a consumer, from an older
  // CLI that predates the field. Absent must mean "old CLI"; null must mean "checked, agreed".
  const roundTripped = JSON.parse(JSON.stringify(statusJson(cfg(), PLAN, false)));
  assert.ok("brain_url_mismatch" in roundTripped);
  assert.equal(roundTripped.brain_url_mismatch, null);
});

test("brain_url_mismatch carries the pair through unchanged when there is one", () => {
  const mismatch = { declared: A, effective: "https://other.example.com" };
  const out = JSON.parse(
    JSON.stringify(statusJson(cfg({ brain_url_mismatch: mismatch }), PLAN, false))
  );
  assert.deepEqual(out.brain_url_mismatch, mismatch);
});

test("the field is purely additive — every pre-existing key is untouched by a mismatch", () => {
  const clean = statusJson(cfg(), PLAN, false);
  const warned = statusJson(
    cfg({ brain_url_mismatch: { declared: A, effective: "https://other.example.com" } }),
    PLAN,
    false
  );
  for (const key of ["project", "brain_url", "items", "loop_critical_blocked"]) {
    assert.deepEqual(warned[key], clean[key], key);
  }
});
