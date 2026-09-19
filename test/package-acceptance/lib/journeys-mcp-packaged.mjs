/**
 * Is the installer capability actually IN the installed package, pinned to the artifact
 * this release names? Checks the shipped module set, the runtime dependencies inside the
 * install prefix, the pins against literals and against the live registry bytes, and that
 * the installed decoder refuses a tampered copy of those bytes.
 */
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as S from "./mcp-support.mjs";

export const VERSION = "0.2.1";
export const INTEGRITY =
  "sha512-+YNY05QMYyNwC56U3V5oFS7uKToSr9mTNGZeha1waq8grhB32WyHnluRnKS6mO4LKi8ueiEpI4H3xDknR5Pb1Q==";
export const BRAIN = [
  "brain_get_item",
  "brain_pull_items",
  "brain_query",
  "brain_search_evidence",
  "brain_status",
];
const BOARD = [
  "brain_list_decisions",
  "brain_list_projects",
  "brain_list_tasks",
  "brain_stakeholders",
];
export const TEAM = [...BRAIN, ...BOARD].sort();
const PACKAGED = [
  ...["mcp-hosts", "mcp-host-artifact", "mcp-host-install", "mcp-host-command", "mcp-host-errors"],
  ...["mcp-host-files", "mcp-host-formats", "mcp-host-atomic", "mcp-host-acl"],
  ...["mcp-credentials", "mcp-config", "onboard-command", "onboard-ui", "aios"],
].map((name) => path.join("scripts", `${name}.mjs`));
export async function packagedCapability(ctx, install, state) {
  for (const file of PACKAGED)
    assert.ok(existsSync(path.join(install.pkgDir, file)), `installed package ships ${file}`);
  // Node resolution by hand (walk up node_modules): exports maps hide package.json.
  const prefix = realpathSync(install.prefix);
  for (const dependency of ["koffi", "smol-toml", "@clack/prompts", "@dotenvx/dotenvx"]) {
    let found = null;
    for (let dir = realpathSync(install.pkgDir); !found; dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", dependency, "package.json");
      if (existsSync(candidate)) found = realpathSync(candidate);
      if (dir === path.dirname(dir)) break;
    }
    assert.ok(
      found?.startsWith(`${prefix}${path.sep}`),
      `${dependency} is installed inside the prefix`
    );
  }
  // Pins as the INSTALLED package declares them, checked against literals and the registry.
  const load = (name) => import(pathToFileURL(path.join(install.pkgDir, "scripts", name)).href);
  const hosts = await load("mcp-hosts.mjs");
  const artifact = await load("mcp-host-artifact.mjs");
  assert.equal(hosts.MCP_PACKAGE_VERSION, VERSION);
  assert.equal(artifact.MCP_PACKAGE_INTEGRITY, INTEGRITY);
  assert.deepEqual([...hosts.MCP_PACKAGE_TOOLSETS.brain].sort(), BRAIN);
  assert.deepEqual([...hosts.MCP_PACKAGE_TOOLSETS.board].sort(), BOARD);
  const response = await fetch(`https://registry.npmjs.org/@aiosbrain/mcp/-/mcp-${VERSION}.tgz`, {
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.ok, true, "registry serves the pinned MCP tarball");
  const tarball = Buffer.from(await response.arrayBuffer());
  assert.equal(S.sri(tarball), INTEGRITY, "registry bytes match the pinned integrity");
  state.registryFiles = S.untar(tarball);
  assert.equal(state.registryFiles.size, 15, "pinned closure is 15 files");
  // The INSTALLED decoder accepts exactly these bytes and refuses a one-bit difference,
  // wherever in the archive it falls (gzip header, payload, trailer).
  const decoded = artifact.decodeServerArtifact(tarball);
  assert.deepEqual([...decoded.keys()].sort(), [...state.registryFiles.keys()].sort());
  for (const at of [0, Math.floor(tarball.length / 2), tarball.length - 1]) {
    const tampered = Buffer.from(tarball);
    tampered[at] ^= 0x01;
    assert.throws(
      () => artifact.decodeServerArtifact(tampered),
      /MCP package integrity mismatch/,
      `a flipped bit at byte ${at} is refused before unpacking`
    );
  }
  assert.throws(() => artifact.decodeServerArtifact(tarball.subarray(0, -1)), /integrity mismatch/);
  state.targets = (home, project) =>
    hosts
      .hostTargets({ home, project, env: S.isolatedEnv(ctx, home) })
      .filter((row) => row.supported);
  state.supported = state.targets(state.root, state.root).map((row) => row.id);
  // Installing the toolkit configured no host and stored nothing MCP-related.
  for (const leftover of [
    ".cursor",
    ".codex",
    path.join(".aios", "mcp"),
    path.join(".aios", "credentials.json"),
  ])
    assert.ok(!existsSync(path.join(ctx.home, leftover)), `npm install created no ${leftover}`);
  return {
    tamperedArtifactRejected: true,
    files: PACKAGED.length,
    nativeDependency: "koffi resolved in prefix",
    supportedHosts: state.supported,
  };
}
