// test/connector-cli.test.mjs — the `aios connector` / `aios catalog` JSON seams (AIO-600).
//
// These commands exist so the GUI server (and any out-of-repo consumer) drives the
// connector engine + catalog readers through the CLI instead of deep-importing
// scripts/** (boundary rule R4). The contract under test: one `{ status, body }`
// JSON document per action, with the HTTP-shaped status mapping (422 validation /
// credential failures, 503 no brain, 502 OAuth relay error, 500 internal) that the
// GUI routes used to compute in-process — lifted here verbatim. All network-touching
// paths are exercised through the injectable `impl` bag; no test talks to a provider.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectorAction, cmdConnector } from "../scripts/connector-cli.mjs";
import { catalogJson, cmdCatalog } from "../scripts/gen-catalog.mjs";

const REPO = "/tmp/not-read"; // impl-injected tests never touch the filesystem

const DESCRIPTOR = { id: "tool", auth_mode: "token", secrets: [{ env: "TOOL_KEY" }] };
const impl = (over = {}) => ({
  descriptor: () => DESCRIPTOR,
  brainConfig: () => ({ brain_url: "https://brain.example", api_key: "k" }),
  ...over,
});

test("connector list / blueprint are plain 200 reads", async () => {
  const r = await connectorAction(REPO, "list", null, {}, impl({ list: () => [{ id: "tool" }] }));
  assert.deepEqual(r, { status: 200, body: { connectors: [{ id: "tool" }] } });
  const b = await connectorAction(
    REPO,
    "blueprint",
    null,
    {},
    impl({ list: () => [], blueprint: () => ({ connectors: {} }) })
  );
  assert.deepEqual(b, { status: 200, body: { blueprint: { connectors: {} }, connectors: [] } });
});

test("oauth actions: 503 without a brain connection, 502 on relay error, 200 pass-through", async () => {
  const noBrain = await connectorAction(
    REPO,
    "oauth-start",
    "tool",
    {},
    impl({ brainConfig: () => ({}) })
  );
  assert.equal(noBrain.status, 503);
  assert.equal(noBrain.body.error, "no_brain_connection");

  const relayErr = await connectorAction(
    REPO,
    "oauth-status",
    "tool",
    {},
    impl({
      oauthStatus: async () => {
        throw new Error("oauth status failed: HTTP 500");
      },
    })
  );
  assert.equal(relayErr.status, 502);
  assert.match(relayErr.body.error, /oauth status failed/);

  const ok = await connectorAction(
    REPO,
    "oauth-start",
    "tool",
    {},
    impl({ oauthStart: async () => ({ authorize_url: "https://slack.example/auth" }) })
  );
  assert.deepEqual(ok, { status: 200, body: { authorize_url: "https://slack.example/auth" } });
});

test("store: 422 on failed validation, 200 with identity/instance on success", async () => {
  const failed = await connectorAction(
    REPO,
    "store",
    "tool",
    { TOOL_KEY: "x" },
    impl({ validate: async () => ({ ok: false, checks: [] }) })
  );
  assert.equal(failed.status, 422);
  assert.deepEqual(failed.body, { ok: false, validation: { ok: false, checks: [] } });

  let storedWith = null;
  const ok = await connectorAction(
    REPO,
    "store",
    "tool",
    { TOOL_KEY: "x" },
    impl({
      validate: async () => ({ ok: true, captured: { CAP: "c" }, identity: "id", instance: "in" }),
      store: (_repo, _d, secrets) => {
        storedWith = secrets;
        return { id: "tool", status: "wired" };
      },
    })
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, {
    ok: true,
    id: "tool",
    status: "wired",
    identity: "id",
    instance: "in",
  });
  // captured values are merged into what gets persisted, exactly as the GUI route did
  assert.deepEqual(storedWith, { TOOL_KEY: "x", CAP: "c" });
});

test("store on an oauth descriptor: 503 no brain, 422 oauth_not_connected, 200 stored", async () => {
  const d = { id: "slack", auth_mode: "oauth" };
  const noBrain = await connectorAction(
    REPO,
    "store",
    "slack",
    {},
    impl({ descriptor: () => d, brainConfig: () => ({}) })
  );
  assert.equal(noBrain.status, 503);

  const notConnected = await connectorAction(
    REPO,
    "store",
    "slack",
    {},
    impl({
      descriptor: () => d,
      storeOAuth: async () => {
        throw Object.assign(new Error("not connected yet"), { code: "oauth_not_connected" });
      },
    })
  );
  assert.equal(notConnected.status, 422);
  assert.equal(notConnected.body.error, "oauth_not_connected");

  const stored = await connectorAction(
    REPO,
    "store",
    "slack",
    {},
    impl({ descriptor: () => d, storeOAuth: async () => ({ id: "slack", status: "wired" }) })
  );
  assert.deepEqual(stored, { status: 200, body: { ok: true, id: "slack", status: "wired" } });
});

test("store-existing: mirrors the engine's ok flag as 200/422; credential_missing → 422", async () => {
  const missing = await connectorAction(
    REPO,
    "store-existing",
    "tool",
    {},
    impl({
      storeExisting: async () => {
        throw Object.assign(new Error("no saved credential"), { code: "credential_missing" });
      },
    })
  );
  assert.deepEqual(missing, { status: 422, body: { ok: false, error: "no saved credential" } });

  const okBody = { ok: true, id: "tool", status: "wired" };
  const ok = await connectorAction(
    REPO,
    "store-existing",
    "tool",
    {},
    impl({ storeExisting: async () => okBody })
  );
  assert.deepEqual(ok, { status: 200, body: okBody });
});

test("unknown connector / unexpected engine error → 500, never a throw", async () => {
  const r = await connectorAction(
    REPO,
    "unwire",
    "nope",
    {},
    impl({
      descriptor: () => {
        throw new Error("unknown connector 'nope'");
      },
    })
  );
  assert.equal(r.status, 500);
  assert.match(r.body.error, /unknown connector/);
});

test("cmdConnector: usage errors print a 400 result and return exit status 1", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    assert.equal(await cmdConnector(REPO, ["bogus"]), 1);
    assert.equal(await cmdConnector(REPO, ["unwire"]), 1); // id required
  } finally {
    console.log = orig;
  }
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, 400);
    assert.match(parsed.body.error, /usage: aios connector/);
  }
});

test("catalog: --json prints the parsed skills + integrations for a workspace", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-catalog-"));
  try {
    mkdirSync(path.join(repo, ".claude", "skills", "demo"), { recursive: true });
    writeFileSync(
      path.join(repo, ".claude", "skills", "demo", "SKILL.md"),
      "---\nname: demo\nkind: skill\ndescription: Does a demo. Slowly.\n---\n"
    );
    writeFileSync(
      path.join(repo, ".claude", "integrations.json"),
      JSON.stringify({ integrations: [{ name: "Tool", category: "web", status: "wired" }] })
    );
    const parsed = catalogJson(repo);
    assert.equal(parsed.skills.length, 1);
    assert.equal(parsed.skills[0].id, "demo");
    assert.equal(parsed.skills[0].description, "Does a demo. Slowly.");
    assert.equal(parsed.integrations[0].name, "Tool");

    const lines = [];
    const orig = console.log;
    console.log = (s) => lines.push(s);
    try {
      cmdCatalog(repo, ["--json"]);
    } finally {
      console.log = orig;
    }
    assert.deepEqual(JSON.parse(lines[0]), parsed);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
