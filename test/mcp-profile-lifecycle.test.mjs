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

test("explicit registration cannot infer a relative root or reuse a removed profile epoch", async (t) => {
  const { options, input } = fixture(t);
  await assert.rejects(
    registerProfile({ ...input, mode: "workspace", root: "." }, { ...options, dryRun: true }),
    { code: "INVALID_PROFILE" }
  );
  await registerProfile(input, options);
  const first = loadProfileBinding(input.id, options);
  await revokeProfile(input.id, undefined, options);
  const config = profilePaths(options).config;
  const document = JSON.parse(fs.readFileSync(config));
  document.connectionProfiles.profiles = [];
  fs.writeFileSync(config, JSON.stringify(document));
  await registerProfile(input, options);
  const recreated = loadProfileBinding(input.id, options);
  assert.ok(recreated.profile.generation > first.profile.generation + 1);
  assert.throws(() => authorizeProfileCall(first, options), { code: "PROFILE_CHANGED" });
});

test("shared source change invalidates both bindings and identical registration is a no-op", async (t) => {
  const { options, input } = fixture(t);
  options.env.OTHER = "selected-other";
  await registerProfile(input, options);
  await registerProfile({ ...input, id: "second" }, options);
  const first = loadProfileBinding(input.id, options),
    second = loadProfileBinding("second", options);
  const config = profilePaths(options).config,
    before = fs.readFileSync(config);
  const repeated = await registerProfile(input, options);
  assert.equal(repeated.changed, false);
  assert.deepEqual(fs.readFileSync(config), before);
  await registerProfile({ ...input, reference: "env:OTHER" }, options);
  assert.throws(() => authorizeProfileCall(first, options), { code: "PROFILE_CHANGED" });
  assert.throws(() => authorizeProfileCall(second, options), { code: "PROFILE_CHANGED" });
  assert.equal(loadProfileBinding("second", options).config.api_key, "selected-other");
});

test("concurrent registration cannot lose an update or overwrite unrelated config edits", async (t) => {
  const { options, input } = fixture(t);
  await registerProfile(input, options);
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = registerProfile(
    { ...input, grants: {} },
    {
      ...options,
      fetchImpl: async (url) => {
        entered();
        await wait;
        return options.fetchImpl(url);
      },
    }
  );
  await ready;
  await assert.rejects(registerProfile({ ...input, id: "other" }, options), {
    code: "PROFILE_CHANGED",
  });
  const config = profilePaths(options).config,
    document = JSON.parse(fs.readFileSync(config));
  document.unrelatedFutureKey = { preserved: true };
  fs.writeFileSync(config, JSON.stringify(document));
  release();
  await assert.rejects(pending, { code: "PROFILE_CHANGED" });
  assert.equal(JSON.parse(fs.readFileSync(config)).unrelatedFutureKey.preserved, true);
  assert.equal(loadProfileBinding(input.id, options).profile.grants.brainActions, true);
});

test("workspace resolves only its selected root/key and Brain-only never invokes the vault", async (t) => {
  const { home, options, input } = fixture(t);
  const root = path.join(home, "selected-root");
  fs.mkdirSync(root);
  const calls = [];
  const opts = {
    ...options,
    env: { AIOS_CONFIG_DIR: options.env.AIOS_CONFIG_DIR },
    workspaceCredential: (selectedRoot, keyName) => {
      calls.push([selectedRoot, keyName]);
      return key;
    },
  };
  await registerProfile({ ...input, mode: "workspace", root }, opts);
  loadProfileBinding(input.id, opts);
  assert.deepEqual(calls, [
    [root, "KEY"],
    [root, "KEY"],
  ]);
  await assert.rejects(registerProfile({ ...input, id: "brain-only" }, opts), {
    code: "AUTH_REVOKED",
  });
  assert.equal(calls.length, 2);
  assert.throws(() => loadProfileBinding(input.id, { ...opts, env: { ...opts.env, KEY: "" } }), {
    code: "AUTH_REVOKED",
  });
  assert.equal(calls.length, 2, "explicit missing environment source cannot fall back to vault");
});

test("updating another profile never restores a revoked cached binding from a config backup", async (t) => {
  const { options, input } = fixture(t);
  await registerProfile(input, options);
  await registerProfile({ ...input, id: "second", credentialSource: "second-source" }, options);
  const old = loadProfileBinding("second", options);
  const paths = profilePaths(options),
    backup = fs.readFileSync(paths.config);
  await revokeProfile("second", ["brainActions"], options);
  const retained = JSON.parse(fs.readFileSync(paths.records)).profileEpochs.second;
  fs.writeFileSync(paths.config, backup);
  assert.throws(() => authorizeProfileCall(old, options), { code: "PROFILE_CHANGED" });
  await registerProfile({ ...input, grants: {} }, options);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.records)).profileEpochs.second, retained);
  assert.throws(() => authorizeProfileCall(old, { ...options, capability: "brainActions" }), {
    code: "PROFILE_CHANGED",
  });
});

test("shared-source changes and partial revokes cannot reauthorize stale restored grants", async (t) => {
  const { home, options, input } = fixture(t);
  options.env.OTHER = "new-selected-key";
  const root = path.join(home, "root");
  fs.mkdirSync(root);
  await registerProfile(input, options);
  await registerProfile(
    {
      ...input,
      id: "second",
      mode: "workspace",
      root,
      readRoots: ["2-work"],
      grants: { brainActions: true, workspaceRead: true },
    },
    options
  );
  const paths = profilePaths(options),
    backup = fs.readFileSync(paths.config);
  await revokeProfile("second", ["brainActions"], options);
  const records = fs.readFileSync(paths.records);
  fs.writeFileSync(paths.config, backup);
  await assert.rejects(registerProfile({ ...input, reference: "env:OTHER" }, options), {
    code: "PROFILE_CHANGED",
  });
  await assert.rejects(revokeProfile("second", ["workspaceRead"], options), {
    code: "PROFILE_CHANGED",
  });
  assert.deepEqual(fs.readFileSync(paths.records), records);
  await revokeProfile("second", undefined, options);
  assert.throws(() => loadProfileBinding("second", options), { code: "PROFILE_CHANGED" });
});
