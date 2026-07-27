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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { detectMergeToken } from "../scripts/build.mjs";
import { SAFETY_APPROVED_TOKEN, detectSafetyToken } from "../scripts/ship.mjs";
import { cmdConsolidateFindings } from "../scripts/consolidate-findings.mjs";

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

test("E: the real consolidator emits a final stdout verdict and returns its documented code", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-contract-consolidate-"));
  const localReview = path.join(dir, "local-bugbot.md");
  const out = path.join(dir, "findings.md");
  writeFileSync(localReview, `${BUGBOT_CLEAR_TOKEN}\n`);
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (line = "") => logs.push(String(line));
    const runGh = (args) => {
      if (args[0] === "pr" && args[1] === "checks") {
        return {
          code: 0,
          stdout: JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "diff") return "diff --git a/x b/x\n+ok\n";
      if (args[0] === "api" && args[1].endsWith("/commits")) {
        return JSON.stringify({ sha: "head123", committed_at: "2026-07-27T00:00:00Z" });
      }
      if (args[0] === "api") return "[]";
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
    const clearOutput = readFileSync(
      path.join(REPO, "test", "fixtures", "consolidate", "agent-clear.md"),
      "utf8"
    );
    const blockedOutput = readFileSync(
      path.join(REPO, "test", "fixtures", "consolidate", "agent-blocked.md"),
      "utf8"
    );
    const args = [
      "--pr",
      "423",
      "--issue",
      "AIO-423",
      "--repo",
      "acme/repo",
      "--local-bugbot-review",
      localReview,
      "--out",
      out,
    ];
    const deps = (modelOutput) => ({
      runGh,
      readReviewerPrompt: () => "Return a structured verdict.",
      callPromptModel: async () => modelOutput,
    });
    const code = await cmdConsolidateFindings(REPO, args, deps(clearOutput));

    assert.equal(code, 0);
    assert.equal(logs.at(-1), "VERDICT=CLEAR", "verdict must be the final stdout line");
    assert.ok(!logs.at(-1).includes("\u001b["), "verdict must not be styled");

    logs.length = 0;
    const blockedCode = await cmdConsolidateFindings(REPO, args, deps(blockedOutput));
    assert.equal(blockedCode, 3);
    assert.equal(logs.at(-1), "VERDICT=BLOCKED", "blocked verdict must be final on stdout");
    assert.ok(!logs.at(-1).includes("\u001b["), "blocked verdict must not be styled");
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(detectSafetyToken(`${SAFETY_APPROVED_TOKEN}\x1b[0m`), false, "a reset breaks it");
  assert.equal(detectSafetyToken(null), false);
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
  const decoration = "\n      ▞  review      done · 4.2s";
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN}${decoration}`), false);
  assert.equal(detectSimplifyToken(`${SIMPLIFY_DONE_TOKEN}${decoration}`), null);
  assert.equal(detectSafetyToken(`${SAFETY_APPROVED_TOKEN}${decoration}`), false);
  assert.equal(detectBugbotClear(`${BUGBOT_CLEAR_TOKEN}${decoration}`), false);
  assert.equal(detectBugbotBlocked(`${BUGBOT_BLOCKED_TOKEN}${decoration}`), false);
});

test("D: an ANSI-wrapped token is NOT detected — markers must be written raw", () => {
  // Proves markers cannot be routed through a colour helper.
  const wrap = (s) => `\x1b[0;32m${s}\x1b[0m`;
  assert.equal(detectMergeToken(wrap(MERGE_READY_TOKEN)), false);
  assert.equal(detectSafetyToken(wrap(SAFETY_APPROVED_TOKEN)), false);
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
