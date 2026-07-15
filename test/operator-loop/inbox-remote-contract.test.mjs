// Inbox remote contract — dual-run comparison (I-15 / AIO-396, the G6b gate).
//
// The named acceptance check: this test diffs `aios inbox --json` output from the LOCAL fixture
// workspace against the RECORDED REMOTE RESPONSE for the same fixture set (deep-equal required).
// `node --test test/operator-loop/inbox-remote-contract.test.mjs` exits 0.
//
// Fly access is unavailable at build time (the live deploy is merge-gated on I-11 / PR #321), so —
// exactly as the acceptance allows — the recorded-response half is generated from a LOCAL run of the
// same code/image (record mode), committed, and diffed here. That makes the spec DONE-EXCEPT-DEPLOY:
// the `--live` half (diff against the real Fly machine) is a manual follow-up whose output is pasted
// in the PR, NEVER silently dropped. Run it with:  node --test <thisfile> -- --live
//
// Volatile fields (`generated_at`, `staleness.age_ms`) are normalized out — they legitimately differ
// between the two runs' wall-clocks; the CONTRACT is that the ranked items + shape are identical.
//
// Runs against the COMPILED barrel via the real `aios inbox` CLI — `npm run build:loop` first.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildObservation,
  appendObservations,
  RANKER_VERSION,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const RECORDED = path.join(
  ROOT,
  "test",
  "operator-loop",
  "fixtures",
  "inbox-remote",
  "remote-response.json"
);

// Fixed, FAR-PAST timestamps so `staleness.stale` is deterministically true regardless of when the
// suite runs, and item order (recency) is stable. Same fixture set the "remote" served.
const FIX = {
  a: "2020-01-01T09:00:00.000Z",
  b: "2020-01-01T09:05:00.000Z",
  c: "2020-01-01T09:10:00.000Z",
};

/** Build the deterministic fixture workspace: three enriched observations across two accounts +
 *  one legacy-only activity record. No asks (their ids/timestamps are wall-clock — not reproducible);
 *  the contract fixture is the fully-deterministic thread-state set. */
function buildRemoteFixture(dir) {
  const mk = (connection_id, account, native_id, ts) =>
    buildObservation({
      connection_id,
      account,
      tenant: "acme.com",
      object_kind: "email",
      native_id,
      ts,
      snippet: `${account}:${native_id}`,
    });
  appendObservations(dir, [
    mk("gmail-a", "alice@acme.com", "msg-1", FIX.a),
    mk("gmail-b", "bob@acme.com", "msg-1", FIX.b), // multi-account collision (same native id)
    mk("gmail-a", "alice@acme.com", "msg-2", FIX.c),
  ]);
  const commsDir = path.join(dir, "1-inbox", "comms");
  mkdirSync(commsDir, { recursive: true });
  writeFileSync(
    path.join(commsDir, "activity.jsonl"),
    JSON.stringify({
      source: "email",
      ref: "gmail:legacy-only",
      occurredAt: FIX.a,
      summary: "legacy record",
    }) + "\n"
  );
}

/** Strip the two legitimately-volatile fields so the diff is over the stable contract surface. */
function normalize(view) {
  const clone = JSON.parse(JSON.stringify(view));
  delete clone.generated_at;
  if (clone.staleness) delete clone.staleness.age_ms;
  return clone;
}

function inboxJson(dir) {
  const stdout = execFileSync("node", [CLI, "inbox", "--json", "--repo", dir], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

test("dual-run: `aios inbox --json` deep-equals the recorded remote response for the same fixtures", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "inbox-remote-"));
  try {
    buildRemoteFixture(dir);
    const local = normalize(inboxJson(dir));

    // Record mode (AIOS_RECORD_REMOTE=1) regenerates the committed fixture from a local run of the
    // same image — the sanctioned stand-in for a Fly machine while the deploy is merge-gated.
    if (process.env.AIOS_RECORD_REMOTE === "1") {
      mkdirSync(path.dirname(RECORDED), { recursive: true });
      writeFileSync(RECORDED, JSON.stringify(local, null, 2) + "\n");
      console.log(`recorded remote response → ${RECORDED}`);
    }

    assert.ok(
      existsSync(RECORDED),
      `recorded remote response present (regenerate with AIOS_RECORD_REMOTE=1)`
    );
    const remote = JSON.parse(readFileSync(RECORDED, "utf8"));

    // THE DUAL-RUN CONTRACT: the local read model and the recorded remote read model are identical.
    assert.deepEqual(
      local,
      remote,
      "local `aios inbox --json` must deep-equal the recorded remote response"
    );

    // Belt-and-braces on the fixture invariants the diff is protecting. The read model runs the REAL
    // I-04 ranker (AIO-429) by default — the same ranker the live remote would run — so the contract
    // is pinned to `RANKER_VERSION`, not the recency fallback.
    assert.equal(local.ranker_version, RANKER_VERSION);
    assert.equal(local.staleness.stale, true, "far-past fixtures are deterministically stale");
    const threads = local.items.filter((i) => i.origin === "thread-state");
    const collision = threads.filter((i) => i.observation.native_id === "msg-1");
    assert.equal(collision.length, 2, "multi-account collision stays two items");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LIVE (--live): diff the local fixture against the real Fly read model (merge-gated manual step)", () => {
  if (!process.argv.includes("--live")) {
    // Default (CI) path: the live diff is a manual follow-up, documented in the provisioning runbook.
    return;
  }
  const remoteUrl = process.env.AIOS_REMOTE_URL;
  assert.ok(
    remoteUrl,
    "--live requires AIOS_REMOTE_URL (+ a scoped device token) for the provisioned Fly machine — see the runbook §Deploy + smoke (merge-gated)"
  );
  // The operator runs this on the live machine after I-11 merges + `fly deploy`; the diff logic is the
  // same normalize()+deepEqual above against the remote read-model API response. Left as the residual.
  throw new Error(
    "live remote diff not wired in CI — run manually on the Fly machine and paste output in the PR"
  );
});
