// Fresh registry installation after publication, in a container without a checkout.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const candidate = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(candidate.packageName, "@aiosbrain/mcp");
assert.match(candidate.version, /^\d+\.\d+\.\d+$/);
const root = mkdtempSync(path.join(tmpdir(), "mcp-registry-"));
try {
  const home = path.join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, npm_config_cache: path.join(root, "cache") };
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      `@aiosbrain/mcp@${candidate.version}`,
    ],
    { cwd: root, env, stdio: "inherit", timeout: 120000 }
  );
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/@aiosbrain/mcp"].integrity, candidate.integrity);
  const request = (id, method, params = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const child = spawnSync(process.execPath, [path.join(root, "node_modules/.bin/aios-brain-mcp")], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10000,
    input:
      request(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "registry-smoke", version: "1" },
      }) +
      "\n" +
      request(2, "tools/list") +
      "\n",
  });
  assert.equal(child.status, 0, child.stderr);
  const messages = child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].result.serverInfo, {
    name: candidate.packageName,
    version: candidate.version,
  });
  assert.equal(messages[0].result.protocolVersion, "2025-11-25");
  assert.deepEqual(messages[1].result.tools, [], "Unconfigured standalone must fail closed");
  console.log(
    JSON.stringify({
      registryInstallation: "verified",
      packageName: candidate.packageName,
      version: candidate.version,
      integrity: candidate.integrity,
      node: process.version,
    })
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
