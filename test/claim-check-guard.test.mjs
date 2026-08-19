// Claim-check Stop hook — asserts it warns on an unevidenced claim, stays silent when the message
// shows its work, and NEVER disturbs a session (always exit 0, no stdout) on malformed input.
//
// The false-positive cases are the point of this file. This hook fires on every Stop in every
// scaffolded workspace, so a guard that cries wolf gets switched off and stops guarding anything.
// Each "stays silent" case below is a real phrasing that the first version of the regex fired on.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "hooks", "claim-check-guard.mjs");

function entry(text, type = "assistant") {
  return JSON.stringify({
    type,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/** Runs the hook and returns its stdout. Throws if it ever exits non-zero. */
function run(input) {
  const out = execFileSync("node", [HOOK], { input, stdio: ["pipe", "pipe", "pipe"] });
  return out.toString("utf8");
}

/** Writes a transcript of raw JSONL lines and runs the hook against it. */
function runTranscript(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), "claim-check-"));
  const file = path.join(dir, "transcript.jsonl");
  writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""));
  return run(JSON.stringify({ transcript_path: file }));
}

const warnsOn = (text) => runTranscript([entry(text)]);

test("warns on a claim with no measurement in the message", () => {
  const out = warnsOn("The graph is fully extracted and it works now.");
  const parsed = JSON.parse(out);
  assert.match(parsed.systemMessage, /claim-check/);
  assert.match(parsed.systemMessage, /fully extracted/);
  assert.match(parsed.systemMessage, /check-claim/);
});

test("warns on 'no new failures, so the fix is resolved' — absence of errors is not evidence", () => {
  assert.match(
    JSON.parse(warnsOn("There are no new failures, so the fix is resolved.")).systemMessage,
    /is resolved/
  );
});

test("warns on plain completion idioms that assert without measuring", () => {
  for (const text of [
    "All set.",
    "Good to go.",
    "Should be good now.",
    "The fix is in.",
    "Works as expected.",
  ]) {
    assert.notEqual(warnsOn(text), "", `expected a warning for: ${text}`);
  }
});

test("stays silent when the message shows its work", () => {
  const evidenced = [
    "tasks = 9, decisions = 3 on the deployed database. Measured before (0/0) and after.",
    "Answering returned HTTP 200 in 19.8s with the right citations.",
    "It works now:\n```\n$ npm test\n```",
    "Verified — 12 rows written.",
  ];
  for (const text of evidenced) assert.equal(warnsOn(text), "", `expected silence for: ${text}`);
});

test("stays silent on statements of intent", () => {
  assert.equal(warnsOn("I'm going to fix the interval next."), "");
});

test("stays silent on hedged, negated, or conditional uses of claim words", () => {
  const notClaims = [
    "I have not verified this yet.",
    "I'm not confident this is resolved and it needs another look.",
    "Let me know if the behaviour is resolved on your side.",
    "Once you've confirmed the credentials I'll continue.",
    "I'll check whether the caching issue is resolved upstream.",
  ];
  for (const text of notClaims) assert.equal(warnsOn(text), "", `expected silence for: ${text}`);
});

test("stays silent on ordinary prose that merely contains claim vocabulary", () => {
  const benign = [
    "I resolved the merge conflict and pushed the branch.",
    "The import path resolved to node_modules/foo.",
    "The promise resolved before the timeout.",
    "Confirmed with John that the deadline is Friday.",
    "The ticket is marked resolved in Linear.",
    "Two verified CLEAR verdicts are on the PR thread.",
    "Worktree confirmed unchanged and clean at a1d47e5.",
  ];
  for (const text of benign) assert.equal(warnsOn(text), "", `expected silence for: ${text}`);
});

test("never disturbs a session on malformed or missing input", () => {
  assert.equal(run(""), "");
  assert.equal(run("not json at all"), "");
  assert.equal(run("{}"), ""); // no transcript_path
  assert.equal(run(JSON.stringify({ transcript_path: "/nope/nope.jsonl" })), "");
  assert.equal(runTranscript([]), ""); // empty transcript
  assert.equal(runTranscript(["{{{ truncated"]), ""); // unparseable throughout
  assert.equal(runTranscript([JSON.stringify({ type: "assistant" })]), ""); // no message key
  assert.equal(
    runTranscript([JSON.stringify({ type: "assistant", message: { content: null } })]),
    ""
  );
});

test("ignores a trailing assistant entry with no text blocks, and user messages", () => {
  const toolUse = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }],
    },
  });
  // Falls back past the tool_use turn to the last message that actually had text.
  assert.notEqual(runTranscript([entry("it works"), toolUse]), "");
  // A user message making the claim is not the assistant's claim.
  assert.equal(
    runTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: "it works right?" } }),
    ]),
    ""
  );
});

test("reads the tail of a large transcript rather than the whole file", () => {
  const pad = Array.from({ length: 600 }, (_, i) => entry(`padding ${i} ` + "x".repeat(400)));
  assert.notEqual(runTranscript([...pad, entry("The migration is fixed.")]), "");
});
