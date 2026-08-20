#!/usr/bin/env node
// connector-routing-guard.mjs — PreToolUse hook — keep AIOS connector work on the AIOS CLIs.
//
// THE PROBLEM THIS EXISTS FOR. A skill description, a RESOLVER row and a SKILL.md are all
// suggestions: they compete for attention with everything else in context, and an agent that
// reaches for the wrong Linear/Slack tool does so precisely because it did not weigh them. A
// hook exit code does not negotiate. This is the only deterministic layer in the stack.
//
// WHY IT IS DELIBERATELY NARROW. The failure modes are not symmetric. A wrongly-BLOCKED
// customer Linear call is a hard stop in the middle of someone's work; a wrongly-ALLOWED one is
// a mild inconsistency. So this blocks only what it can prove is AIOS-targeted, and merely warns
// on everything else. "Provably AIOS" means an AIO-<n> identifier or a configured team marker is
// present in the very same call — not a guess from context, which the hook does not have.
//
// It therefore does NOT block:
//   - Linear MCP calls against someone else's board (that is legitimate customer work)
//   - every non-canonical linear.mjs (a managed project copy is fine)
//   - anything at all when it cannot parse its own input
//
// ENFORCEMENT BOUNDARY: this is a Claude Code PreToolUse hook. Codex and OpenCode do not run it.
// Do not describe this as universal routing enforcement — it is enforcement in one harness.
//
// HARD RULE, inherited from file-governance-guard.mjs: never disturb a session over its own
// bugs. Everything is wrapped; the exit code defaults to 0 (allow). A missed check is
// acceptable, a hung or crashed session is not. The one exception is malformed input on a call
// we have ALREADY classified as relevant — see `main()`.
//
// The classification functions are pure and exported so tests exercise the same rules the hook
// runs. Nothing here does I/O beyond reading stdin and an optional config file.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STDIN_MAX = 1_000_000;
const CONFIG_REL = ".aios/connector-routing.json";

// Default-enabled. The narrow scope above is what makes that safe: a guard nobody enables is a
// guard that does not exist, and the agents most likely to misroute are the least likely to go
// turn one on.
const DEFAULT_MODE = "block"; // "block" | "warn" | "off"

/** An AIOS-owned work item. The team's issue prefix is the one unambiguous signal available. */
const AIOS_MARKER = /\bAIO-\d+\b/;

/** Generic Linear tool surfaces that are NOT the AIOS CLI. */
const LINEAR_MCP_TOOL = /^mcp__.*linear.*__/i;

/** A real HTTP call to Linear's API — not the word "linear" appearing in prose. */
const LINEAR_GRAPHQL_HOST = /\bapi\.linear\.app\b/i;
/**
 * A program that performs a request. `http`/`https` are deliberately NOT here: they match the
 * scheme of any URL merely being MENTIONED, so `git commit -m 'see https://api.linear.app …'`
 * was blocked — the exact false positive this guard promises not to produce. (The earlier test
 * missed it because its fixture wrote a bare host with no scheme.) `httpie` is the real client
 * named `http`, matched explicitly.
 */
const HTTP_CLIENT = /\b(curl|wget|httpie|fetch|nc|xh)\b/i;

/**
 * Connector copies that are known-dead and must never be reached for.
 * `slack-cli` is the hermes-era skill: on a member workstation it has no token configured and
 * its `slack connect` expects its own env var, so reaching for it fails in a way that reads as
 * "Slack is broken" rather than "wrong copy".
 */
const DEFAULT_STALE = ["/.claude/skills/slack-cli/"];

/** Text that can execute: a command substitution or a backtick. */
const EXECUTABLE_SUBSTITUTION = /\$\(|`/;

/**
 * Strip shell comments and echo/printf bodies so quoted prose cannot trigger a block.
 *
 * REFUSES TO STRIP ANYTHING CONTAINING A COMMAND SUBSTITUTION. `echo "$(curl … AIO-1)"` RUNS the
 * curl; treating it as inert turned a false-positive guard into an evasion technique — wrap the
 * call in echo and the block disappears. Verified before this was written. When a substitution is
 * present the text is returned unchanged, so classification sees the real command.
 *
 * `#` is only treated as a comment when it starts a word outside quotes. A bare `.replace(/#.*$/)`
 * also erased `#` inside quoted arguments, which could delete the AIO-<n> marker and turn a block
 * into an allow.
 */
export function stripInertText(command) {
  const raw = String(command);
  if (EXECUTABLE_SUBSTITUTION.test(raw)) return raw;
  return raw
    .split("\n")
    .map((line) => line.replace(/(^|\s)#[^"']*$/, "$1"))
    .join("\n")
    .replace(/\b(echo|printf)\b[^\n;&|]*/gi, " ");
}

/**
 * Classify a Bash command.
 * @returns {{decision: "allow"|"warn"|"block", reason?: string, fix?: string}}
 */
export function classifyBash(command, opts = {}) {
  const stale = opts.stalePaths ?? DEFAULT_STALE;
  const raw = String(command ?? "");
  if (!raw.trim()) return { decision: "allow" };

  // Stale copies are checked against the RAW command: a path is a path even inside a quoted
  // string, and there is no legitimate reason to name one.
  for (const needle of stale) {
    if (raw.includes(needle)) {
      return {
        decision: "block",
        reason: `names a stale connector copy (${needle})`,
        fix: "Use the workspace's own .claude/skills/ copy, or the `slack`/`linear` commands the toolkit installs.",
      };
    }
  }

  const active = stripInertText(raw);
  if (LINEAR_GRAPHQL_HOST.test(active) && HTTP_CLIENT.test(active)) {
    if (AIOS_MARKER.test(active)) {
      return {
        decision: "block",
        reason: "hand-rolled Linear GraphQL against an AIOS issue",
        fix: "Use the aios-linear CLI: `linear get AIO-<n>` / `linear comment AIO-<n> …`. It carries the description guards that raw GraphQL silently loses.",
      };
    }
    return {
      decision: "warn",
      reason: "hand-rolled Linear GraphQL (no AIOS issue named, so treated as non-AIOS work)",
    };
  }

  return { decision: "allow" };
}

/**
 * Classify a generic Linear MCP tool call.
 * @returns {{decision: "allow"|"warn"|"block", reason?: string, fix?: string}}
 */
export function classifyMcp(toolName, toolInput, opts = {}) {
  if (!LINEAR_MCP_TOOL.test(String(toolName ?? ""))) return { decision: "allow" };
  const markers = opts.teamMarkers ?? [];

  let blob = "";
  try {
    blob = JSON.stringify(toolInput ?? {});
  } catch {
    // Unserialisable input on a call we KNOW is a generic Linear tool. We cannot prove it is
    // non-AIOS, and this hook's whole purpose is that these calls are routed deliberately.
    return {
      decision: "block",
      reason: "generic Linear MCP call whose input could not be inspected",
      fix: "Re-issue through the aios-linear CLI, or narrow the call so it can be inspected.",
    };
  }

  // An AIO-<n> is the unambiguous signal, and it is not the only one. A `create_issue` has no
  // identifier yet — it is CREATING the thing — so an AIOS-targeted create was previously only
  // warned about, which left the routing path this guard exists for unenforced. Configured team
  // markers (team key, name or UUID, from .aios/connector-routing.json) cover that case. The
  // comments promised this; the code did not implement it until now.
  const marker = markers.find((m) => m && blob.toLowerCase().includes(String(m).toLowerCase()));
  if (marker) {
    return {
      decision: "block",
      reason: `generic Linear MCP call carrying a configured AIOS team marker ('${marker}')`,
      fix: "AIOS's board goes through the aios-linear CLI. The MCP bypasses the description guards and the brain projection.",
    };
  }

  if (AIOS_MARKER.test(blob)) {
    return {
      decision: "block",
      reason: "generic Linear MCP call naming an AIOS issue",
      fix: "AIOS's board goes through the aios-linear CLI: `linear get AIO-<n>`. The MCP bypasses the description guards and the brain projection.",
    };
  }
  return {
    decision: "warn",
    reason: "generic Linear MCP call (no AIOS issue named — assumed customer work, allowed)",
  };
}

function loadConfig(cwd) {
  try {
    const p = path.join(cwd || process.cwd(), CONFIG_REL);
    if (!existsSync(p)) return {};
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > STDIN_MAX) {
      truncated = true;
      break;
    }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

async function main() {
  const { text, truncated } = await readStdin();

  // TRUNCATION IS NOT "UNPARSEABLE INPUT". Stopping at STDIN_MAX produces a partial JSON
  // document, JSON.parse throws, and the old handler treated that exactly like a payload that was
  // never ours — it allowed the call. So padding a generic Linear request past the cap disabled
  // the guard entirely while carrying a real AIOS operation. A payload too large to classify is a
  // payload we cannot clear, so it fails closed with a message saying why.
  if (truncated) {
    process.stderr.write(
      `[connector-routing-guard] BLOCKED: tool input exceeded ${STDIN_MAX} bytes, so it could not ` +
        "be classified. A call this guard cannot read is not a call it can clear.\n"
    );
    process.exitCode = 2;
    return;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return; // genuinely not ours; never break a session over input we were not given
  }
  if (!payload || typeof payload !== "object") return;

  const toolName = String(payload.tool_name ?? "");
  const input = payload.tool_input || {};
  const cfg = loadConfig(payload.cwd);
  const mode = ["block", "warn", "off"].includes(cfg.mode) ? cfg.mode : DEFAULT_MODE;
  if (mode === "off") return;

  let verdict = { decision: "allow" };
  if (toolName === "Bash") {
    verdict = classifyBash(input.command, { stalePaths: cfg.stalePaths ?? DEFAULT_STALE });
  } else if (LINEAR_MCP_TOOL.test(toolName)) {
    verdict = classifyMcp(toolName, input, { teamMarkers: cfg.teamMarkers ?? [] });
  }

  if (verdict.decision === "allow") return;

  // `warn` mode downgrades a block to advisory; it never upgrades a warn.
  const blocking = verdict.decision === "block" && mode === "block";
  const label = blocking ? "BLOCKED" : "advisory";
  const lines = [`[connector-routing-guard] ${label}: ${verdict.reason}`];
  if (verdict.fix) lines.push(`  → ${verdict.fix}`);
  if (!blocking && verdict.decision === "block") {
    lines.push("  (mode=warn in .aios/connector-routing.json — allowing)");
  }
  process.stderr.write(lines.join("\n") + "\n");
  if (blocking) process.exitCode = 2;
}

/**
 * REALPATH BOTH SIDES. `import.meta.url` is already symlink-resolved; `path.resolve(argv[1])` is
 * not. Under any symlinked path they differ — macOS `$TMPDIR` (/var -> /private/var) and a
 * symlinked project root are both ordinary — and the hook would then decide it is not the main
 * module and do NOTHING, silently, exiting 0. A guard that quietly stops guarding is worse than
 * no guard, so this comparison is on realpaths, falling back to the plain form if either path
 * cannot be resolved.
 */
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

const isMainModule = isMain();
if (isMainModule) {
  main()
    .catch(() => {})
    .finally(() => {
      if (process.exitCode !== 2) process.exitCode = 0;
    });
}
