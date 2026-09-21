/**
 * Onboarding reachability for the MCP offer, against the INSTALLED public CLI.
 *
 * `aios onboard` runs for real — dispatch, workspace inspection, clack prompts, Brain
 * `/me` validation, the offer branch and the installer. The journey answers the rendered
 * prompts over a scripted terminal (mcp-fixture-preload.mjs) and the installer's process
 * discovery is answered from a fixture list; nothing in onboarding or the installer is
 * stubbed. Every case asserts on the far end: what is on disk afterwards.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { KEYS, UNRELATED_PROCESSES, drive, leaks, makeDir } from "./mcp-support.mjs";

const OFFER = /Connect your Brain to an MCP host now\?/;
const DOWN = "\u001b[B";

/** Keys for the prompts that precede the Brain connection, per onboarding path. */
const opening = (pathKeys) => [
  { expect: /How should this workspace operate\?/, send: pathKeys },
  // Present only when the install layout exposes an upgradeable toolkit checkout.
  { expect: /Apply the previewed managed-file update/, send: "\r", optional: true },
  { expect: /Are you actively building a codebase with AI\?/, send: "\r", optional: true },
];
const connectBrain = (origin, key) => [
  { expect: /Connect a few things/, send: "\r" }, // Team Brain is pre-selected on Join
  { expect: /Team Brain URL/, send: `${origin}\r` },
  { expect: /AIOS_API_KEY:/, send: `${key}\r` },
];
const closing = [{ expect: /Set up your profile now/, send: "\r" }, { expect: /best next step/ }];

/**
 * What an MCP installation would leave behind, anywhere it could land. A scaffolded
 * workspace already ships an empty project `.mcp.json`, so project files are compared
 * with the template byte-for-byte rather than by existence.
 */
function mcpFootprint(home, template, ...projects) {
  const found = [];
  const aios = path.join(home, ".aios");
  if (existsSync(aios))
    found.push(...readdirSync(aios).filter((name) => /^(mcp|credentials)/.test(name)));
  for (const candidate of [
    path.join(home, ".cursor", "mcp.json"),
    path.join(home, ".codex", "config.toml"),
    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  ])
    if (existsSync(candidate)) found.push(candidate);
  const shipped = path.join(template, ".mcp.json");
  const original = existsSync(shipped) ? readFileSync(shipped, "utf8") : null;
  for (const project of projects) {
    const file = path.join(project, ".mcp.json");
    const now = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (now !== (project.endsWith("workspace") ? original : null)) found.push(file);
  }
  return found;
}

export async function onboardingCases(ctx, state, brain, templateWorkspace) {
  const cases = {};
  const prepare = (name) => {
    const root = makeDir(path.join(state.root, `onboard-${name}`));
    const workspace = path.join(root, "workspace");
    cpSync(templateWorkspace, workspace, { recursive: true });
    // Onboarding is launched from an UNRELATED directory with --repo: the Claude Code
    // project target must follow the workspace, never the shell's cwd.
    return {
      home: makeDir(path.join(root, "home")),
      cwd: makeDir(path.join(root, "elsewhere")),
      workspace,
    };
  };
  const run = async (name, at, steps) => {
    const result = await drive(ctx, state, ["onboard", "--repo", at.workspace], {
      ...{ home: at.home, cwd: at.cwd, label: `onboard-${name}`, steps },
      // Cursor is "running" throughout: an unselected host must never block onboarding.
      processes: [...UNRELATED_PROCESSES, "/Applications/Cursor.app/Contents/MacOS/Cursor"],
    });
    assert.equal(result.status, 0, `onboard ${name} exits cleanly`);
    assert.deepEqual(leaks(result.screen + result.stderr), [], `onboard ${name} prints no key`);
    return result;
  };

  // 1. Join + validated Brain → offer → ACCEPT → Claude Code, for the --repo workspace.
  {
    const at = prepare("accept");
    await brain.drain();
    const before = brain.requests.length;
    const result = await run("accept", at, [
      ...opening(`${DOWN}\r`),
      ...connectBrain(brain.origin, KEYS.team),
      { expect: OFFER, send: "y" },
      // Hosts are listed in installed-registry order; move to Claude Code, toggle, confirm.
      {
        expect: /Choose MCP hosts/,
        send: `${DOWN.repeat(state.supported.indexOf("claude-code"))} \r`,
      },
      ...closing,
    ]);
    assert.match(result.screen, /MCP configuration saved and server command verified/);
    assert.match(result.screen, /host loading is not yet verified/);
    const entry = JSON.parse(readFileSync(path.join(at.workspace, ".mcp.json"), "utf8")).mcpServers[
      "aios-brain"
    ];
    assert.equal(entry.type, "stdio");
    assert.ok(
      entry.args[0].startsWith(path.join(at.home, ".aios", "mcp")),
      "recorded server lives in the isolated profile"
    );
    assert.ok(!existsSync(path.join(at.cwd, ".mcp.json")), "the shell cwd received no .mcp.json");
    assert.ok(!existsSync(path.join(at.home, ".cursor")), "an unselected host was not configured");
    assert.deepEqual(leaks(readFileSync(path.join(at.workspace, ".mcp.json"), "utf8")), []);
    const records = JSON.parse(
      readFileSync(path.join(at.home, ".aios", "mcp-installations.json"), "utf8")
    );
    assert.deepEqual(
      records.installations.map((row) => [row.host, row.file]),
      [["claude-code", path.join(at.workspace, ".mcp.json")]]
    );
    await brain.drain();
    const me = brain.requests.slice(before).filter((row) => row.path === "/api/v1/me");
    // onboarding's own validation, the installer's validation, the launched server's probe
    assert.ok(me.length >= 3 && me.every((row) => row.tier === "team" && row.status === 200));
    cases.accept = {
      offerShown: true,
      host: "claude-code",
      projectTarget: "--repo workspace",
      cwdUntouched: true,
    };
  }

  // 2. Join + validated Brain → offer → DECLINE (the default) → no MCP write anywhere.
  {
    const at = prepare("decline");
    const result = await run("decline", at, [
      ...opening(`${DOWN}\r`),
      ...connectBrain(brain.origin, KEYS.team),
      { expect: OFFER, send: "\r" },
      ...closing,
    ]);
    assert.match(result.screen, /MCP setup skipped\. You can run aios mcp install later\./);
    assert.deepEqual(mcpFootprint(at.home, templateWorkspace, at.workspace, at.cwd), []);
    cases.decline = { offerShown: true, mcpWrites: 0 };
  }

  // 3. Join, but the Brain REJECTS the key → connection fails → the offer never appears.
  {
    const at = prepare("failed-brain");
    const result = await run("failed-brain", at, [
      ...opening(`${DOWN}\r`),
      ...connectBrain(brain.origin, KEYS.denied),
      ...closing,
    ]);
    assert.doesNotMatch(result.screen, OFFER);
    assert.doesNotMatch(result.screen, /Authenticated identity/);
    assert.deepEqual(mcpFootprint(at.home, templateWorkspace, at.workspace, at.cwd), []);
    cases.failedBrain = { offerShown: false, mcpWrites: 0 };
  }

  // 4. Personal (standalone) → no Brain, no offer.
  {
    const at = prepare("personal");
    const result = await run("personal", at, [
      ...opening("\r"),
      { expect: /Connect a few things/, send: "\r" },
      ...closing,
    ]);
    assert.doesNotMatch(result.screen, OFFER);
    assert.match(result.screen, /standalone mode/);
    assert.deepEqual(mcpFootprint(at.home, templateWorkspace, at.workspace, at.cwd), []);
    cases.personal = { offerShown: false, mcpWrites: 0 };
  }
  return cases;
}
