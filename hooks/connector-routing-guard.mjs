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
// Case-INSENSITIVE: `aio-976` identifies the same issue as `AIO-976`, and a guard that depends
// on the caller's capitalisation fails open on a typo.
const AIOS_MARKER = /\bAIO-\d+\b/i;

/**
 * The AIOS team key, applied by DEFAULT. Without it the marker feature did nothing on a fresh
 * install: a `create_issue` carries no AIO-<n> yet (it is creating the issue), and nothing
 * scaffolds `.aios/connector-routing.json`, so the single routing path most worth catching was
 * merely warned about out of the box. Extend via `teamMarkers`, which is additive.
 */
const DEFAULT_TEAM_MARKERS = ["aio"];

/**
 * Fields that actually identify a team. Deliberately NOT title/description/body.
 *
 * Compared after normalising away non-letters, so `team_key`, `teamKey` and `team-key` all reduce
 * to `teamkey`. The previous list mixed both spellings (`teamkey` AND `team_id`) while the
 * normaliser kept underscores, so `team_key` matched nothing and snake_case payloads slipped
 * through unclassified.
 */
const TEAM_FIELDS = new Set([
  "team",
  "teamid",
  "teamkey",
  "teamname",
  "teamidentifier",
  "teamuuid",
  "teamslug",
]);

const normalizeFieldName = (k) => k.toLowerCase().replace(/[^a-z]/g, "");

/**
 * TARGET CLASSIFIER v2 (AIO-1072). Version 1 regex-scanned the WHOLE serialized payload
 * for `AIO-<n>` — so a customer issue whose description merely said "similar to AIO-976"
 * was hard-blocked, the exact false-positive class the team-marker scoping above already
 * eliminated for its own signal. v2 scopes the issue-identifier signal the same way:
 * only VALUES of identifier-bearing fields classify a payload as AIOS-targeted; prose
 * fields (title, description, body, comments) never do. Nested and reordered payloads
 * classify identically — the walk is field-NAME keyed, not position or order keyed.
 * `.aios/connector-routing.json` may set `classifier: 1` to restore the legacy
 * full-payload behavior; `mode: "off"` still disables the guard entirely.
 */
export const TARGET_CLASSIFIER_VERSION = 2;

/** Fields whose VALUES name the work item a call targets. Deliberately NOT title/description. */
const TARGET_FIELDS = new Set([
  "id",
  "ids",
  "issue",
  "issueid",
  "issueids",
  "identifier",
  "identifiers",
  "issueidentifier",
  "parentid",
  "parentissueid",
  "ticketid",
]);

/** String values of target-identifying fields, walked recursively (arrays included). */
export function targetIdentifyingValues(input, depth = 0) {
  if (!input || typeof input !== "object" || depth > 6) return [];
  const out = [];
  for (const [k, v] of Object.entries(input)) {
    const isTarget = TARGET_FIELDS.has(normalizeFieldName(k));
    if (v && typeof v === "object") {
      if (isTarget) {
        for (const el of Array.isArray(v) ? v : Object.values(v)) {
          if (el != null && typeof el !== "object") out.push(String(el));
        }
      }
      out.push(...targetIdentifyingValues(v, depth + 1));
    } else if (isTarget && v != null) {
      out.push(String(v));
    }
  }
  return out;
}

/** Lower-cased VALUES of team-identifying fields only, walked recursively. */
export function teamIdentifyingValues(input, depth = 0) {
  if (!input || typeof input !== "object" || depth > 4) return [];
  const out = [];
  for (const [k, v] of Object.entries(input)) {
    if (v && typeof v === "object") {
      out.push(...teamIdentifyingValues(v, depth + 1));
    } else if (TEAM_FIELDS.has(normalizeFieldName(k))) {
      out.push(String(v).toLowerCase());
    }
  }
  return out;
}

/**
 * Does a marker identify this team?
 *
 * VALUES, not a joined blob, and EXACT value or whole token — never a substring. Substring
 * matching on the default marker `aio` blocked customer teams named `KAIO` and `Maio`. Comparing
 * the whole value keeps hyphenated identifiers working (`7c9e6679-aios`), and the token check
 * keeps multi-word names working (`AIO Platform`).
 */
export function matchesTeamMarker(values, marker) {
  const m = String(marker).toLowerCase();
  return values.some(
    (v) =>
      v === m ||
      v
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .includes(m)
  );
}

/** A config list, or the fallback. A non-array must never reach `.find()`. */
function listOrDefault(value, fallback) {
  return Array.isArray(value) ? value.filter((x) => typeof x === "string" && x) : fallback;
}

/** Generic Linear tool surfaces that are NOT the AIOS CLI. */
const LINEAR_MCP_TOOL = /^mcp__.*linear.*__/i;

/** A real HTTP call to Linear's API — not the word "linear" appearing in prose. */
const LINEAR_GRAPHQL_HOST = /\bapi\.linear\.app\b/i;

/**
 * Connector copies that are known-dead and must never be reached for.
 * `slack-cli` is the hermes-era skill: on a member workstation it has no token configured and
 * its `slack connect` expects its own env var, so reaching for it fails in a way that reads as
 * "Slack is broken" rather than "wrong copy".
 */
const DEFAULT_STALE = [
  "/.claude/skills/slack-cli/",
  // Retired at v2.0.0 (AIO-1072): the skill-local Linear delegate and the descriptor
  // provider-client copies are gone — the built-in `aios linear` / `aios slack` adapter
  // is the one route.
  "/.claude/skills/aios-linear/linear.mjs",
  "/.claude/skills/linear-direct/",
  "/.claude/descriptors/skills/linear-direct/",
  "/.claude/skills/slack-personal/slack.py",
  "/.claude/descriptors/skills/slack-personal/slack.py",
];

/**
 * Classify a Bash command. ADVISORY ONLY — this never blocks, and that is a deliberate retreat.
 *
 * It used to block a hand-rolled Linear GraphQL call. Making that sound requires deciding, from a
 * shell string, whether a network request will happen. Adversarial review produced a queue of
 * bypasses that showed the shape of the problem rather than gaps in the fixes:
 *
 *   echo "$(curl … AIO-1)"                        command substitution inside stripped text
 *   echo 'curl … AIO-1' | bash                    inert text piped into a shell
 *   echo <(curl … AIO-1)                          process substitution
 *   python3 -c "urllib.request.urlopen('…')"      an interpreter, not a listed client
 *
 * The last one ends the argument. Blocking depended on an allowlist of client names, and every
 * language on this machine has an HTTP library, so the list can never be complete. Each fix also
 * cost a false positive in the other direction — quoted prose, and comments containing quotes,
 * were blocked while entirely inert.
 *
 * A guard that `python3 -c` walks through while blocking `git commit -m '…'` is worse than no
 * guard: it teaches people the block is noise. So Bash keeps the part that IS decidable — a
 * literal path to a known-dead connector copy — and everything else is advice.
 *
 * The MCP path below still BLOCKS, because a structured JSON payload with named fields is
 * decidable in a way a shell string is not.
 */
export function classifyBash(command, opts = {}) {
  const stale = opts.stalePaths ?? DEFAULT_STALE;
  const raw = String(command ?? "");
  if (!raw.trim()) return { decision: "allow" };

  for (const needle of stale) {
    if (raw.includes(needle)) {
      return {
        decision: "warn",
        reason: `names a stale connector copy (${needle})`,
        fix: "Use the built-in adapter instead: `aios slack …` / `aios linear …`.",
      };
    }
  }

  if (LINEAR_GRAPHQL_HOST.test(raw) && AIOS_MARKER.test(raw)) {
    return {
      decision: "warn",
      reason: "mentions Linear's API alongside an AIOS issue",
      fix: "If this is a request against the AIOS board, use `aios linear …` — it carries the description guards raw GraphQL loses.",
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
      fix: "Re-issue through `aios linear …`, or narrow the call so it can be inspected.",
    };
  }

  // An AIO-<n> is the unambiguous signal, and it is not the only one. A `create_issue` has no
  // identifier yet — it is CREATING the thing — so an AIOS-targeted create was previously only
  // warned about, which left the routing path this guard exists for unenforced. Configured team
  // markers (team key, name or UUID, from .aios/connector-routing.json) cover that case. The
  // comments promised this; the code did not implement it until now.
  // Search ONLY team-identifying fields, never the whole payload. Matching arbitrary text meant a
  // customer issue whose title merely mentioned "aiosbrain" was blocked as AIOS-targeted — the
  // false-positive class this guard exists to avoid, reintroduced by the marker feature itself.
  const teamValues = teamIdentifyingValues(toolInput);
  const marker = markers.find((m) => m && matchesTeamMarker(teamValues, m));
  if (marker) {
    return {
      decision: "block",
      reason: `generic Linear MCP call carrying a configured AIOS team marker ('${marker}')`,
      fix: "AIOS's board goes through the built-in adapter (`aios linear …`). The MCP bypasses the description guards and the brain projection.",
    };
  }

  // Classifier v2 (default): only identifier-bearing FIELD VALUES make a payload
  // AIOS-targeted. Customer prose that merely mentions an AIO issue stays allowed.
  // `classifier: 1` restores the legacy whole-payload scan for a workspace that wants it.
  const classifier = opts.classifier === 1 ? 1 : TARGET_CLASSIFIER_VERSION;
  const targeted =
    classifier === 1
      ? AIOS_MARKER.test(blob)
      : targetIdentifyingValues(toolInput).some((v) => AIOS_MARKER.test(v));
  if (targeted) {
    return {
      decision: "block",
      reason: `generic Linear MCP call targeting an AIOS issue (classifier v${classifier})`,
      fix: "AIOS's board goes through the built-in adapter: `aios linear get AIO-<n>`. The MCP bypasses the description guards and the brain projection.",
    };
  }
  return {
    decision: "warn",
    reason: "generic Linear MCP call (no AIOS issue targeted — assumed customer work, allowed)",
  };
}

/** The one place the mode string is validated, so every exit path agrees on it. */
function resolveMode(cfg) {
  return ["block", "warn", "off"].includes(cfg?.mode) ? cfg.mode : DEFAULT_MODE;
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
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // Truncated input is unparseable and we cannot tell WHICH tool it belonged to — so blocking
    // here would stop an unrelated Bash call carrying a large heredoc, a false positive on a
    // command this guard has no opinion about. Only the MCP path blocks, and the tool name is at
    // the head of that payload, so a truncated MCP call is still caught.
    // A separate, UNANCHORED pattern: LINEAR_MCP_TOOL is ^-anchored for matching a tool NAME, and
    // here we are scanning raw JSON where the name is a quoted value, not the start of the string.
    // Match the tool_name PROPERTY, not any occurrence in the payload: a >1MB Bash command that
    // merely MENTIONS `mcp__plugin_linear_linear__get_issue` would otherwise be misclassified and
    // blocked — the same "a mention is not a target" mistake the team markers already made once.
    const TRUNCATED_MCP = /"tool_name"\s*:\s*"mcp__[^"]*linear[^"]*__/i;
    if (truncated && TRUNCATED_MCP.test(text.slice(0, 2000))) {
      // The configured mode applies HERE TOO. Setting exit 2 before reading it meant a workspace
      // with mode:"off" was still hard-blocked by an oversized payload — enforcement in a place
      // the operator had explicitly turned enforcement off.
      //
      // The payload is truncated, so its `cwd` cannot be parsed out of it; the config is read
      // from the process's own working directory, which is where a PreToolUse hook runs.
      const mode = resolveMode(loadConfig(undefined));
      if (mode === "off") return;
      const blocking = mode === "block";
      process.stderr.write(
        `[connector-routing-guard] ${blocking ? "BLOCKED" : "advisory"}: a Linear MCP payload ` +
          `exceeded ${STDIN_MAX} bytes and could not be classified. A call this guard cannot ` +
          "read is not a call it can clear.\n"
      );
      if (blocking) process.exitCode = 2;
    }
    return;
  }

  if (!payload || typeof payload !== "object") return;

  const toolName = String(payload.tool_name ?? "");
  const input = payload.tool_input || {};
  const cfg = loadConfig(payload.cwd);
  const mode = resolveMode(cfg);
  if (mode === "off") return;

  let verdict = { decision: "allow" };
  if (toolName === "Bash") {
    // listOrDefault, not `??`: a config with `"stalePaths": "…"` (a string, not a list) previously
    // reached .find()/.includes() and threw, and the top-level catch then exited 0 — a typo in a
    // config file silently disabled enforcement for every call.
    verdict = classifyBash(input.command, {
      stalePaths: listOrDefault(cfg.stalePaths, DEFAULT_STALE),
    });
  } else if (LINEAR_MCP_TOOL.test(toolName)) {
    verdict = classifyMcp(toolName, input, {
      teamMarkers: [...DEFAULT_TEAM_MARKERS, ...listOrDefault(cfg.teamMarkers, [])],
      // `classifier: 1` is the ONLY accepted downgrade value — anything else runs v2.
      classifier: cfg.classifier === 1 ? 1 : TARGET_CLASSIFIER_VERSION,
    });
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
