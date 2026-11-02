import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdMcpProfile, chooseProfileSetup } from "../scripts/mcp-profile-command.mjs";
import { loadProfileBinding } from "../scripts/mcp-profile-binding.mjs";
import { fixtureOwner } from "./lib/mcp-host-fixture.mjs";
import { profileArtifactFixture } from "./lib/mcp-profile-artifact-fixture.mjs";
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profile-command-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fixtureOwner(home);
  const output = [];
  const options = {
    home,
    env: { AIOS_CONFIG_DIR: path.join(home, "config"), KEY: "sentinel_cli_key" },
    output: (value) => output.push(JSON.parse(value)),
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/me")
          ? { actor: "actor", team: "team", tier: "team" }
          : { project_id: "project", team_id: "team" },
    }),
  };
  return { home, options, output };
}
const flags = [
  "--profile",
  "demo",
  "--mode",
  "brain-only",
  "--brain-origin",
  "https://brain.example.test",
  "--team",
  "team",
  "--project-id",
  "project",
  "--credential-source",
  "brain",
  "--reference",
  "env:KEY",
];
test("profile CLI preserves explicit grants across preview, registration, status and revocation", async (t) => {
  const { home, options, output } = fixture(t);
  await cmdMcpProfile(
    ["register", ...flags, "--grant", "brainActions", "--dry-run", "--json"],
    options
  );
  assert.equal(fs.existsSync(options.env.AIOS_CONFIG_DIR), false);
  await cmdMcpProfile(["register", ...flags, "--grant", "brainActions"], options);
  assert.equal(loadProfileBinding("demo", options).profile.grants.brainActions, true);
  await cmdMcpProfile(["status", "--profile", "demo", "--read-only"], options);
  assert.equal(output.at(-1).identityVerified, true);
  await cmdMcpProfile(["revoke", "--profile", "demo", "--revoke", "brainActions"], options);
  assert.equal(loadProfileBinding("demo", options).profile.grants.brainActions, false);
  await cmdMcpProfile(["recover"], options);
  assert.equal(output.at(-1).changed, false);
  assert.ok(!JSON.stringify(output).includes("sentinel_cli_key"));
  assert.ok(fs.existsSync(home));
});
test("profile CLI rejects missing values, unknown grants, unsupported actions and destination failures safely", async (t) => {
  const { options, output } = fixture(t);
  for (const args of [
    ["register", "--profile"],
    ["register", "--profile", "--json"],
    ["register", ...flags, "--grant", "unknown"],
    ["register", ...flags, "--unknown", "sentinel"],
    ["recover", "--dry-run"],
    ["status"],
  ]) {
    await assert.rejects(cmdMcpProfile(args, options), { code: "AIOS_E_USAGE" });
  }
  await assert.rejects(
    cmdMcpProfile(["register", ...flags], {
      ...options,
      fetchImpl: async () => {
        throw new Error("sentinel_network");
      },
    }),
    (error) =>
      error.code === "AIOS_E_CONFIG_INVALID" && !JSON.stringify(error).includes("sentinel_network")
  );
  assert.deepEqual(output, []);
});
test("guided explicit setup requires confirmation and carries only selected grants", async (t) => {
  const { home, options } = fixture(t);
  const artifactInput = profileArtifactFixture(home);
  let confirmed = false;
  const answers = ["demo", "https://brain.example.test", "team", "project", "brain", "env:KEY"];
  const ui = {
    select: async () => "brain-only",
    isCancel: (value) => value === null,
    text: async () => answers.shift(),
    multiselect: async (prompt) => {
      assert.deepEqual(prompt.initialValues, []);
      return ["brainActions"];
    },
    confirm: async (prompt) => {
      assert.equal(prompt.initialValue, false);
      assert.match(prompt.message, /team \/ project/);
      return confirmed;
    },
  };
  assert.equal(await chooseProfileSetup({ ...options, artifactInput, ui }), null);
  assert.equal(fs.existsSync(options.env.AIOS_CONFIG_DIR), false);
  answers.push("demo", "https://brain.example.test", "team", "project", "brain", "env:KEY");
  confirmed = true;
  assert.equal((await chooseProfileSetup({ ...options, artifactInput, ui })).profileId, "demo");
  const binding = loadProfileBinding("demo", options);
  assert.equal(binding.profile.grants.brainActions, true);
  assert.equal(binding.profile.grants.workspacePublish, false);
  assert.equal(
    await chooseProfileSetup({ ...options, ui: { ...ui, select: async () => null } }),
    null
  );
  assert.equal(
    await chooseProfileSetup({ ...options, ui: { ...ui, text: async () => null } }),
    null
  );
});
