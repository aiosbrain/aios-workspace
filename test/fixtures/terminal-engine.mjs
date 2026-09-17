import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { legacyContext } from "../../scripts/aios-runtime.mjs";
import { loadState } from "../../scripts/sync-plan.mjs";
import { cmdConnect } from "../../scripts/connect-command.mjs";
const root = mkdtempSync(path.join(tmpdir(), "terminal-engine-"));
const originalFetch = globalThis.fetch;
Object.defineProperty(process.stdout, "isTTY", { value: true });
process.env.AIOS_UI_TIER = "rich";
process.env.TERM = "xterm-256color";
process.env.AIOS_UI_MOTION = "0";
delete process.env.CI;
const { cmdPush, cmdPull, cmdStatus, connectFlow } = legacyContext().local;
const cfg = {
  project_members: [],
  member: "fixture",
  project: "fixture",
  brain_url: "https://brain.example",
  api_key: "fixture-token",
  sync_include: ["2-work"],
  sync_exclude: [],
  sync_tiers: ["team"],
};
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
try {
  mkdirSync(path.join(root, "2-work"));
  mkdirSync(path.join(root, "1-inbox"));
  await cmdStatus(root, { ...cfg, brain_url: "" }, [], []);
  for (const name of ["a", "b"])
    writeFileSync(
      path.join(root, `2-work/${name}.md`),
      `---\naccess: team\nkind: deliverable\n---\n# ${name}\n`
    );
  writeFileSync(path.join(root, "2-work/private.md"), "---\naccess: admin\n---\n# Private\n");
  const posted = [],
    events = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    posted.push(payload.path);
    return payload.path.endsWith("a.md")
      ? response({ id: "a", status: "created" })
      : response({ error: "fixture rejection" }, 403);
  };
  const pushed = await cmdPush(root, cfg, [], [], {
    onProgress(event) {
      events.push(event);
      throw new Error("observer unavailable");
    },
  });
  assert.deepEqual(posted, ["2-work/a.md", "2-work/b.md"]);
  assert.equal(pushed.pushed.size, 1);
  assert.equal(pushed.failed.size, 1);
  assert.equal(pushed.blocked.size, 1);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.deepEqual(
    events.map((e) => [e.completed, e.total]),
    [
      [0, 2],
      [1, 2],
    ]
  );
  assert.deepEqual(Object.keys(loadState(root).items), ["2-work/a.md"]);
  globalThis.fetch = async () => response({}, 404);
  await cmdStatus(root, cfg, [], []);
  const routes = [];
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    routes.push(route);
    if (route.endsWith("/items"))
      return response({
        items: [{ project: "other", path: "note.md", body: "# Note", access: "team" }],
      });
    if (route.endsWith("/projects"))
      return response({
        projects: [{ slug: "new-project", name: "New project", brain_only: true }],
      });
    return response({ tasks: [], decisions: [] });
  };
  await cmdPull(root, cfg, [], {
    onProgress() {
      throw new Error("observer unavailable");
    },
  });
  assert.ok(loadState(root).last_pull);
  assert.ok(
    readFileSync(path.join(root, "1-inbox/from-brain/other__note.md"), "utf8").includes("# Note")
  );
  assert.ok(routes[0].endsWith("/items"));
  assert.ok(routes[1].endsWith("/tasks"));
  const before = readFileSync(path.join(root, ".aios/state.json"), "utf8");
  globalThis.fetch = async (url) =>
    new URL(url).pathname.endsWith("/items")
      ? response({
          items: [{ project: "other", path: "second.md", body: "# Second", access: "team" }],
        })
      : response({ error: "fixture auth failure" }, 403);
  await assert.rejects(cmdPull(root, cfg), /403/);
  assert.ok(
    readFileSync(path.join(root, "1-inbox/from-brain/other__second.md"), "utf8").includes(
      "# Second"
    )
  );
  assert.equal(readFileSync(path.join(root, ".aios/state.json"), "utf8"), before);
  const descriptor = {
    id: "fixture",
    name: "Fixture",
    transport: "mcp",
    secrets: [],
    mcp: { server_key: "fixture", command: "node", args: [] },
  };
  assert.equal(await connectFlow(root, descriptor, { ask: async () => "" }), true);
  assert.equal(
    await connectFlow(
      root,
      { ...descriptor, secrets: [{ env: "FIXTURE", label: "Fixture" }] },
      { ask: async () => "" }
    ),
    false
  );
  globalThis.fetch = async () => response({ error: "rejected" }, 401);
  assert.equal(
    await connectFlow(
      root,
      { ...descriptor, validate: { url: "https://provider.example" } },
      { ask: async () => "" }
    ),
    false
  );
  let delegated;
  await cmdConnect(root, ["firecrawl", "--token", "fixture", "--set", "EXTRA=a=b"], {
    connectFlow: async (_repo, _descriptor, values) => {
      delegated = values;
      return true;
    },
  });
  assert.equal(delegated.tokenFlag, "fixture");
  assert.equal(delegated.sets.EXTRA, "a=b");
  await cmdConnect(root, [], { connectFlow });
  console.log("ENGINE_CONTRACTS_OK");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
}
