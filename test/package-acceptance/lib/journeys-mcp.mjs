/**
 * AIO-1112 MCP host installer acceptance, against the digest-verified INSTALLED package.
 *
 * What is real: the public CLI (`node <pkg>/scripts/aios.mjs`, never a .bin shim), argument
 * dispatch and typed errors, the registry download of the pinned @aiosbrain/mcp tarball,
 * integrity + closure checks, native atomic writes (Koffi) and ownership/ACL policy,
 * credential validation over a real fetch, and the launched server subprocess answering
 * initialize / tools/list / tools/call. No command or verifier is injected anywhere.
 *
 * What is fixtured, and only this: (1) the Team Brain is a loopback process serving
 * synthetic identities; (2) the installer's process-table query is answered from a list
 * (mcp-fixture-preload.mjs) so results never depend on — or require closing — the apps open
 * on the machine; (3) for onboarding, stdin is presented as a terminal. Host LOADING is
 * not claimed: no real host application is started or configured, and every profile is an
 * isolated HOME/USERPROFILE/APPDATA under the cell's temp directory.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { legacyUpgrade } from "./journeys-mcp-legacy.mjs";
import { BRAIN, INTEGRITY, TEAM, VERSION, packagedCapability } from "./journeys-mcp-packaged.mjs";
import { onboardingCases } from "./journeys-mcp-onboarding.mjs";
import * as S from "./mcp-support.mjs";

const OTHER_TOKEN = "SENTINEL_other_server_aio1112_must_survive_2d9f";
const CODEX_SEED =
  '# Preserve this exact text\nmodel = "example"\nlarge = 9223372036854775807\n[mcp_servers.other]\ncommand = "other"\n';
const json = (stdout) => JSON.parse(stdout.slice(stdout.indexOf("{")));
const read = (file) => readFileSync(file, "utf8");

/** Stat-only fingerprint of the REAL user's host/AIOS MCP files: never read, never written. */
function realProfileFingerprint() {
  const home = homedir();
  return [
    [".cursor", "mcp.json"],
    [".codex", "config.toml"],
    ["Library", "Application Support", "Claude", "claude_desktop_config.json"],
    ["AppData", "Roaming", "Claude", "claude_desktop_config.json"],
    [".aios", "credentials.json"],
    [".aios", "mcp-installations.json"],
    [".aios", "mcp", VERSION, "package.json"],
  ].map((parts) => {
    try {
      const stat = statSync(path.join(home, ...parts));
      return [stat.size, stat.mtimeMs];
    } catch {
      return null;
    }
  });
}

function seed(home, project, hosts) {
  const seeds = {
    cursor: JSON.stringify({
      mcpServers: { other: { command: "other", env: { TOKEN: OTHER_TOKEN } } },
      preferences: { theme: "dark" },
    }),
    "claude-code": JSON.stringify({ mcpServers: { project_tool: { command: "project-tool" } } }),
    codex: CODEX_SEED,
  };
  for (const host of hosts) if (seeds[host.id]) S.put(host.file, seeds[host.id], home);
  return seeds;
}

async function lifecycle(ctx, state, brain) {
  const home = S.makeDir(path.join(state.root, "lifecycle", "home"), state.root);
  const project = S.makeDir(path.join(home, "project"), state.root);
  const neutral = S.makeDir(path.join(state.root, "lifecycle", "neutral"), state.root);
  const hosts = state.targets(home, project);
  const ids = hosts.map((host) => host.id).join(",");
  const seeds = seed(home, project, hosts);
  const credentials = { AIOS_BRAIN_URL: brain.origin, AIOS_API_KEY: S.KEYS.team };
  const at = { home, cwd: project, env: credentials, processes: S.UNRELATED_PROCESSES };
  const managed = () =>
    process.platform !== "win32"
      ? S.tree(home)
      : Object.fromEntries(
          // A real Windows server launch may touch PowerShell's own profile cache.
          Object.entries(S.tree(home)).filter(([file]) =>
            /^(\.aios|\.cursor|\.codex|project|AppData)/.test(file)
          )
        );
  const cases = {};
  const pristine = managed();

  // A selected running host refuses, typed and actionable, before anything is written.
  const refused = S.cli(ctx, state, ["mcp", "install", "--host", ids], {
    ...{ ...at, expectFailure: true, label: "mcp-install-running-host" },
    processes: [...S.UNRELATED_PROCESSES, "/opt/cursor/cursor --no-sandbox", "Cursor"],
  });
  assert.equal(refused.status, 5, "running selected host → AIOS_E_CONFLICT");
  assert.match(
    refused.stderr,
    /AIOS_E_CONFLICT.*Cursor is running\. .*quit it now before retrying/s
  );
  assert.deepEqual(managed(), pristine, "refusal wrote nothing");
  // …while the same process table does not block a selection that excludes that host.
  const others = hosts
    .filter((host) => host.id !== "cursor")
    .map((host) => host.id)
    .join(",");
  const unblocked = json(
    S.cli(ctx, state, ["mcp", "install", "--host", others, "--dry-run"], {
      ...{ ...at, label: "mcp-dry-run-unselected-host-running" },
      processes: [...S.UNRELATED_PROCESSES, "Cursor"],
    }).stdout
  );
  assert.equal(unblocked.dry_run, true);
  cases.runningHost = {
    selectedRunning: "refused AIOS_E_CONFLICT, no writes",
    unselectedRunning: "not blocking",
  };

  // Dry-run: validates, downloads, proposes — and changes nothing, not even ~/.aios.
  const dry = S.cli(ctx, state, ["mcp", "install", "--host", ids, "--dry-run"], {
    ...at,
    label: "mcp-dry-run",
  });
  assert.equal(json(dry.stdout).dry_run, true);
  assert.equal(json(dry.stdout).changes.length, hosts.length);
  assert.ok(!dry.stdout.includes(OTHER_TOKEN), "dry-run output omits other servers' secrets");
  assert.deepEqual(managed(), pristine, "dry-run left bytes, modes and mtimes untouched");
  assert.ok(!existsSync(path.join(home, ".aios")), "dry-run created no state directory");
  cases.dryRun = { proposals: hosts.length, treeUnchanged: true };

  // The main positive: real download, native writes, real server verification.
  await brain.drain();
  const before = brain.requests.length;
  const replaced = hosts.filter((host) => ["cursor", "codex"].includes(host.id));
  const priorInodes = replaced.map((host) => statSync(host.file, { bigint: true }).ino);
  const installed = json(
    S.cli(ctx, state, ["mcp", "install", "--host", ids], { ...at, label: "mcp-install" }).stdout
  );
  await brain.drain();
  for (const [index, host] of replaced.entries()) {
    assert.notEqual(priorInodes[index], 0n, "seed file has a native file identity");
    assert.notEqual(
      statSync(host.file, { bigint: true }).ino,
      priorInodes[index],
      `${host.id} existing file was atomically replaced, not overwritten in place`
    );
  }
  assert.equal(installed.tier, "team");
  const [verification] = installed.command_verification;
  assert.equal(verification.verified, true);
  assert.equal(verification.version, VERSION);
  assert.deepEqual([...verification.tools].sort(), TEAM);
  assert.ok(
    installed.changes.every((row) => row.action === "install" && row.host_loading === "unverified")
  );
  const root = path.join(home, ".aios", "mcp", VERSION);
  for (const [name, bytes] of state.registryFiles)
    assert.ok(
      readFileSync(path.join(root, name)).equals(bytes),
      `installed ${name} is the pinned byte sequence`
    );
  assert.equal(
    Object.keys(S.tree(root)).filter((name) => S.tree(root)[name][2] !== "directory").length,
    15
  );
  for (const host of hosts) {
    const text = read(host.file);
    assert.deepEqual(S.leaks(text), [], `${host.id} configuration holds no credential`);
    assert.ok(text.includes("AIOS_MCP_INSTALLER"), `${host.id} entry carries the ownership marker`);
  }
  const cursor = hosts.find((host) => host.id === "cursor");
  assert.equal(JSON.parse(read(cursor.file)).mcpServers.other.env.TOKEN, OTHER_TOKEN);
  assert.deepEqual(JSON.parse(read(cursor.file)).preferences, { theme: "dark" });
  assert.ok(read(hosts.find((host) => host.id === "codex").file).startsWith(CODEX_SEED));
  const stored = JSON.parse(read(path.join(home, ".aios", "credentials.json")));
  assert.equal(
    stored.default.api_key,
    S.KEYS.team,
    "the key lives only in the owner-only credential file"
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(path.join(home, ".aios", "credentials.json")).mode & 0o077, 0);
    assert.equal(statSync(path.join(home, ".aios")).mode & 0o077, 0);
  }
  if (process.platform === "win32") {
    S.assertOwnerOnlyAcl(ctx, home, [
      path.join(home, ".aios"),
      path.join(home, ".aios", "credentials.json"),
      path.join(home, ".aios", "mcp-installations.json"),
      root,
      path.join(root, "bin", "aios-brain-mcp.mjs"),
    ]);
    cases.ownerOnlyAcl = true;
  }
  const discovery = read(state.processLog).trim().split("\n").length;
  assert.ok(discovery >= 2, "process discovery ran at preflight and again before replacement");
  assert.ok(
    brain.requests.length - before >= 2,
    "installer and launched server validated identity"
  );
  assert.ok(
    brain.requests.slice(before).every((row) => row.path === "/api/v1/me" && row.status === 200)
  );
  cases.install = {
    hosts: hosts.map((host) => host.id),
    tier: "team",
    tools: TEAM.length,
    closureBytes: "identical to registry",
    nativeReplacement: true,
    unrelatedPreserved: true,
  };

  // Independent oracle: speak MCP to the RECORDED command from a neutral directory.
  const entry = JSON.parse(read(cursor.file)).mcpServers["aios-brain"];
  assert.equal(entry.command, process.execPath);
  assert.deepEqual(entry.args, [
    path.join(root, "bin", "aios-brain-mcp.mjs"),
    "--toolsets",
    "brain,board",
  ]);
  const launch = { command: entry.command, args: entry.args };
  const team = await S.rpc(launch, {
    cwd: neutral,
    env: S.isolatedEnv(ctx, home, entry.env),
    calls: [{ name: "brain_search_evidence", arguments: { query: "acceptance", limit: 1 } }],
  });
  assert.equal(team(1).protocolVersion, "2025-11-25");
  assert.deepEqual(team(1).serverInfo, { name: "@aiosbrain/mcp", version: VERSION });
  assert.deepEqual(
    team(2)
      .tools.map((tool) => tool.name)
      .sort(),
    TEAM
  );
  assert.ok(team(2).tools.every((tool) => tool.annotations?.readOnlyHint === true));
  assert.notEqual(team(3).isError, true, "brain_search_evidence succeeded");
  assert.match(team(3).content[0].text, /Synthetic acceptance evidence passage/);
  // A tier-limited identity (supplied by environment, which outranks the stored tuple).
  const external = await S.rpc(launch, {
    cwd: neutral,
    env: S.isolatedEnv(ctx, home, { AIOS_BRAIN_URL: brain.origin, AIOS_API_KEY: S.KEYS.external }),
  });
  assert.deepEqual(
    external(2)
      .tools.map((tool) => tool.name)
      .sort(),
    BRAIN
  );
  cases.server = {
    launchedFrom: "neutral cwd",
    team: TEAM.length,
    external: BRAIN.length,
    evidenceSearch: "ok",
  };

  // Idempotent repeat, then status through the stored credential and through the environment.
  const settled = managed();
  const repeat = json(
    S.cli(ctx, state, ["mcp", "install", "--host", ids], { ...at, label: "mcp-install-repeat" })
      .stdout
  );
  assert.ok(repeat.changes.every((row) => row.action === "unchanged"));
  assert.deepEqual(managed(), settled, "a repeated install rewrites nothing");
  for (const [source, env] of [
    ["global-file", {}],
    ["environment", credentials],
  ]) {
    const report = json(
      S.cli(ctx, state, ["mcp", "status", "--json"], { ...at, env, label: `mcp-status-${source}` })
        .stdout
    );
    for (const row of report.mcp_hosts.filter((host) => host.supported)) {
      assert.ok(
        row.configured && row.owned && row.command_verification.verified,
        `${row.id} status`
      );
      assert.equal(row.credential_source, source);
      assert.equal(row.host_loading, "unverified");
    }
  }
  cases.repeatAndStatus = {
    repeat: "unchanged",
    credentialSources: ["global-file", "environment"],
    hostLoading: "unverified",
  };

  // An edited entry is refused on install and preserved on uninstall.
  const owned = read(cursor.file);
  const edited = JSON.parse(owned);
  edited.mcpServers["aios-brain"].args.push("--edited-by-user");
  S.put(cursor.file, JSON.stringify(edited, null, 2), home);
  const editedTree = managed();
  const overwrite = S.cli(ctx, state, ["mcp", "install", "--host", "cursor"], {
    ...at,
    expectFailure: true,
    label: "mcp-install-edited",
  });
  assert.equal(overwrite.status, 5);
  assert.match(
    overwrite.stderr,
    /Cursor: refusing to overwrite an edited or unowned aios-brain entry/
  );
  const kept = json(
    S.cli(ctx, state, ["mcp", "install", "--host", "cursor", "--uninstall"], {
      ...at,
      label: "mcp-uninstall-edited",
    }).stdout
  );
  assert.match(kept.changes[0].action, /preserved/);
  assert.deepEqual(
    managed(),
    editedTree,
    "an edited entry survives install and uninstall untouched"
  );
  S.put(cursor.file, owned, home);
  cases.editedEntry = { install: "refused AIOS_E_CONFLICT", uninstall: "preserved" };

  // Uninstall restores every host and keeps the shared credential.
  const removed = json(
    S.cli(ctx, state, ["mcp", "install", "--host", ids, "--uninstall"], {
      ...at,
      label: "mcp-uninstall",
    }).stdout
  );
  assert.ok(removed.changes.every((row) => row.action === "remove"));
  assert.equal(
    read(hosts.find((host) => host.id === "codex").file),
    CODEX_SEED,
    "TOML returns byte-identical"
  );
  for (const id of ["cursor", "claude-code"])
    assert.deepEqual(
      JSON.parse(read(hosts.find((host) => host.id === id).file)),
      JSON.parse(seeds[id])
    );
  for (const host of hosts) assert.ok(!read(host.file).includes("AIOS_MCP_INSTALLER"));
  assert.ok(existsSync(path.join(home, ".aios", "credentials.json")));
  assert.deepEqual(
    JSON.parse(read(path.join(home, ".aios", "mcp-installations.json"))).installations,
    []
  );
  cases.uninstall = { hostsRestored: hosts.length, credentials: "preserved" };
  return cases;
}

function scaffoldWorkspace(ctx, install, state) {
  const workspace = path.join(state.root, "onboard-template");
  ctx.runWithAmbientEnv(
    "bash",
    [
      path.join(install.pkgDir, "scripts", "scaffold-project.sh"),
      ...["--context", "consultant", "--slug", "mcp-acceptance", "--owner", "alex"],
      ...["--stakeholder", "Sample Co", "--team", "alex,sam", "--org", "your-github-org"],
      ...["--currency", "USD", "--output", workspace],
    ],
    { label: "mcp-onboard-scaffold" }
  );
  return workspace;
}

/** Operator entry point: `await mcpHostJourney(ctx, install)` with install = {prefix,pkgDir,bin}. */
export async function mcpHostJourney(ctx, install) {
  const root = S.makeDir(path.join(realpathSync(ctx.base), "mcp-host"));
  const state = {
    root,
    entry: path.join(install.pkgDir, "scripts", "aios.mjs"),
    processList: path.join(root, "process-table.json"),
    processLog: path.join(root, "process-discovery.log"),
  };
  const realProfile = realProfileFingerprint();
  const brain = await S.startBrain(ctx);
  const cases = {};
  try {
    const packaged = await packagedCapability(ctx, install, state);
    Object.assign(cases, await lifecycle(ctx, state, brain));
    cases.legacyUpgrade = await legacyUpgrade(ctx, state, brain, { VERSION, TEAM });
    cases.onboarding =
      process.platform === "win32"
        ? { skipped: "the workspace scaffolder is bash; Windows cells cover the installer only" }
        : await onboardingCases(ctx, state, brain, scaffoldWorkspace(ctx, install, state));
    assert.deepEqual(
      realProfileFingerprint(),
      realProfile,
      "the real user profile was not touched"
    );
    await brain.drain();
    assert.ok(brain.requests.length > 0, "the real CLI contacted the synthetic Brain");
    const unexpected = brain.requests.filter(
      (row) => !["/api/v1/me", "/api/v1/evidence/search"].includes(row.path)
    );
    assert.deepEqual(unexpected, [], "the synthetic Brain saw only identity and evidence requests");
    ctx.record("mcp-host-install", {
      toolkitVersion: ctx.manifest.packageVersion,
      artifact: {
        name: "@aiosbrain/mcp",
        version: VERSION,
        integrity: INTEGRITY,
        closureFiles: 15,
      },
      membership: { team: TEAM, external: BRAIN },
      packaged,
      cases,
      boundaries: {
        real: "installed CLI dispatch, registry download, integrity/closure, native writes, credential validation, server subprocess",
        fixtured:
          "loopback synthetic Brain; process-table query answered from a list; scripted terminal for onboarding",
        notClaimed: "host loading/restart in a real host application; onboarding Create→Join",
      },
      realProfile: "stat fingerprint unchanged",
    });
  } finally {
    await brain.stop();
  }
}
