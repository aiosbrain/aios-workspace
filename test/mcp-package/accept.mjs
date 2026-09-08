// Runs with built-ins only, outside any AIOS checkout. Never imports repository code.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const artifact = process.argv[2];
const fixture = JSON.parse(process.env.MCP_PACKAGE_FIXTURE);
const candidate = JSON.parse(readFileSync(path.join(artifact, "candidate.json"), "utf8"));
assert.equal(candidate.packageName, "@aiosbrain/mcp");
assert.match(candidate.tarball, /^[a-zA-Z0-9_.-]+\.tgz$/);
const tarball = path.join(artifact, candidate.tarball);
const bytes = readFileSync(tarball);
assert.equal(createHash("sha256").update(bytes).digest("hex"), candidate.sha256);
assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, candidate.integrity);
const root = mkdtempSync(path.join(tmpdir(), "mcp-accept-"));
const home = path.join(root, "home");
const project = path.join(root, "project");
mkdirSync(home, { mode: 0o700 });
mkdirSync(project, { mode: 0o700 });
const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  npm_config_cache: path.join(root, "npm-cache"),
};
const npm = (args) =>
  execFileSync("npm", args, {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
let child;
let lines;
let killTimer;
let stdout = "";
let stderr = "";
const calls = new Map();
const results = {};
let nextId = 0;
try {
  const globalPackages = JSON.parse(npm(["ls", "--global", "--depth=0", "--json"]));
  assert.ok(!globalPackages.dependencies?.aios, "Acceptance environment must not have global aios");
  let install = tarball;
  if (process.env.MCP_REGISTRY_ACCEPTANCE === "1") {
    const metadata = JSON.parse(
      npm(["view", `${candidate.packageName}@${candidate.version}`, "dist.integrity", "--json"])
    );
    if (Array.isArray(metadata)) assert.equal(metadata.length, 1);
    const integrity = Array.isArray(metadata) ? metadata[0] : metadata;
    assert.equal(integrity, candidate.integrity, "Registry must contain the verified tarball");
    install = `${candidate.packageName}@${candidate.version}`;
  }
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", install]);
  const installed = path.join(project, "node_modules/@aiosbrain/mcp");
  const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  assert.equal(manifest.version, candidate.version);
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "scripts",
  ])
    assert.equal(Object.keys(manifest[field] || {}).length, 0, field);
  assert.deepEqual(readdirSync(path.join(project, "node_modules")).sort(), [
    ".bin",
    ".package-lock.json",
    "@aiosbrain",
  ]);
  assert.deepEqual(readdirSync(path.join(project, "node_modules/@aiosbrain")), ["mcp"]);
  mkdirSync(path.join(home, ".aios"), { mode: 0o700 });
  writeFileSync(
    path.join(home, ".aios/credentials.json"),
    JSON.stringify({
      version: 1,
      default: { brain_url: fixture.url, api_key: fixture.key, team_id: fixture.team },
    }),
    { mode: 0o600 }
  );
  const bin = path.join(project, "node_modules/.bin/aios-brain-mcp");
  const guard = fileURLToPath(new URL("./import-guard.mjs", import.meta.url));
  child = spawn(process.execPath, ["--import", guard, bin], {
    cwd: project,
    env: { ...env, MCP_INSTALL_ROOT: installed },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // Every stdout line must be a protocol response; diagnostics cannot hide in framing.
  lines = createInterface({ input: child.stdout });
  let protocolFailure;
  lines.on("line", (line) => {
    stdout += line + "\n";
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0");
      const pending = calls.get(message.id);
      assert.ok(pending, "Unexpected protocol message");
      clearTimeout(pending.timer);
      calls.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    } catch (error) {
      protocolFailure = error;
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("close", (code) => {
    for (const pending of calls.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`MCP exited (${code}): ${stderr.replaceAll(fixture.key, "[REDACTED]")}`)
      );
    }
    calls.clear();
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(
          new Error(
            `Protocol timeout: ${method}; stderr: ${stderr.replaceAll(fixture.key, "[REDACTED]")}`
          )
        );
      }, 45000);
      calls.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "isolated-package-acceptance", version: "1" },
  });
  assert.equal(initialized.protocolVersion, "2025-11-25");
  assert.deepEqual(initialized.serverInfo, {
    name: candidate.packageName,
    version: candidate.version,
  });
  assert.match(initialized.instructions, /read.only/i);
  const expected = [
    "brain_status",
    "brain_query",
    "brain_list_projects",
    "brain_list_tasks",
    "brain_list_decisions",
    "brain_pull_items",
    "brain_get_item",
    "brain_stakeholders",
  ];
  const listed = await rpc("tools/list");
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...expected].sort());
  for (const tool of listed.tools) assert.equal(tool.annotations.readOnlyHint, true);
  const invoke = async (name, args = {}) => {
    const result = await rpc("tools/call", { name, arguments: args });
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
    const value = JSON.parse(result.content[0].text);
    results[name] = value;
    return value;
  };
  assert.equal((await invoke("brain_status")).connected, true);
  const query = await invoke("brain_query", {
    question: "What color is the synthetic lighthouse launch?",
    project: "acme",
  });
  assert.match(query.answer, /violet.*\[S\d+\]/);
  assert.ok(
    Array.isArray(query.sources) && query.sources.length > 0,
    "Cited sources must be nonempty"
  );
  assert.ok(
    JSON.stringify(query.sources).includes(fixture.itemId),
    "Citation must identify the ingested item"
  );
  assert.ok(JSON.stringify(await invoke("brain_list_projects")).includes("acme"));
  const tasks = await invoke("brain_list_tasks");
  assert.ok(JSON.stringify(tasks).includes("MCP lighthouse checklist"), JSON.stringify(tasks));
  const decisions = await invoke("brain_list_decisions");
  assert.ok(
    JSON.stringify(decisions).includes("Lighthouse launch is violet"),
    JSON.stringify(decisions)
  );
  const items = await invoke("brain_pull_items", { path_prefix: "2-work/mcp-package" });
  assert.ok(items.items.some((item) => item.id === fixture.itemId && item.body.includes("violet")));
  const item = await invoke("brain_get_item", { id: fixture.itemId });
  assert.ok(
    JSON.stringify(item).includes(fixture.itemId) && JSON.stringify(item).includes("violet")
  );
  const people = await invoke("brain_stakeholders", { meeting: "MCP lighthouse" });
  assert.ok(people.meetings.some((meeting) => meeting.participants.includes("Synthetic Alex")));
  assert.deepEqual(Object.keys(results).sort(), [...expected].sort());
  child.stdin.end();
  killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  assert.equal(await closed, 0, "MCP must exit cleanly");
  if (protocolFailure) throw protocolFailure;
  assert.ok(
    !stdout.includes(fixture.key) && !stderr.includes(fixture.key),
    "Credential leaked into protocol or diagnostics"
  );
  console.log(
    JSON.stringify({
      packageName: candidate.packageName,
      version: candidate.version,
      tarballSha256: candidate.sha256,
      node: process.version,
      tools: expected,
      citations: query.sources.length,
      registry: process.env.MCP_REGISTRY_ACCEPTANCE === "1",
    })
  );
} finally {
  clearTimeout(killTimer);
  for (const pending of calls.values()) clearTimeout(pending.timer);
  lines?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGKILL");
    await closed;
  }
  rmSync(root, { recursive: true, force: true });
}
console.log("MCP_PROCESS_CLEANUP_OK");
