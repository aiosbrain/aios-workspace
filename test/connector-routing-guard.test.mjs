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

import { classifyBash, classifyMcp } from "../hooks/connector-routing-guard.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(DIR, "..", "hooks", "connector-routing-guard.mjs");

/** Run the real hook over a real PreToolUse payload. Never `spawnSync` — see the Slack suite. */
function runHook(payload, { env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [HOOK],
      { encoding: "utf8", cwd, env: { ...process.env, ...env } },
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

test("a stale connector copy is flagged, advisory like every other Bash verdict", async () => {
  // This used to hard-block. Bash classification is advisory now — see the retreat below — so it
  // warns instead. The message still names the stale copy, which is the useful part.
  const r = await runHook(bash("python3 ~/.claude/skills/slack-cli/slack.py whoami"));
  assert.equal(r.status, 0, r.stderr);
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

test("classifyBash never blocks; classifyMcp still does", () => {
  // The asymmetry IS the design: a shell string cannot be classified soundly, a structured MCP
  // payload can.
  assert.equal(classifyBash("curl https://api.linear.app/graphql -d 'AIO-1'").decision, "warn");
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

// ── four more, from the second codex:gpt-5.6-sol round ──────────────────────────────────────

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

// ── the retreat: Bash is ADVISORY, and that is the finding, not a gap ────────────────────────

test("no shell spelling of a Linear request is BLOCKED — every one is advisory", async () => {
  // Three rounds of adversarial review produced these bypasses. They are listed as tests rather
  // than fixed because the last one is unfixable in this shape: blocking required an allowlist of
  // HTTP client names, and every language here has an HTTP library.
  const spellings = [
    "curl https://api.linear.app/graphql -d AIO-1",
    'echo "$(curl https://api.linear.app/graphql -d AIO-1)"',
    "echo 'curl https://api.linear.app/graphql -d AIO-1' | bash",
    "echo <(curl https://api.linear.app/graphql -d AIO-1)",
    `python3 -c "import urllib.request; urllib.request.urlopen('https://api.linear.app/graphql')" # AIO-1`,
  ];
  for (const cmd of spellings) {
    const r = await runHook(bash(cmd));
    assert.equal(r.status, 0, `Bash must never hard-block: ${cmd} — ${r.stderr}`);
  }
});

test("inert prose is never blocked, in any spelling", async () => {
  // The other half of the retreat. Each fix for a bypass cost a false positive: quoted prose,
  // comments containing quotes, a mentioned URL. None of them can block now.
  for (const cmd of [
    "git commit -m 'document https://api.linear.app for AIO-1'",
    '# curl "https://api.linear.app/graphql" -d AIO-1',
    "grep -r 'api.linear.app' docs/",
    "echo 'see AIO-976'",
    "ls -la",
  ]) {
    const r = await runHook(bash(cmd));
    assert.equal(r.status, 0, `inert text must not block: ${cmd} — ${r.stderr}`);
  }
});

test("a default marker matches a team TOKEN, not a substring", async () => {
  // `aio` as a substring blocked customer teams called `KAIO` and `Maio` — a false positive on
  // somebody else's board, produced by the default marker itself.
  const cwd = mkdtempSync(path.join(tmpdir(), "routing-token-"));
  for (const teamKey of ["KAIO", "Maio", "AIOSX"]) {
    const r = await runHook(
      mcp("mcp__plugin_linear_linear__create_issue", { title: "x", teamKey }, cwd)
    );
    assert.equal(r.status, 0, `customer team ${teamKey} must not match 'aio': ${r.stderr}`);
  }
  const aios = await runHook(
    mcp("mcp__plugin_linear_linear__create_issue", { title: "x", teamKey: "AIO" }, cwd)
  );
  assert.equal(aios.status, 2, aios.stderr);
});

test("oversized input blocks only when it is identifiably a Linear MCP call", async () => {
  // Blocking every truncated payload stopped unrelated Bash calls carrying a large heredoc.
  // The MCP path is the only one that blocks, and its tool name is at the head of the payload.
  const bigBash = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: `cat <<'EOF'\n${"x".repeat(1_500_000)}\nEOF` },
  });
  assert.equal((await runHook(bigBash)).status, 0, "an unrelated big command must pass");

  const bigMcp = JSON.stringify({
    tool_name: "mcp__plugin_linear_linear__update_issue",
    tool_input: { id: "AIO-976", pad: "x".repeat(1_500_000) },
  });
  assert.equal((await runHook(bigMcp)).status, 2, "a truncated Linear MCP call must fail closed");
});

// ── spelling must not be a bypass (round 4) ─────────────────────────────────────────────────

test("AIOS detection does not depend on the caller's spelling", async () => {
  // `AIOS_MARKER` was case-sensitive, so `aio-976` was allowed. And TEAM_FIELDS mixed spellings
  // (`teamkey` alongside `team_id`) while the normaliser kept underscores, so `team_key` matched
  // nothing and snake_case payloads went unclassified. Both fail OPEN on an ordinary typo.
  const spellings = [
    { id: "aio-976" },
    { id: "Aio-976" },
    { team_key: "AIO" },
    { team_name: "AIO" },
    { teamKey: "aio" },
  ];
  for (const input of spellings) {
    const r = await runHook(mcp("mcp__plugin_linear_linear__create_issue", input));
    assert.equal(r.status, 2, `must block ${JSON.stringify(input)}: ${r.stderr}`);
  }
  // ...and the false-positive boundary still holds for a customer team.
  const customer = await runHook(
    mcp("mcp__plugin_linear_linear__create_issue", { team_key: "KAIO" })
  );
  assert.equal(customer.status, 0, customer.stderr);
});

test("a truncated Bash payload that merely MENTIONS an MCP tool name is not blocked", async () => {
  // The oversized fallback scanned raw JSON for the tool pattern anywhere in the first 2KB, so a
  // huge Bash command quoting `mcp__plugin_linear_linear__get_issue` was misclassified — the same
  // "a mention is not a target" error the team markers already made once. It now matches the
  // serialized tool_name PROPERTY.
  const bashMentioning = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: `# see mcp__plugin_linear_linear__get_issue\n${"x".repeat(1_500_000)}`,
    },
  });
  assert.equal((await runHook(bashMentioning)).status, 0, "a mention must not block");

  const realMcp = JSON.stringify({
    tool_name: "mcp__plugin_linear_linear__update_issue",
    tool_input: { id: "AIO-976", pad: "x".repeat(1_500_000) },
  });
  assert.equal((await runHook(realMcp)).status, 2, "a real truncated MCP call must fail closed");
});

// ── the escape hatch must reach every exit path (round 5) ───────────────────────────────────

test("an oversized payload honours mode, including off", async () => {
  // The truncation path set exit 2 BEFORE loading config, so a workspace that had explicitly
  // turned enforcement off was still hard-blocked by a large payload. An escape hatch that some
  // code paths ignore is not an escape hatch.
  const oversized = JSON.stringify({
    tool_name: "mcp__plugin_linear_linear__update_issue",
    tool_input: { id: "AIO-976", pad: "x".repeat(1_500_000) },
  });
  for (const [mode, want] of [
    ["block", 2],
    ["warn", 0],
    ["off", 0],
  ]) {
    const cwd = mkdtempSync(path.join(tmpdir(), `routing-big-${mode}-`));
    mkdirSync(path.join(cwd, ".aios"), { recursive: true });
    writeFileSync(path.join(cwd, ".aios/connector-routing.json"), JSON.stringify({ mode }));
    const r = await runHook(oversized, { cwd });
    assert.equal(r.status, want, `mode=${mode} must exit ${want}: ${r.stderr}`);
    if (mode === "off") assert.equal(r.stderr.trim(), "", "mode=off must be silent");
  }
});
