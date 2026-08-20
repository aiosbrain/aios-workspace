/**
 * connector-routing-guard.test.mjs — the routing guard's allow/warn/block boundary.
 *
 * The asymmetry this suite defends: a wrongly-BLOCKED customer Linear call is a hard stop in
 * someone's work; a wrongly-ALLOWED one is a mild inconsistency. So the false-positive cases
 * (prose, comments, echo, customer boards) get as much attention as the true positives, and the
 * end-to-end cases run the real hook over real PreToolUse payloads rather than calling the
 * classifiers directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyBash, classifyMcp, stripInertText } from "../hooks/connector-routing-guard.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(DIR, "..", "hooks", "connector-routing-guard.mjs");

/** Run the real hook over a real PreToolUse payload. Never `spawnSync` — see the Slack suite. */
function runHook(payload, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [HOOK],
      { encoding: "utf8", env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })
    );
    // A guard that fails closed EXITS before reading the whole payload, so writing a large
    // input races its exit and the pipe closes under us. EPIPE here is the hook doing its job,
    // not a harness failure — swallow it and let the exit code be the assertion.
    child.stdin.on("error", (e) => {
      if (e.code !== "EPIPE") throw e;
    });
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

const bash = (command, cwd) => ({ tool_name: "Bash", tool_input: { command }, cwd });
const mcp = (tool_name, tool_input, cwd) => ({ tool_name, tool_input, cwd });

// ── blocks: provably AIOS work on a non-AIOS surface ────────────────────────────────────────

test("a generic Linear MCP call naming an AIO issue is blocked with the right command", async () => {
  const r = await runHook(mcp("mcp__plugin_linear_linear__get_issue", { id: "AIO-976" }));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /BLOCKED/);
  assert.match(r.stderr, /aios-linear/, "a refusal must name the tool to use instead");
});

test("hand-rolled Linear GraphQL against an AIOS issue is blocked", async () => {
  const r = await runHook(
    bash(
      `curl -s https://api.linear.app/graphql -d '{"query":"{ issue(id:\\"AIO-686\\") { id } }"}'`
    )
  );
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /BLOCKED/);
});

test("a stale connector copy is blocked even without an AIOS marker", async () => {
  const r = await runHook(bash("python3 ~/.claude/skills/slack-cli/slack.py whoami"));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /stale connector copy/);
});

// ── allows: everything the guard must not touch ─────────────────────────────────────────────

test("a customer Linear MCP call is allowed, with an advisory only", async () => {
  const r = await runHook(
    mcp("mcp__plugin_linear_linear__get_issue", { id: "ACME-42", teamId: "customer" })
  );
  assert.equal(r.status, 0, "customer Linear work must never hard-stop");
  assert.match(r.stderr, /advisory/);
});

test("the canonical CLIs and managed copies are allowed silently", async () => {
  const allowed = [
    "linear get AIO-976",
    "linear comment AIO-686 --body 'done'",
    "node .claude/skills/aios-linear/linear.mjs get AIO-976",
    "dotenvx run --quiet -f .env -- python3 .claude/skills/slack-personal/slack.py whoami",
    "slack file --member someone@example.com --path ./report.pdf",
    "slack dm --member someone@example.com --message 'hi'",
  ];
  for (const command of allowed) {
    const r = await runHook(bash(command));
    assert.equal(r.status, 0, `must allow: ${command}`);
    assert.equal(r.stderr.trim(), "", `must be silent: ${command} (got ${r.stderr})`);
  }
});

test("prose, comments and echoed strings never trigger a block", async () => {
  const inert = [
    "echo 'see AIO-976 and api.linear.app for context'",
    "# curl https://api.linear.app/graphql for AIO-976",
    "git commit -m 'fix routing for AIO-976'",
    "grep -r 'api.linear.app' docs/",
    "printf '%s' 'AIO-686 api.linear.app curl'",
  ];
  for (const command of inert) {
    const r = await runHook(bash(command));
    assert.equal(r.status, 0, `must not block inert text: ${command} — ${r.stderr}`);
  }
});

test("an unrelated tool and a harmless curl are ignored entirely", async () => {
  for (const payload of [
    { tool_name: "Read", tool_input: { file_path: "/tmp/AIO-976.md" } },
    bash("curl -s https://example.com/health"),
    bash("ls -la"),
  ]) {
    const r = await runHook(payload);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), "");
  }
});

// ── robustness: a guard must never be the reason a session dies ─────────────────────────────

test("malformed and empty input is allowed, not fatal", async () => {
  for (const raw of ["", "not json", "null", "[]", '{"tool_name":"Bash"}']) {
    const r = await runHook(raw);
    assert.equal(r.status, 0, `must survive: ${JSON.stringify(raw)}`);
  }
});

test("it needs no jq and no network — it is plain node over stdin", async () => {
  const r = await runHook(mcp("mcp__plugin_linear_linear__get_issue", { id: "AIO-1" }), {
    env: { PATH: "/nonexistent" },
  });
  assert.equal(r.status, 2, "an empty PATH must not change the verdict");
});

// ── config ──────────────────────────────────────────────────────────────────────────────────

test("mode=warn downgrades a block to advisory; mode=off silences it", async () => {
  for (const [mode, wantStatus] of [
    ["warn", 0],
    ["off", 0],
    ["block", 2],
  ]) {
    const cwd = mkdtempSync(path.join(tmpdir(), "routing-cfg-"));
    mkdirSync(path.join(cwd, ".aios"), { recursive: true });
    writeFileSync(path.join(cwd, ".aios/connector-routing.json"), JSON.stringify({ mode }));
    const r = await runHook(mcp("mcp__plugin_linear_linear__get_issue", { id: "AIO-9" }, cwd));
    assert.equal(r.status, wantStatus, `mode=${mode} → exit ${wantStatus} (${r.stderr})`);
    if (mode === "off") assert.equal(r.stderr.trim(), "", "mode=off must be silent");
  }
});

// ── unit-level: the pure classifiers ────────────────────────────────────────────────────────

test("stripInertText removes comments and echo bodies but keeps real commands", () => {
  assert.doesNotMatch(stripInertText("# curl api.linear.app"), /linear/);
  assert.doesNotMatch(stripInertText("echo 'api.linear.app'"), /linear/);
  assert.match(stripInertText("curl https://api.linear.app/graphql"), /linear/);
});

test("classifyBash and classifyMcp agree with the end-to-end behaviour", () => {
  assert.equal(classifyBash("curl https://api.linear.app/graphql -d 'AIO-1'").decision, "block");
  assert.equal(classifyBash("curl https://api.linear.app/graphql -d 'ACME-1'").decision, "warn");
  assert.equal(classifyBash("linear get AIO-1").decision, "allow");
  assert.equal(classifyMcp("mcp__plugin_linear_linear__x", { id: "AIO-1" }).decision, "block");
  assert.equal(classifyMcp("mcp__plugin_linear_linear__x", { id: "ACME-1" }).decision, "warn");
  assert.equal(classifyMcp("mcp__github__x", { id: "AIO-1" }).decision, "allow");
});

// ── the silent-death case ───────────────────────────────────────────────────────────────────

test("it still fires when invoked through a SYMLINKED path", async () => {
  // `import.meta.url` is symlink-resolved; `path.resolve(process.argv[1])` is not. Comparing
  // them raw makes the hook decide it is not the main module and do nothing — exit 0, no output,
  // no guard. This is not exotic: macOS $TMPDIR is /var -> /private/var, and a symlinked project
  // root (~/Tessera -> ~/Projects) is an ordinary setup. A guard that quietly stops guarding is
  // the worst possible failure mode, so it gets its own test.
  const real = mkdtempSync(path.join(tmpdir(), "routing-real-"));
  mkdirSync(path.join(real, "hooks"), { recursive: true });
  const copied = path.join(real, "hooks", "connector-routing-guard.mjs");
  copyFileSync(HOOK, copied);
  chmodSync(copied, 0o755);

  const linkDir = path.join(mkdtempSync(path.join(tmpdir(), "routing-link-")), "via-symlink");
  symlinkSync(real, linkDir);
  const viaSymlink = path.join(linkDir, "hooks", "connector-routing-guard.mjs");

  const r = await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [viaSymlink],
      { encoding: "utf8" },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })
    );
    child.stdin.end(
      JSON.stringify({
        tool_name: "mcp__plugin_linear_linear__get_issue",
        tool_input: { id: "AIO-976" },
      })
    );
  });
  assert.equal(r.status, 2, `must still block through a symlink, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /BLOCKED/);
});

// ── four bypasses found by codex:gpt-5.6-sol ────────────────────────────────────────────────

test("a command substitution inside echo is NOT inert", async () => {
  // stripInertText() existed to stop prose triggering a block. Stripping whole echo/printf
  // bodies turned that into an evasion: `echo "$(curl … AIO-1)"` RUNS the curl, and removing the
  // body made it classify as empty. Verified working before the fix.
  for (const cmd of [
    'echo "$(curl https://api.linear.app/graphql -d AIO-1)"',
    "echo `curl https://api.linear.app/graphql -d AIO-1`",
    'printf "%s" "$(wget -qO- https://api.linear.app/graphql -d AIO-9)"',
  ]) {
    const r = await runHook(bash(cmd));
    assert.equal(r.status, 2, `must not be strippable: ${cmd} — ${r.stderr}`);
  }
});

test("merely MENTIONING a Linear URL is not an HTTP client", async () => {
  // HTTP_CLIENT included `http|https`, which match the scheme of any URL being quoted. That
  // blocked `git commit -m 'see https://api.linear.app …'` — the exact false positive this guard
  // promises not to produce. The original test missed it by using a bare host with no scheme.
  for (const cmd of [
    "git commit -m 'document https://api.linear.app for AIO-1'",
    'echo "see https://api.linear.app/graphql AIO-976"',
    "grep -r 'https://api.linear.app' docs/",
  ]) {
    const r = await runHook(bash(cmd));
    assert.equal(r.status, 0, `must not block a mention: ${cmd} — ${r.stderr}`);
  }
});

test("a configured team marker blocks an AIOS create that has no AIO-<n> yet", async () => {
  // A create_issue is making the thing, so it cannot carry an identifier — the case the guard
  // most needs to catch was the one it only warned about. The comments claimed configured team
  // markers were honoured; loadConfig()/classifyMcp() did not implement them.
  const cwd = mkdtempSync(path.join(tmpdir(), "routing-team-"));
  mkdirSync(path.join(cwd, ".aios"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".aios/connector-routing.json"),
    JSON.stringify({ teamMarkers: ["aiosbrain", "7c9e6679-aios"] })
  );
  const aios = await runHook(
    mcp("mcp__plugin_linear_linear__create_issue", { title: "x", teamId: "7c9e6679-aios" }, cwd)
  );
  assert.equal(aios.status, 2, aios.stderr);
  assert.match(aios.stderr, /team marker/);

  const customer = await runHook(
    mcp("mcp__plugin_linear_linear__create_issue", { title: "x", teamId: "acme-corp" }, cwd)
  );
  assert.equal(customer.status, 0, "a customer team must still pass");
});

test("input too large to classify fails CLOSED, not open", async () => {
  // readStdin() stopped at STDIN_MAX and returned a partial document; JSON.parse threw, and the
  // catch treated that like a payload that was never ours — allow. So padding a generic Linear
  // call past the cap disabled the guard while still carrying a real AIOS operation.
  const padded = JSON.stringify({
    tool_name: "mcp__plugin_linear_linear__update_issue",
    tool_input: { id: "AIO-976", pad: "x".repeat(2_000_000) },
  });
  const r = await runHook(padded);
  assert.equal(r.status, 2, `oversized input must block: ${r.stderr}`);
  assert.match(r.stderr, /could not be classified|exceeded/);
});

// ── four more, from the second codex:gpt-5.6-sol round ──────────────────────────────────────

test("a comment containing quotes is still a comment", async () => {
  // The first false-positive fix used /(^|\s)#[^"\']*$/, which only matches comments with NO
  // quotes — so `# curl "https://…" -d AIO-1` survived and was blocked. A false positive
  // introduced by the fix for a false positive. Comment stripping is now quote-aware.
  for (const cmd of [
    '# curl "https://api.linear.app/graphql" -d AIO-1',
    "# curl 'https://api.linear.app/graphql' -d AIO-1",
    "# plain comment about AIO-1 and curl api.linear.app",
  ]) {
    const r = await runHook(bash(cmd));
    assert.equal(r.status, 0, `inert comment must not block: ${cmd} — ${r.stderr}`);
  }
  // ...and a `#` INSIDE quotes is not a comment, so the command is still classified.
  const live = await runHook(bash('curl https://api.linear.app/graphql -d "issue#AIO-1"'));
  assert.equal(live.status, 2, live.stderr);
});

test("team markers match team-identifying fields, not arbitrary payload text", async () => {
  // Searching the whole serialized payload meant a CUSTOMER issue whose title merely mentioned
  // "aiosbrain" was blocked as AIOS-targeted.
  const cwd = mkdtempSync(path.join(tmpdir(), "routing-fields-"));
  mkdirSync(path.join(cwd, ".aios"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".aios/connector-routing.json"),
    JSON.stringify({ teamMarkers: ["aiosbrain"] })
  );
  const mention = await runHook(
    mcp(
      "mcp__plugin_linear_linear__create_issue",
      {
        title: "integrate with aiosbrain",
        teamId: "acme-corp",
      },
      cwd
    )
  );
  assert.equal(mention.status, 0, `a mention is not a target: ${mention.stderr}`);

  const targeted = await runHook(
    mcp("mcp__plugin_linear_linear__create_issue", { title: "x", teamId: "aiosbrain" }, cwd)
  );
  assert.equal(targeted.status, 2, targeted.stderr);
});

test("an AIOS create is blocked on a DEFAULT install, with no config file", async () => {
  // teamMarkers only worked when configured, and nothing scaffolds the config — so out of the
  // box a create_issue into the AIOS team was merely warned about. A create carries no AIO-<n>
  // because it is creating the issue, which makes this the case most worth catching.
  const cwd = mkdtempSync(path.join(tmpdir(), "routing-default-"));
  const r = await runHook(
    mcp("mcp__plugin_linear_linear__create_issue", { title: "x", teamKey: "AIO" }, cwd)
  );
  assert.equal(r.status, 2, `default install must block: ${r.stderr}`);
});

test("a malformed config cannot disable enforcement", async () => {
  // `"teamMarkers": "aiosbrain"` (a string, not a list) reached .find() and threw; the top-level
  // catch then exited 0. A typo in a config file silently turned the guard off for every call.
  const cwd = mkdtempSync(path.join(tmpdir(), "routing-badcfg-"));
  mkdirSync(path.join(cwd, ".aios"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".aios/connector-routing.json"),
    JSON.stringify({ teamMarkers: "aiosbrain", stalePaths: "/x" })
  );
  const r = await runHook(mcp("mcp__plugin_linear_linear__get_issue", { id: "AIO-976" }, cwd));
  assert.equal(r.status, 2, `bad config must not fail open: ${r.stderr}`);
});
