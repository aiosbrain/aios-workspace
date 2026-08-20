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
