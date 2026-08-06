import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cmdLinear } from "../scripts/linear-cli.mjs";

const fakeKey = "fixture-linear-key";

async function capture(run) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const code = await run();
    return { code, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

function workspace() {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-linear-cli-"));
  writeFileSync(path.join(repo, "aios.yaml"), "workspace: test\n");
  return repo;
}

test("setup validates before storing and never prints the key", async () => {
  const repo = workspace();
  const writes = [];
  try {
    const result = await capture(() =>
      cmdLinear(repo, ["setup", "--json"], {
        askSecret: async () => fakeKey,
        vaultGetFn: () => "",
        vaultSetFn: (...args) => writes.push(args),
        createClient: ({ apiKey }) => ({
          getIdentity: async () => {
            assert.equal(apiKey, fakeKey);
            return { viewer: { id: "u1", name: "Alex" }, teams: [{ id: "t1", key: "ENG" }] };
          },
        }),
      })
    );
    assert.equal(result.code, 0);
    assert.deepEqual(writes, [[repo, "LINEAR_API_KEY", fakeKey]]);
    assert.doesNotMatch(result.output, new RegExp(fakeKey));
    assert.match(result.output, /workspace-vault/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("status identifies workspace-bound credential provenance", async () => {
  const repo = workspace();
  try {
    const result = await capture(() =>
      cmdLinear(repo, ["status", "--json"], {
        vaultGetFn: () => fakeKey,
        createClient: () => ({
          getIdentity: async () => ({ viewer: { id: "u1" }, teams: [] }),
        }),
      })
    );
    assert.equal(result.code, 0);
    assert.match(result.output, /"encrypted": true/);
    assert.doesNotMatch(result.output, new RegExp(fakeKey));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("create and update map public CLI flags to the shared client", async () => {
  const repo = workspace();
  const calls = [];
  const issue = { identifier: "ENG-42", title: "Portable CLI", state: { name: "Todo" } };
  const client = {
    createWorkspaceIssue: async (input) => {
      calls.push(["create", input]);
      return issue;
    },
    updateWorkspaceIssue: async (identifier, input) => {
      calls.push(["update", identifier, input]);
      return issue;
    },
  };
  const deps = { vaultGetFn: () => fakeKey, createClient: () => client };
  try {
    assert.equal(
      (
        await capture(() =>
          cmdLinear(
            repo,
            ["create", "--team", "ENG", "--title", "Portable CLI", "--label", "cli", "--json"],
            deps
          )
        )
      ).code,
      0
    );
    await capture(() => cmdLinear(repo, ["set-state", "ENG-42", "Done", "--json"], deps));
    assert.deepEqual(calls[0], [
      "create",
      {
        team: "ENG",
        title: "Portable CLI",
        description: "",
        state: undefined,
        assignee: undefined,
        priority: undefined,
        parent: undefined,
        project: undefined,
        labels: ["cli"],
      },
    ]);
    assert.deepEqual(calls[1], ["update", "ENG-42", { state: "Done" }]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ambient LINEAR_API_KEY is ignored unless --allow-env is explicit", async () => {
  const repo = workspace();
  try {
    const common = {
      vaultGetFn: () => "",
      env: { LINEAR_API_KEY: fakeKey },
      createClient: () => ({ getIdentity: async () => ({ viewer: { id: "u1" }, teams: [] }) }),
    };
    const without = await capture(() => cmdLinear(repo, ["status", "--json"], common));
    assert.equal(without.code, 1);
    const withFlag = await capture(() =>
      cmdLinear(repo, ["status", "--allow-env", "--json"], common)
    );
    assert.equal(withFlag.code, 0);
    assert.match(withFlag.output, /explicit-environment/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
