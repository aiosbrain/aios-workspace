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

import { MERGE_READY_TOKEN, PLAN_READY_TOKEN } from "../scripts/relay-core.mjs";
import {
  BUGBOT_CLEAR_TOKEN,
  BUGBOT_BLOCKED_TOKEN,
  BUGBOT_CLEAR_MARKER,
  BUGBOT_BLOCKED_MARKER,
} from "../scripts/review-bugbot.mjs";
import {
  SIMPLIFY_DONE_TOKEN,
  SIMPLIFY_NOOP_TOKEN,
  detectSimplifyToken,
} from "../scripts/simplify.mjs";
import { detectMergeToken } from "../scripts/build.mjs";
import { SAFETY_APPROVED_TOKEN, detectSafetyToken } from "../scripts/ship.mjs";

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

// ── Class D: the detection dialect, via the real detectors ──────────────────

// Every Class-D detector reads the LAST NON-BLANK line, trimmed, anchored at line start.
// These cases pin that dialect against the shipped implementations.

const REVIEW_PREAMBLE = "I reviewed the diff.\n\nLooks fine to me.\n";

test("D: detectMergeToken accepts the token on the last non-blank line", () => {
  assert.equal(detectMergeToken(`${REVIEW_PREAMBLE}${MERGE_READY_TOKEN}`), true);
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN}\n\n  \n`), true, "trailing blanks ok");
  assert.equal(detectMergeToken(`  ${MERGE_READY_TOKEN}  `), true, "surrounding space ok");
});

test("D: detectMergeToken tolerates glued trailing prose but requires a word boundary", () => {
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN} - lgtm`), true, "streaming artifact");
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN}_SOMETHING_ELSE`), false, "no boundary");
});

test("D: detectMergeToken rejects the token anywhere but the last line", () => {
  // This is the whole hazard: anything appended AFTER the verdict destroys it.
  assert.equal(
    detectMergeToken(`${MERGE_READY_TOKEN}\nnow running cleanup...`),
    false,
    "a line appended after the verdict must break detection"
  );
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN}\n✓ done in 4.2s`), false);
});

test("D: detectSimplifyToken uses the same dialect for both of its tokens", () => {
  assert.equal(detectSimplifyToken(`${REVIEW_PREAMBLE}${SIMPLIFY_DONE_TOKEN}`), "done");
  assert.equal(detectSimplifyToken(`${REVIEW_PREAMBLE}${SIMPLIFY_NOOP_TOKEN}`), "noop");
  assert.equal(detectSimplifyToken(`${SIMPLIFY_DONE_TOKEN} — tidied 3 files`), "done");
  assert.equal(detectSimplifyToken(`${SIMPLIFY_DONE_TOKEN}\ntrailing line`), null);
  assert.equal(detectSimplifyToken("no token here"), null);
  assert.equal(detectSimplifyToken(""), null);
  assert.equal(detectSimplifyToken(null), null, "must tolerate a null capture");
});

test("D: detectSafetyToken requires STRICT equality — the most fragile detector", () => {
  assert.equal(detectSafetyToken(`${REVIEW_PREAMBLE}${SAFETY_APPROVED_TOKEN}`), true);
  assert.equal(detectSafetyToken(`  ${SAFETY_APPROVED_TOKEN}  `), true, "trim only");

  // Unlike detectMergeToken, NOTHING may be glued on. A single trailing character —
  // a space-separated word, a glyph, a reset sequence — turns approval into refusal.
  assert.equal(detectSafetyToken(`${SAFETY_APPROVED_TOKEN} - looks good`), false);
  assert.equal(detectSafetyToken(`${SAFETY_APPROVED_TOKEN}.`), false);
  assert.equal(detectSafetyToken(`${SAFETY_APPROVED_TOKEN}[0m`), false, "a reset breaks it");
  assert.equal(detectSafetyToken(null), false);
});

test("D: a decoration appended to a captured stream breaks EVERY Class-D detector", () => {
  // The single rule the GRAIN writer facade must obey, stated as a test: never write to a
  // stream that is being captured for token detection. A live region that collapses to a
  // static line on completion would land exactly here.
  const decoration = "\n      ▞  review      done · 4.2s";
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN}${decoration}`), false);
  assert.equal(detectSimplifyToken(`${SIMPLIFY_DONE_TOKEN}${decoration}`), null);
  assert.equal(detectSafetyToken(`${SAFETY_APPROVED_TOKEN}${decoration}`), false);
});

test("D: an ANSI-wrapped token is NOT detected — markers must be written raw", () => {
  // Proves markers cannot be routed through a colour helper.
  const wrap = (s) => `[0;32m${s}[0m`;
  assert.equal(detectMergeToken(wrap(MERGE_READY_TOKEN)), false);
  assert.equal(detectSafetyToken(wrap(SAFETY_APPROVED_TOKEN)), false);
  assert.equal(detectSimplifyToken(wrap(SIMPLIFY_DONE_TOKEN)), null);
});

// ── token literals ──────────────────────────────────────────────────────────

test("token literals match the contract document", () => {
  assert.equal(MERGE_READY_TOKEN, "MERGE_READY");
  assert.equal(PLAN_READY_TOKEN, "PLAN_READY");
  assert.equal(SIMPLIFY_DONE_TOKEN, "SIMPLIFY_DONE");
  assert.equal(SIMPLIFY_NOOP_TOKEN, "SIMPLIFY_NOOP");
  assert.equal(BUGBOT_CLEAR_TOKEN, "BUGBOT_CLEAR");
  assert.equal(BUGBOT_BLOCKED_TOKEN, "BUGBOT_BLOCKED");
  assert.equal(SAFETY_APPROVED_TOKEN, "SAFETY_APPROVED");
});

test("no Class-D token is a prefix of another (substring matching stays unambiguous)", () => {
  const tokens = [
    MERGE_READY_TOKEN,
    PLAN_READY_TOKEN,
    SIMPLIFY_DONE_TOKEN,
    SIMPLIFY_NOOP_TOKEN,
    BUGBOT_CLEAR_TOKEN,
    BUGBOT_BLOCKED_TOKEN,
    SAFETY_APPROVED_TOKEN,
  ];
  for (const a of tokens) {
    for (const b of tokens) {
      if (a === b) continue;
      assert.ok(!a.startsWith(b), `${a} must not start with ${b}`);
    }
  }
});
