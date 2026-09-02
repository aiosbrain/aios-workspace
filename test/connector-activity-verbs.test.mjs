// AIO-1072 — the canonical activity verbs (`aios linear activity pull`,
// `aios slack activity pull`), the built-in ports of the retired descriptor activity
// clients. Spawned against the in-process mock providers — no network, no live
// credentials. Unit-level normalization/idempotence coverage lives in
// test/linear-activity.test.mjs and test/operator-loop/connector-pull.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AIOS, ROOT, SYNTHETIC_TOKEN, runSlack, scrubbedEnv } from "./helpers/slack-test-env.mjs";

const LINEAR_MOCK = path.join(ROOT, "test", "helpers", "mock-linear-provider.mjs");

function runLinear(args) {
  return spawnSync(process.execPath, ["--import", LINEAR_MOCK, AIOS, "linear", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "synthetic-parity-key-not-real" },
  });
}

test("`aios linear activity pull` writes idempotent activity records into the repo inbox", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aio-1072-linear-activity-"));
  mkdirSync(path.join(repo, "1-inbox"));
  const first = runLinear(["activity", "pull", "--repo", repo]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^linear-activity-pull: wrote 1, skipped 0 -> /);
  const activity = readFileSync(path.join(repo, "1-inbox", "comms", "activity.jsonl"), "utf8");
  const record = JSON.parse(activity.trim());
  assert.equal(record.source, "linear");
  assert.equal(record.tier, "admin");
  assert.equal(record.ref, "linear:issue-a");
  // Second pull with unchanged provider state appends nothing (revision idempotence).
  const second = runLinear(["activity", "pull", "--repo", repo]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /wrote 0, skipped 1/);
});

test("`aios linear activity` rejects an unknown action and a bad tier offline", () => {
  const bogus = runLinear(["activity", "shove"]);
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /unknown activity action/);
  const badTier = runLinear(["activity", "pull", "--tier", "public"]);
  assert.equal(badTier.status, 1);
  assert.match(badTier.stderr, /--tier must be admin\|team\|external/);
});

test("`aios slack activity pull` scans unread markers and reports the descriptor-shaped line", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aio-1072-slack-activity-"));
  mkdirSync(path.join(repo, "1-inbox"));
  const env = scrubbedEnv({ SLACK_USER_TOKEN: SYNTHETIC_TOKEN });
  const result = runSlack(AIOS, ["slack", "activity", "pull", "--repo", repo], { env });
  assert.equal(result.status, 0, result.stderr);
  // The mock exposes no last_read markers, so the scan is authoritative-and-empty.
  assert.match(
    result.stdout,
    /^slack-activity-pull: wrote 0, skipped 0 \(0\/3 conversations had unread markers\) -> /
  );
  assert.ok(
    result.requests.some((request) => request.url.includes("conversations.list")),
    "the scan must page conversations through the trusted transport"
  );
});

test("slack activity usage errors are offline and credential-free", () => {
  const env = scrubbedEnv();
  const bogus = runSlack(AIOS, ["slack", "activity", "shove"], { env });
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /Unknown activity action/);
  assert.equal(bogus.requests.length, 0, "usage errors must not touch the network");
  const badTier = runSlack(AIOS, ["slack", "activity", "pull", "--tier", "public"], { env });
  assert.equal(badTier.status, 2);
  assert.match(badTier.stderr, /--tier must be admin\|team\|external/);
  assert.equal(badTier.requests.length, 0);
});

test("slack activity without a credential fails as exit class 3 before any request", () => {
  const env = scrubbedEnv();
  const result = runSlack(AIOS, ["slack", "activity", "pull"], { env });
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /AIOS_E_CREDENTIAL_MISSING/);
  assert.equal(result.requests.length, 0);
});
