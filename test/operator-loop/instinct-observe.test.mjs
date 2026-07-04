// Instinct observe hook (AIO-229 / AM4a) — spawns hooks/instinct-observe.mjs with realistic Stop
// payloads and synthetic transcript JSONL fixtures, then folds the hook-written store through
// foldObservations (plain source — no dist needed) to prove one observation per correction turn.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldObservations, OBS_STORE_REL, sha256 } from "../../scripts/analyze/maturity-store.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = path.join(ROOT, "hooks", "instinct-observe.mjs");

function ws() {
  return mkdtempSync(path.join(tmpdir(), "instinct-observe-"));
}

function runHook(dir, payload, { rawInput } = {}) {
  const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
  try {
    execFileSync("node", [HOOK], {
      input,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

function storeText(dir) {
  const p = path.join(dir, OBS_STORE_REL);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function readObs(dir) {
  const { dedupeKeys } = foldObservations(storeText(dir));
  return dedupeKeys;
}

// A realistic transcript: an assistant turn (with tool_use/thinking noise) followed by the
// user's correcting reply as the final line.
function transcript(dir, assistantTail, userText) {
  const p = path.join(dir, "transcript.jsonl");
  const lines = [
    { type: "user", message: { content: "please do the thing" } },
    { type: "progress", data: {} },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "tool_use", name: "Bash", input: {} },
          { type: "text", text: assistantTail },
        ],
      },
    },
    { type: "tool_result", content: "ok" },
    { type: "user", message: { content: userText } },
  ];
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

test("hook file: executable bit set + node shebang", () => {
  assert.ok(statSync(HOOK).mode & 0o111, "hooks/instinct-observe.mjs is executable");
  assert.equal(readFileSync(HOOK, "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("Stop (no-branch correction) → one observation w/ correct prior_hash + capped snippet", () => {
  const dir = ws();
  try {
    const tp = transcript(
      dir,
      "I wrote a new YAML parser for this.",
      "no - use the existing helper in flat-yaml.mjs " + "x".repeat(400)
    );
    const code = runHook(dir, { hook_event_name: "Stop", session_id: "s1", transcript_path: tp });
    assert.equal(code, 0);
    const { dedupeKeys, warnings } = foldObservations(storeText(dir));
    assert.equal(warnings, 0);
    assert.equal(dedupeKeys.size, 1);
    const raw = storeText(dir).trim();
    const { obs } = JSON.parse(raw);
    assert.equal(obs.kind, "correction");
    assert.equal(obs.tier, "admin");
    assert.equal(obs.session_id, "s1");
    assert.ok(obs.snippet.length <= 280, "snippet capped at 280 chars");
    assert.match(obs.snippet, /^no - use the existing helper in flat-yaml\.mjs/);
    assert.equal(obs.prior_hash, sha256("I wrote a new YAML parser for this."));
    assert.equal(
      [...dedupeKeys][0],
      sha256(`${obs.session_id}|${obs.prior_hash}`),
      "dedupe key is sha256(session_id|prior_hash)"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop (benign phrasing) → nothing", () => {
  const benign = [
    "sounds good",
    "yes do that",
    "can you also add tests?",
    "what about the edge case?",
    "thanks next let's move to the other file",
    "no worries",
    "no problem",
    "no rush",
    "no thanks",
    "no thank you",
    "no need",
    "no, thanks",
    "nope",
  ];
  for (const phrase of benign) {
    const dir = ws();
    try {
      const tp = transcript(dir, "Here is what I did.", phrase);
      const code = runHook(dir, {
        hook_event_name: "Stop",
        session_id: "s2",
        transcript_path: tp,
      });
      assert.equal(code, 0);
      assert.equal(existsSync(path.join(dir, OBS_STORE_REL)), false, `phrase: "${phrase}"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Stop (said-again correction) → one observation", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, "I added a custom parser.", "I already told you to use flat-yaml.mjs");
    const code = runHook(dir, { hook_event_name: "Stop", session_id: "s-said", transcript_path: tp });
    assert.equal(code, 0);
    assert.equal(readObs(dir).size, 1);
    const { obs } = JSON.parse(storeText(dir).trim());
    assert.match(obs.snippet, /already told you/i);
    assert.equal(obs.prior_hash, sha256("I added a custom parser."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop (actually/instead correction) → one observation", () => {
  const dir = ws();
  try {
    const tp = transcript(
      dir,
      "I'll wire a new YAML loader.",
      "actually, use the shared utility in flat-yaml.mjs instead"
    );
    const code = runHook(dir, {
      hook_event_name: "Stop",
      session_id: "s-actually",
      transcript_path: tp,
    });
    assert.equal(code, 0);
    assert.equal(readObs(dir).size, 1);
    const { obs } = JSON.parse(storeText(dir).trim());
    assert.match(obs.snippet, /use the shared utility/i);
    assert.equal(obs.prior_hash, sha256("I'll wire a new YAML loader."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop (re-fired same payload) → no duplicate", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, "Done.", "actually, use the shared utility instead");
    const payload = { hook_event_name: "Stop", session_id: "s3", transcript_path: tp };
    runHook(dir, payload);
    runHook(dir, payload);
    assert.equal(readObs(dir).size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop with stop_hook_active → nothing (no recursion)", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, "Done.", "no, that's wrong, revert it");
    const code = runHook(dir, {
      hook_event_name: "Stop",
      session_id: "s4",
      transcript_path: tp,
      stop_hook_active: true,
    });
    assert.equal(code, 0);
    assert.equal(existsSync(path.join(dir, OBS_STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("garbage stdin → exits 0, writes nothing", () => {
  const dir = ws();
  try {
    assert.equal(runHook(dir, null, { rawInput: "not json at all {{{" }), 0);
    assert.equal(existsSync(path.join(dir, OBS_STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing transcript_path → exits 0, writes nothing", () => {
  const dir = ws();
  try {
    const code = runHook(dir, { hook_event_name: "Stop", session_id: "s5" });
    assert.equal(code, 0);
    assert.equal(existsSync(path.join(dir, OBS_STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("held lockfile (stale reclaim window not yet elapsed) → exits 0, store unchanged", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, "Done.", "no - use the existing helper");
    const storeAbs = path.join(dir, OBS_STORE_REL);
    const lockPath = storeAbs + ".lock";
    mkdirSync(path.dirname(storeAbs), { recursive: true });
    // Pre-create a FRESH lock (mtime "now") so the hook's bounded retries expire before the
    // 30s stale-reclaim window opens — the hook must give up and exit 0 without writing.
    writeFileSync(lockPath, "999999 fake-token " + new Date().toISOString() + "\n", {
      flag: "wx",
    });
    try {
      const code = runHook(dir, {
        hook_event_name: "Stop",
        session_id: "s6",
        transcript_path: tp,
      });
      assert.equal(code, 0);
      assert.equal(existsSync(storeAbs), false, "store must remain unwritten while lock is held");
    } finally {
      rmSync(lockPath, { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
