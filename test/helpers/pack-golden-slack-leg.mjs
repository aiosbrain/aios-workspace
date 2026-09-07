/**
 * The packed Slack leg of the npm-pack golden path (AIO-1068), extracted so the main test
 * stays under the file-size cap. Proves, from the INSTALLED package with an empty
 * HOME/config and a Node-only PATH: missing credential → exit 3 naming the bootstrap;
 * with a synthetic token and the in-process mock provider, whoami → upload → delete
 * completes and the compat `slack` bin is stdout-identical to `aios slack`.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function runPackedSlackLeg({ run, bin, prefix, base, nodeOnlyPath, root }) {
  const slackCfg = path.join(base, "slack-config");
  mkdirSync(slackCfg, { recursive: true });
  const baseEnv = {
    PATH: nodeOnlyPath,
    AIOS_CONFIG_DIR: slackCfg,
    AIOS_DISABLE_WORKSPACE_CREDENTIALS: "1",
  };
  let missingStatus = 0;
  let missingOut = "";
  try {
    run(bin, ["slack", "whoami"], { cwd: prefix, env: baseEnv });
  } catch (e) {
    missingStatus = e.status ?? 1;
    missingOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.equal(missingStatus, 3, `packed slack missing-credential: ${missingOut}`);
  assert.match(missingOut, /AIOS_E_CREDENTIAL_MISSING/);

  const mockUrl = pathToFileURL(path.join(root, "test", "helpers", "mock-slack-provider.mjs")).href;
  const env = {
    ...baseEnv,
    SLACK_USER_TOKEN: "xoxp-synthetic-golden-token-not-real",
    NODE_OPTIONS: `--import ${mockUrl}`,
  };
  const whoami = run(bin, ["slack", "whoami"], { cwd: prefix, env });
  assert.match(whoami, /mockuser \(U0MOCK\) on team MockCo/);

  const fixture = path.join(base, "slack-upload-fixture");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(path.join(fixture, "golden.txt"), "packed slack upload bytes\n");
  const uploaded = JSON.parse(
    run(bin, ["slack", "file", "--target", "C0GENERAL", "--path", "golden.txt", "--json"], {
      cwd: fixture,
      env,
    })
  );
  assert.equal(uploaded.ok, true);
  const fileId = uploaded.files[0].id;
  const deleted = run(bin, ["slack", "file-delete", fileId], { cwd: fixture, env });
  assert.equal(deleted, `deleted ${fileId}\n`);

  const delegate = run(path.join(prefix, "node_modules", ".bin", "slack"), ["whoami"], {
    cwd: prefix,
    env,
  });
  assert.equal(delegate, whoami, "slack delegate stdout must match `aios slack`");
}
