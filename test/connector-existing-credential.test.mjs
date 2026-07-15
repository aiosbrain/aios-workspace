import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getDescriptor,
  listConnectors,
  storeExistingConnector,
  vaultSet,
} from "../scripts/connector.mjs";

function workspace() {
  const repo = mkdtempSync(path.join(tmpdir(), "connector-existing-"));
  mkdirSync(path.join(repo, ".claude"), { recursive: true });
  writeFileSync(
    path.join(repo, ".claude", "integrations.json"),
    JSON.stringify({ integrations: [{ id: "linear", status: "available" }] }, null, 2)
  );
  return repo;
}

test("encrypted Linear credential is detected without exposing its value", () => {
  const repo = workspace();
  const secret = "lin_api_test_never_return_me";
  try {
    vaultSet(repo, "LINEAR_API_KEY", secret);
    const linear = listConnectors(repo).find((connector) => connector.id === "linear");
    assert.equal(linear.credential_present, true);
    assert.equal(linear.artifact_present, false);
    assert.equal(linear.status, "available");
    assert.equal(JSON.stringify(linear).includes(secret), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("saved Linear credential can validate and install without entering the browser response", async () => {
  const repo = workspace();
  const secret = "lin_api_test_server_side_only";
  try {
    vaultSet(repo, "LINEAR_API_KEY", secret);
    const descriptor = getDescriptor(repo, "linear");
    const result = await storeExistingConnector(repo, descriptor, {
      validate: async (_descriptor, values) => {
        assert.equal(values.LINEAR_API_KEY, secret);
        return {
          ok: true,
          checks: [{ name: "auth", ok: true, detail: "accepted" }],
          identity: { label: "You", value: "Test User" },
          instance: null,
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(secret), false);
    const linear = listConnectors(repo).find((connector) => connector.id === "linear");
    assert.equal(linear.status, "wired");
    assert.equal(linear.credential_present, true);
    assert.equal(linear.artifact_present, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("existing-credential activation fails closed when the required key is absent", async () => {
  const repo = workspace();
  try {
    const descriptor = getDescriptor(repo, "linear");
    await assert.rejects(
      storeExistingConnector(repo, descriptor, {
        validate: async () => {
          throw new Error("validation must not run");
        },
      }),
      (error) => error?.code === "credential_missing"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
