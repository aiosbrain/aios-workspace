/**
 * AIO-1071 mocked semantic connector journeys, run through the INSTALLED tarball with
 * synthetic credential sentinels and in-process mock providers (zero network, no live
 * Linear/Slack call anywhere). Every assertion is on response semantics — identities,
 * JSON shapes, delegate stdout parity — never a bare exit code.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SENTINELS } from "./context.mjs";

const mockImport = (ctx, name) =>
  `--import ${pathToFileURL(path.join(ctx.artifactDir, "helpers", name)).href}`;

export function linearJourney(ctx, install) {
  const configDir = path.join(ctx.base, "linear-config");
  mkdirSync(configDir, { recursive: true });
  const baseEnv = ctx.cliEnv({ AIOS_CONFIG_DIR: configDir });

  // Missing credential source must fail closed with the exact class + bootstrap hint.
  const missing = ctx.run(install.bin, ["linear", "get", "AIO-73"], {
    cwd: install.prefix,
    env: baseEnv,
    expectFailure: true,
    label: "linear-missing-credential",
  });
  assert.equal(missing.status, 3, "missing credential is class 3");
  assert.match(`${missing.stdout}${missing.stderr}`, /AIOS_E_CREDENTIAL_MISSING/);
  assert.match(`${missing.stdout}${missing.stderr}`, /remediation: aios connect linear/);

  ctx.run(install.bin, ["connect", "linear", "--reference", "env:AIOS_ACCEPT_LINEAR_KEY"], {
    cwd: install.prefix,
    env: baseEnv,
    label: "linear-connect",
  });
  const mockedEnv = ctx.cliEnv({
    AIOS_CONFIG_DIR: configDir,
    AIOS_ACCEPT_LINEAR_KEY: SENTINELS.linearKey,
    NODE_OPTIONS: mockImport(ctx, "mock-linear-provider.mjs"),
  });
  const read = ctx.run(install.bin, ["linear", "get", "AIO-73"], {
    cwd: install.prefix,
    env: mockedEnv,
    label: "linear-get",
  });
  assert.match(read.stdout, /AIO-73 {2}Alpha {2}\[Backlog\] {2}id=issue-a/, "stable identity");

  const status = JSON.parse(
    ctx.run(install.bin, ["linear", "status", "--json"], {
      cwd: install.prefix,
      env: mockedEnv,
      label: "linear-status",
    }).stdout
  );
  assert.deepEqual(status, {
    provider: "linear",
    configured: true,
    source: { name: "user-config", fields: ["apiKey"] },
  });

  // Compatibility delegate parity: the `linear` bin must be stdout-identical.
  const delegate = ctx.run(
    path.join(install.prefix, "node_modules", ".bin", "linear"),
    ["get", "AIO-73"],
    { cwd: install.prefix, env: mockedEnv, label: "linear-delegate" }
  );
  assert.equal(delegate.stdout, read.stdout, "delegate stdout must match `aios linear`");

  ctx.run(install.bin, ["disconnect", "linear"], {
    cwd: install.prefix,
    env: baseEnv,
    label: "linear-disconnect",
  });
  // Cleanup semantics: after disconnect the credential source is gone again.
  const after = ctx.run(install.bin, ["linear", "get", "AIO-73"], {
    cwd: install.prefix,
    env: baseEnv,
    expectFailure: true,
    label: "linear-post-disconnect",
  });
  assert.equal(after.status, 3, "disconnect must remove the configured source");

  ctx.record("linear-journey", {
    missingCredentialClass: "AIOS_E_CREDENTIAL_MISSING/exit 3",
    mockedRead: "AIO-73 identity verified",
    statusJson: status,
    delegateParity: "identical stdout",
    cleanup: "disconnect restores exit 3",
  });
}

export function slackJourney(ctx, install) {
  const configDir = path.join(ctx.base, "slack-config");
  mkdirSync(configDir, { recursive: true });
  const baseEnv = ctx.cliEnv({
    AIOS_CONFIG_DIR: configDir,
    AIOS_DISABLE_WORKSPACE_CREDENTIALS: "1",
  });

  const missing = ctx.run(install.bin, ["slack", "whoami"], {
    cwd: install.prefix,
    env: baseEnv,
    expectFailure: true,
    label: "slack-missing-credential",
  });
  assert.equal(missing.status, 3, "missing credential is class 3");
  assert.match(`${missing.stdout}${missing.stderr}`, /AIOS_E_CREDENTIAL_MISSING/);

  const mockedEnv = {
    ...baseEnv,
    SLACK_USER_TOKEN: SENTINELS.slackToken,
    NODE_OPTIONS: mockImport(ctx, "mock-slack-provider.mjs"),
  };
  const whoami = ctx.run(install.bin, ["slack", "whoami"], {
    cwd: install.prefix,
    env: mockedEnv,
    label: "slack-whoami",
  });
  assert.match(whoami.stdout, /mockuser \(U0MOCK\) on team MockCo/, "stable identity");

  const fixture = path.join(ctx.base, "slack-upload-fixture");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(path.join(fixture, "acceptance.txt"), "packaged slack upload bytes\n");
  const uploaded = JSON.parse(
    ctx.run(
      install.bin,
      ["slack", "file", "--target", "C0GENERAL", "--path", "acceptance.txt", "--json"],
      { cwd: fixture, env: mockedEnv, label: "slack-file" }
    ).stdout
  );
  assert.equal(uploaded.ok, true, "upload document reports ok");
  const fileId = uploaded.files[0].id;
  const deleted = ctx.run(install.bin, ["slack", "file-delete", fileId], {
    cwd: fixture,
    env: mockedEnv,
    label: "slack-file-delete",
  });
  assert.equal(deleted.stdout, `deleted ${fileId}\n`, "upload is cleaned up");

  const delegate = ctx.run(path.join(install.prefix, "node_modules", ".bin", "slack"), ["whoami"], {
    cwd: install.prefix,
    env: mockedEnv,
    label: "slack-delegate",
  });
  assert.equal(delegate.stdout, whoami.stdout, "delegate stdout must match `aios slack`");

  ctx.record("slack-journey", {
    missingCredentialClass: "AIOS_E_CREDENTIAL_MISSING/exit 3",
    whoami: "mockuser identity verified",
    upload: { fileId, cleanedUp: true },
    delegateParity: "identical stdout",
  });
}
