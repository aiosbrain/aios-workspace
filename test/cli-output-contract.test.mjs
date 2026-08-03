// test/cli-output-contract.test.mjs
//
// Executable half of docs/cli-output-contract.md — the machine-readable lines in the AIOS
// CLI whose exact bytes, stream, line shape or ordering are load-bearing.
//
// This exists because a rendering change (colour, glyphs, a live region, a progress rail,
// a celebration that "collapses to a static line on completion") is harmless for human
// prose and catastrophic for these. It is a PRECONDITION for the GRAIN writer facade, not
// a follow-up: the facade cannot be shown to preserve a contract that was never written
// down.
//
// Two directions, and conflating them is the easy mistake:
//   Class E — EMITTED by AIOS for an external consumer (a hook, CI, an operator's grep).
//   Class D — DETECTED by AIOS from a subprocess/reviewer model's captured output.
//
// The Class-D detectors are exercised through their REAL exported implementations, so this
// file cannot drift into testing a copy of the rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MERGE_READY_TOKEN, PLAN_READY_TOKEN } from "../scripts/relay-core.mjs";
import {
  BUGBOT_CLEAR_TOKEN,
  BUGBOT_BLOCKED_TOKEN,
  BUGBOT_CLEAR_MARKER,
  BUGBOT_BLOCKED_MARKER,
  detectBugbotClear,
  detectBugbotBlocked,
} from "../scripts/review-bugbot.mjs";
import {
  SIMPLIFY_DONE_TOKEN,
  SIMPLIFY_NOOP_TOKEN,
  detectSimplifyToken,
} from "../scripts/simplify.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Class E: the emitted markers, byte for byte ─────────────────────────────

test("E: the hook-protocol markers have their exact documented literals", () => {
  // hooks/local-bugbot-gate.mjs greps for these. A whitespace change breaks the gate
  // silently — it would read as "no verdict", not as an error.
  assert.equal(BUGBOT_CLEAR_MARKER, "AIOS_BUGBOT_RESULT=clear");
  assert.equal(BUGBOT_BLOCKED_MARKER, "AIOS_BUGBOT_RESULT=blocked");
});

test("E: hook-protocol markers are a single line with no leading/trailing space", () => {
  for (const marker of [BUGBOT_CLEAR_MARKER, BUGBOT_BLOCKED_MARKER]) {
    assert.ok(!marker.includes("\n"), `${marker} must be one line`);
    assert.equal(marker, marker.trim(), `${marker} must not be padded`);
    assert.match(marker, /^AIOS_BUGBOT_RESULT=(clear|blocked)$/);
  }
});

test("E: the two hook-protocol markers are distinguishable, not prefixes of each other", () => {
  // A consumer doing a substring match must not read "clear" inside "blocked" or vice versa.
  assert.notEqual(BUGBOT_CLEAR_MARKER, BUGBOT_BLOCKED_MARKER);
  assert.ok(!BUGBOT_BLOCKED_MARKER.includes(BUGBOT_CLEAR_MARKER));
  assert.ok(!BUGBOT_CLEAR_MARKER.includes(BUGBOT_BLOCKED_MARKER));
});

test("E: the real leak gate preserves marker line shape and exit codes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-contract-leak-"));
  const terms = path.join(dir, "terms.sh");
  const source = path.join(dir, "source.txt");
  const gate = path.join(REPO, "scripts", "leak-gate.sh");
  const term = "contract" + "-secret";
  const run = (env) =>
    spawnSync("bash", [gate, source], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  const lastLine = (text) =>
    String(text)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

  try {
    writeFileSync(terms, `STRONG='${term}'\nWORDS=''\nPATTERNS=''\n`);
    writeFileSync(source, "ordinary content\n");
    const clean = run({ AIOS_LEAK_TERMS_FILE: terms });
    assert.equal(clean.status, 0);
    assert.match(lastLine(clean.stdout), /^leak-gate: CLEAN\b/);

    writeFileSync(source, `contains ${term}\n`);
    const blocked = run({ AIOS_LEAK_TERMS_FILE: terms });
    assert.equal(blocked.status, 1);
    assert.match(lastLine(blocked.stdout), /^leak-gate: FAILED\b/);

    const absent = path.join(dir, "absent-terms.sh");
    const skipped = run({ AIOS_LEAK_TERMS_FILE: absent, AIOS_LEAK_TERMS_B64: "" });
    assert.equal(skipped.status, 0);
    assert.match(lastLine(skipped.stdout), /^leak-gate: SKIPPED\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Class D: the detection dialect, via the real detectors ──────────────────

// Class-D detectors intentionally use different dialects. These cases pin each dialect
// against the shipped implementation instead of testing a copied, over-generalised rule.

const REVIEW_PREAMBLE = "I reviewed the diff.\n\nLooks fine to me.\n";

test("D: detectSimplifyToken uses the same dialect for both of its tokens", () => {
  assert.equal(detectSimplifyToken(`${REVIEW_PREAMBLE}${SIMPLIFY_DONE_TOKEN}`), "done");
  assert.equal(detectSimplifyToken(`${REVIEW_PREAMBLE}${SIMPLIFY_NOOP_TOKEN}`), "noop");
  assert.equal(detectSimplifyToken(`${SIMPLIFY_DONE_TOKEN} — tidied 3 files`), "done");
  assert.equal(detectSimplifyToken(`${SIMPLIFY_DONE_TOKEN}\ntrailing line`), null);
  assert.equal(detectSimplifyToken("no token here"), null);
  assert.equal(detectSimplifyToken(""), null);
  assert.equal(detectSimplifyToken(null), null, "must tolerate a null capture");
});

test("D: Bugbot CLEAR accepts only pure token repetitions across the whole capture", () => {
  assert.equal(detectBugbotClear(BUGBOT_CLEAR_TOKEN), true);
  assert.equal(detectBugbotClear(` ${BUGBOT_CLEAR_TOKEN} \n${BUGBOT_CLEAR_TOKEN}`), true);
  assert.equal(detectBugbotClear(`${BUGBOT_CLEAR_TOKEN}${BUGBOT_CLEAR_TOKEN}`), true);
  assert.equal(detectBugbotClear(`None.\n${BUGBOT_CLEAR_TOKEN}`), false, "prose is a hedge");
  assert.equal(detectBugbotClear(`${BUGBOT_CLEAR_TOKEN}\n✓ done`), false);
  assert.equal(detectBugbotClear(null), false);
});

test("D: Bugbot BLOCKED requires the entire trimmed capture to be exactly the token", () => {
  assert.equal(detectBugbotBlocked(BUGBOT_BLOCKED_TOKEN), true);
  assert.equal(detectBugbotBlocked(` \n${BUGBOT_BLOCKED_TOKEN}\n `), true);
  assert.equal(detectBugbotBlocked(`finding\n${BUGBOT_BLOCKED_TOKEN}`), false);
  assert.equal(detectBugbotBlocked(`${BUGBOT_BLOCKED_TOKEN}\n✓ done`), false);
  assert.equal(detectBugbotBlocked(null), false);
});

test("D: decoration in a captured verdict stream breaks each detector", () => {
  // Placement depends on the detector: after the token for last-line detection, anywhere
  // in the whole capture for Bugbot's all-lines / whole-capture dialects.
  // detectMergeToken/detectSafetyToken are devtools-owned (build.mjs / ship.mjs) and assert
  // the same property in aios-devtools — core cannot import them without recreating the
  // coupling the split removes (AIO-662).
  const decoration = "\n      ▞  review      done · 4.2s";
  assert.equal(detectSimplifyToken(`${SIMPLIFY_DONE_TOKEN}${decoration}`), null);
  assert.equal(detectBugbotClear(`${BUGBOT_CLEAR_TOKEN}${decoration}`), false);
  assert.equal(detectBugbotBlocked(`${BUGBOT_BLOCKED_TOKEN}${decoration}`), false);
});

test("D: an ANSI-wrapped token is NOT detected — markers must be written raw", () => {
  // Proves markers cannot be routed through a colour helper. Devtools asserts the same for
  // its own two detectors (AIO-662).
  const wrap = (s) => `\x1b[0;32m${s}\x1b[0m`;
  assert.equal(detectSimplifyToken(wrap(SIMPLIFY_DONE_TOKEN)), null);
  assert.equal(detectBugbotClear(wrap(BUGBOT_CLEAR_TOKEN)), false);
  assert.equal(detectBugbotBlocked(wrap(BUGBOT_BLOCKED_TOKEN)), false);
});

// ── token literals ──────────────────────────────────────────────────────────

test("token literals match the contract document", () => {
  assert.equal(MERGE_READY_TOKEN, "MERGE_READY");
  assert.equal(PLAN_READY_TOKEN, "PLAN_READY");
  assert.equal(SIMPLIFY_DONE_TOKEN, "SIMPLIFY_DONE");
  assert.equal(SIMPLIFY_NOOP_TOKEN, "SIMPLIFY_NOOP");
  assert.equal(BUGBOT_CLEAR_TOKEN, "BUGBOT_CLEAR");
  assert.equal(BUGBOT_BLOCKED_TOKEN, "BUGBOT_BLOCKED");
});

test("no Class-D token is a prefix of another (substring matching stays unambiguous)", () => {
  const tokens = [
    MERGE_READY_TOKEN,
    PLAN_READY_TOKEN,
    SIMPLIFY_DONE_TOKEN,
    SIMPLIFY_NOOP_TOKEN,
    BUGBOT_CLEAR_TOKEN,
    BUGBOT_BLOCKED_TOKEN,
  ];
  for (const a of tokens) {
    for (const b of tokens) {
      if (a === b) continue;
      assert.ok(!a.startsWith(b), `${a} must not start with ${b}`);
    }
  }
});
