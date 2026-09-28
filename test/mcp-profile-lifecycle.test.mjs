import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerProfile, revokeProfile, recoverProfiles } from "../scripts/mcp-profile-setup.mjs";
import {
  loadProfileBinding,
  authorizeProfileCall,
  inspectProfile,
  profilePaths,
} from "../scripts/mcp-profile-binding.mjs";
const key = "SENTINEL_profile_secret_not_for_output";
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const options = {
    home,
    env: { AIOS_CONFIG_DIR: path.join(home, "config"), KEY: key },
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/me")
          ? { actor: "actor", team: "team", tier: "team" }
          : { project_id: "project", team_id: "team" },
    }),
  };
  const input = {
    id: "demo",
    mode: "brain-only",
    brainOrigin: "https://brain.example.test",
    teamId: "team",
    projectId: "project",
    credentialSource: "brain",
    reference: "env:KEY",
    grants: { brainActions: true },
  };
  return { home, options, input };
}
test("dry-run-no-files-dirs-backups", async (t) => {
  const { home, options, input } = fixture(t);
  const before = fs.readdirSync(home);
  const result = await registerProfile(input, { ...options, dryRun: true });
  assert.equal(result.dry_run, true);
  assert.deepEqual(fs.readdirSync(home), before);
  assert.ok(!JSON.stringify(result).includes(key));
});
test("cached-tool-call-after-revoke-denied and status secrets redacted", async (t) => {
  const { options, input } = fixture(t);
  await registerProfile(input, options);
  const binding = loadProfileBinding("demo", options);
  assert.equal(
    authorizeProfileCall(binding, { ...options, capability: "brainActions" }).effectiveGrants
      .brainActions,
    true
  );
  assert.equal((await inspectProfile("demo", options)).identityVerified, true);
  assert.ok(!JSON.stringify(await inspectProfile("demo", options)).includes(key));
  await revokeProfile("demo", ["brainActions"], options);
  assert.throws(() => authorizeProfileCall(binding, options), { code: "PROFILE_CHANGED" });
  const current = loadProfileBinding("demo", options);
  assert.throws(() => authorizeProfileCall(current, { ...options, capability: "brainActions" }), {
    code: "CAPABILITY_DENIED",
  });
});
test("reserved-generation recovery disables grants and rejects restored backup", async (t) => {
  const { options, input } = fixture(t);
  await registerProfile(input, options);
  const file = profilePaths(options).config,
    before = fs.readFileSync(file);
  await assert.rejects(
    registerProfile(
      { ...input, grants: {} },
      {
        ...options,
        failpoint: (stage) => {
          if (stage === "reserved") throw new Error("interrupt");
        },
      }
    )
  );
  assert.throws(() => loadProfileBinding("demo", options), { code: "PROFILE_CHANGED" });
  await recoverProfiles(options);
  assert.throws(() => loadProfileBinding("demo", options), { code: "PROFILE_CHANGED" });
  fs.writeFileSync(file, before);
  assert.throws(() => loadProfileBinding("demo", options), { code: "PROFILE_CHANGED" });
});
test("selected-source-missing-no-fallback and wrong project rejected before write", async (t) => {
  const { home, options, input } = fixture(t);
  await assert.rejects(
    registerProfile(input, {
      ...options,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ actor: "actor", team: "wrong", tier: "team" }),
      }),
    }),
    { code: "AUTH_REVOKED" }
  );
  assert.ok(!fs.existsSync(profilePaths(options).config));
  await registerProfile(input, options);
  assert.throws(
    () =>
      loadProfileBinding("demo", {
        ...options,
        env: { AIOS_CONFIG_DIR: path.join(home, "config"), AIOS_API_KEY: "OTHER" },
      }),
    { code: "AUTH_REVOKED" }
  );
});
test("canonical-root and root-replacement denied, offline authorization independent", async (t) => {
  const { home, options, input } = fixture(t);
  const root = path.join(home, "workspace");
  fs.mkdirSync(root);
  await registerProfile(
    { ...input, mode: "workspace", root, grants: { workspaceRead: true }, readRoots: ["2-work"] },
    options
  );
  const binding = loadProfileBinding("demo", options);
  assert.equal(
    authorizeProfileCall(binding, { ...options, capability: "workspaceRead" }).effectiveGrants
      .workspaceRead,
    true
  );
  assert.equal(
    (
      await inspectProfile("demo", {
        ...options,
        fetchImpl: async () => {
          throw new Error("offline");
        },
      })
    ).identityVerified,
    false
  );
  fs.renameSync(root, `${root}-old`);
  fs.mkdirSync(root);
  assert.throws(() => authorizeProfileCall(binding, options), { code: "PROFILE_CHANGED" });
});
