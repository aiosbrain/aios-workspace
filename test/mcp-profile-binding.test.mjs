import { fixtureOwner } from "./lib/mcp-host-fixture.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { registerProfile, revokeProfile } from "../scripts/mcp-profile-setup.mjs";
import { runStdio } from "../scripts/brain-mcp.mjs";
import { resolveLaunchConfig } from "../scripts/mcp-config.mjs";
import { loadProfileBinding, authorizeProfileCall } from "../scripts/mcp-profile-binding.mjs";

test("live list and old reads/status reload selected profile and never use stale client", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profile-runtime-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fixtureOwner(home);
  const env = {
    AIOS_CONFIG_DIR: path.join(home, "config"),
    KEY: "sentinel_a",
    OTHER: "sentinel_b",
  };
  const requests = [];
  const fetchImpl = async (url, opts) => {
    requests.push({ url, authorization: opts.headers?.Authorization });
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/me")
          ? { actor: "actor", team: "team", tier: "team", role: "member" }
          : url.includes("/projects/")
            ? { project_id: "project", team_id: "team" }
            : { items: [] },
    };
  };
  const options = { home, env, fetchImpl };
  const profile = {
    id: "demo",
    mode: "brain-only",
    brainOrigin: "https://one.example.test",
    teamId: "team",
    projectId: "project",
    credentialSource: "brain",
    reference: "env:KEY",
    grants: { brainActions: true },
  };
  await registerProfile(profile, options);
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  let pending = "",
    messages = [];
  stdout.on("data", (chunk) => {
    pending += chunk;
    while (pending.includes("\n")) {
      const at = pending.indexOf("\n");
      messages.push(JSON.parse(pending.slice(0, at)));
      pending = pending.slice(at + 1);
    }
  });
  const done = runStdio(resolveLaunchConfig(["--profile", "demo"]), {
    argv: ["--profile", "demo"],
    home,
    env,
    fetch: fetchImpl,
    stdin,
    stdout,
    stderr,
  });
  async function rpc(id, method, params = {}) {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 100; i++) {
      const response = messages.find((row) => row.id === id);
      if (response) return response;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("No response");
  }
  assert.equal((await rpc(1, "tools/list")).result.tools.length, 9);
  assert.equal((await rpc(2, "tools/call", { name: "brain_status" })).result.isError, undefined);
  await registerProfile(
    { ...profile, brainOrigin: "https://two.example.test", reference: "env:OTHER" },
    options
  );
  const before = requests.length;
  assert.equal((await rpc(3, "tools/list")).error.code, -32000);
  assert.equal((await rpc(4, "tools/call", { name: "brain_status" })).result.isError, true);
  assert.equal((await rpc(5, "tools/call", { name: "brain_list_tasks" })).result.isError, true);
  assert.equal(requests.length, before, "no stale or mixed client reaches either Brain");
  stdin.end();
  await done;
  assert.ok(!messages.some((row) => JSON.stringify(row).includes("sentinel_")));
});

test("two roots and Brains isolate tuple, cross-selection, readonly and removal", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profile-isolation-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fixtureOwner(home);
  const env = {
    AIOS_CONFIG_DIR: path.join(home, "config"),
    ONE: "one",
    TWO: "two",
    AIOS_API_KEY: "ambient",
    AIOS_BRAIN_URL: "https://ambient.example.test",
  };
  const opts = {
    home,
    env,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith("/me")
          ? { actor: "actor", team: "team", tier: "team" }
          : { project_id: "project", team_id: "team" },
    }),
  };
  for (const id of ["one", "two"]) {
    const root = path.join(home, id);
    fs.mkdirSync(root);
    await registerProfile(
      {
        id,
        mode: "workspace",
        root,
        brainOrigin: `https://${id}.example.test`,
        teamId: "team",
        projectId: "project",
        credentialSource: id,
        reference: `env:${id.toUpperCase()}`,
        grants: { workspaceRead: true, workspaceDraft: true },
        readRoots: ["2-work"],
        draftRoots: ["2-work"],
      },
      opts
    );
  }
  const one = loadProfileBinding("one", opts);
  assert.equal(one.config.api_key, "one");
  assert.equal(one.config.brain_url, "https://one.example.test");
  assert.throws(() => authorizeProfileCall(one, { ...opts, requestProfileId: "two" }), {
    code: "PROFILE_CHANGED",
  });
  assert.throws(
    () => authorizeProfileCall(one, { ...opts, capability: "workspaceDraft", readOnly: true }),
    { code: "CAPABILITY_DENIED" }
  );
  await revokeProfile("one", undefined, opts);
  assert.throws(() => authorizeProfileCall(one, opts), { code: "PROFILE_CHANGED" });
  assert.equal(loadProfileBinding("two", opts).config.api_key, "two");
});
