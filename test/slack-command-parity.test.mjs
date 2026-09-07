// AIO-1068 — the Slack flow-parity matrix. Three claims:
//
//   1. STATIC: the adapter's VERBS matrix covers every slack.py verb (plus `file-delete`,
//      the cleanup half the Python CLI never had) and every verb names a real module.
//   2. DYNAMIC: for every verb, the compat `slack` bin produces byte-identical stdout and
//      the same exit status as `aios slack`, and its ONLY addition is one deprecation
//      warning on stderr. Both processes run against the same in-process mock — no
//      network, no live credentials (the token is synthetic).
//   3. Missing credentials fail identically on both routes: AIOS_E_CREDENTIAL_MISSING,
//      exit class 3.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AIOS,
  ROOT,
  SLACK_BIN,
  SYNTHETIC_TOKEN,
  runSlack,
  scrubbedEnv,
} from "./helpers/slack-test-env.mjs";

// The slack.py verb surface (its argparse subparsers), the parity baseline.
const PYTHON_VERBS = [
  "whoami",
  "resolve",
  "channels",
  "read",
  "send",
  "dm",
  "react",
  "file",
  "connect",
  "status",
  "disconnect",
];

test("static matrix: the adapter's verb surface is the Python surface plus file-delete", async () => {
  const { VERBS } = await import("../scripts/connectors/slack/index.mjs");
  assert.deepEqual(
    Object.keys(VERBS).sort(),
    [...PYTHON_VERBS, "file-delete"].sort(),
    "canonical verb set drifted from the slack.py surface"
  );
  for (const [verb, entry] of Object.entries(VERBS)) {
    assert.ok(
      existsSync(path.join(ROOT, entry.module)),
      `${verb}: adapter module ${entry.module} does not exist`
    );
    assert.ok(["provider", "brain"].includes(entry.credential), `${verb}: credential kind`);
  }
});

/** verb → argv factory. */
const MATRIX = {
  whoami: () => ["whoami"],
  resolve: () => ["resolve", "teammate@example.test"],
  channels: () => ["channels"],
  read: () => ["read", "--target", "C0GENERAL", "--limit", "5"],
  send: () => ["send", "--target", "C0GENERAL", "--message", "parity line one\nline two"],
  dm: () => ["dm", "--member", "teammate@example.test", "--message", "hello"],
  react: () => ["react", "--target", "C0GENERAL", "--ts", "1.000", "--emoji", ":tada:"],
  file: (dir) => ["file", "--target", "C0GENERAL", "--path", path.join(dir, "note.txt")],
  "file-delete": () => ["file-delete", "F0MOCK1"],
  connect: () => ["connect", SYNTHETIC_TOKEN],
  status: () => ["status"],
  disconnect: () => ["disconnect"],
};

test("dynamic matrix: delegate stdout/exit match `aios slack` for every verb", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio-1068-parity-"));
  try {
    writeFileSync(path.join(dir, "note.txt"), "a small note\n");
    const env = scrubbedEnv({
      SLACK_USER_TOKEN: SYNTHETIC_TOKEN,
      AIOS_BRAIN_URL: "https://brain.example.test",
      AIOS_API_KEY: "synthetic-brain-key-not-real",
    });
    for (const [verb, args] of Object.entries(MATRIX)) {
      // The `file` verb reads relative to cwd (workspace containment): run from `dir`.
      const cwd = verb === "file" ? dir : ROOT;
      const canonical = runSlack(AIOS, ["slack", ...args(dir)], { env, cwd });
      const delegate = runSlack(SLACK_BIN, args(dir), { env, cwd });
      assert.equal(
        delegate.status,
        canonical.status,
        `${verb}: exit status diverged (canonical ${canonical.status}: ${canonical.stderr}; ` +
          `delegate ${delegate.status}: ${delegate.stderr})`
      );
      assert.equal(delegate.stdout, canonical.stdout, `${verb}: stdout schema diverged`);
      const [warning, ...restStderr] = delegate.stderr.split("\n");
      assert.match(
        warning,
        /^slack: deprecated compatibility command — use `aios slack /,
        `${verb}: delegate must warn on stderr`
      );
      assert.equal(
        restStderr.join("\n"),
        canonical.stderr,
        `${verb}: delegate stderr must be the canonical stderr plus the one warning line`
      );
      assert.doesNotMatch(
        canonical.stdout + canonical.stderr,
        /synthetic-parity-token/,
        `${verb}: credential leaked`
      );
      assert.equal(canonical.status, 0, `${verb}: canonical run failed: ${canonical.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage and credential-missing parity between the two routes", () => {
  const env = scrubbedEnv();
  const canonical = runSlack(AIOS, ["slack", "whoami"], { env });
  const delegate = runSlack(SLACK_BIN, ["whoami"], { env });
  for (const result of [canonical, delegate]) {
    assert.equal(result.status, 3, `missing credentials are exit class 3: ${result.stderr}`);
    assert.match(result.stderr, /AIOS_E_CREDENTIAL_MISSING/);
    assert.match(result.stderr, /aios slack connect/);
    assert.equal(result.requests.length, 0, "no request may leave without a credential source");
  }
  assert.equal(delegate.stdout, canonical.stdout);

  const usageCanonical = runSlack(AIOS, ["slack"], { env });
  const usageDelegate = runSlack(SLACK_BIN, [], { env });
  assert.equal(usageCanonical.status, 0);
  assert.equal(usageDelegate.status, 0);
  assert.equal(usageDelegate.stdout, usageCanonical.stdout);
  assert.match(usageCanonical.stdout, /file-delete/);
});

test("the compat bin carries no config logic of its own", () => {
  // The whole delegate is: warn, load the barrel, run cmdSlack. Any env/config read here
  // would fork credential resolution between the two routes.
  const source = readFileSync(path.join(ROOT, "scripts", "slack.mjs"), "utf8");
  assert.doesNotMatch(source, /process\.env/, "delegate must not read env config");
  assert.doesNotMatch(source, /resolveConnectorEnv|dotenvx|spawnSync|child_process|python3/);
  assert.match(source, /loadSlackAdapter/);
});
