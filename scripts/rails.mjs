/**
 * rails.mjs — permission-rails tooling (EE7 / AIO-173), packaged as
 * `aios rails suggest|apply|missing`.
 *
 * WHO THIS IS FOR: clients and un-allowlisted repos. An operator who has already
 * hand-tuned their allowlist (or runs auto-mode) gets little from this; the value
 * is bootstrapping a SAFE allowlist and a missing-rails backlog for a fresh repo.
 *
 * THE "PERMISSION-LOG": Claude Code session transcripts (~/.claude/projects/<slug>/
 * *.jsonl) record every tool call the agent made — for Bash, the full command
 * string (`tool_use.input.command`). The NormalizedEvent used by `aios analyze`
 * deliberately DROPS the command body (privacy), and the `mode`/`permission-mode`
 * records are session-wide autonomy toggles, NOT per-command prompts. So there is
 * no "this exact command was gated" marker in the log. The set of commands that
 * were RUN is exactly the set an allowlist would pre-approve, so we scan the raw
 * tool-call log (like the built-in `fewer-permission-prompts` skill) and aggregate
 * by tool + command-prefix.
 *
 * SAFETY: allowlists speed up SAFE repetition — they never replace guards or human
 * review. We only ever PROPOSE; we never write settings without an explicit
 * `rails apply`, and `apply` only touches `permissions.allow` (guards/hooks and every
 * other settings key are left untouched). A conservative denylist (below) means a
 * dangerous command is never proposed even if it is frequent in the log.
 *
 * Zero npm dependencies (Node >= 18). Offline: reads only local transcripts + the repo.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonl } from "./analyze/parse-claude.mjs";
import { discoverClaude } from "./analyze/sources.mjs";
import { loadRubric, scoreRepo } from "../validation/agent-readiness-lib.mjs";
import { safeReal } from "./cli-common.mjs";

// Local ANSI helper (mirrors aios.mjs `c`; relay-core's `c` omits bold).
const c = {
  red: (s) => `\x1b[0;31m${s}\x1b[0m`,
  green: (s) => `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

export const DEFAULT_MIN_COUNT = 3;

// Read-only Claude Code built-ins that are safe to blanket-allow. Every other tool
// (Write/Edit, Bash beyond the safe prefixes below, and ALL MCP tools) stays gated —
// they carry side effects that must keep flowing through guards + human review.
export const SAFE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"]);

// First shell token (basename) we NEVER allowlist, no matter how often it appears.
export const DENIED_PREFIXES = new Set([
  "rm",
  "rmdir",
  "sudo",
  "su",
  "chmod",
  "chown",
  "dd",
  "mkfs",
  "curl",
  "wget",
  "kill",
  "pkill",
  "killall",
  "shutdown",
  "reboot",
  "eval",
  "exec",
  "dotenvx",
  "scp",
  "ssh",
  "nc",
  "ncat",
  "telnet",
]);

// Substring/regex denials applied to the WHOLE command string (belt-and-suspenders
// over the simple-command filter + denied-prefix set). Conservative by design.
export const DENY_PATTERNS = [
  { label: "sudo", re: /\bsudo\b/i },
  { label: "recursive-rm", re: /\brm\s+-\w*[rf]/i },
  { label: "chmod-777", re: /\bchmod\b[^&|;]*\b7{2,3}\b/i },
  { label: "git-push", re: /\bgit\s+push\b/i },
  { label: "git-reset-hard", re: /\bgit\s+reset\s+--hard\b/i },
  { label: "git-clean", re: /\bgit\s+clean\s+-\w*[fd]/i },
  { label: "force-flag", re: /--force(-with-lease)?\b/i },
  { label: "pipe-to-shell", re: /\|\s*(sh|bash|zsh|fish)\b/i },
  { label: "network-fetch", re: /\b(curl|wget)\b/i },
  { label: "publish", re: /\b(npm|yarn|pnpm)\s+publish\b/i },
  { label: "fork-bomb", re: /:\s*\(\s*\)\s*\{/ },
  { label: "dd-write", re: /\bdd\s+if=/i },
  { label: "mkfs", re: /\bmkfs\b/i },
  {
    label: "secret-path",
    re: /(\.env(\.[a-z]+)?\b|\.env\.keys\b|\bid_rsa\b|\.ssh\b|\bcredentials\b|\bsecrets?\b|\.pem\b|\.p12\b|aios-nda)/i,
  },
  { label: "system-redirect", re: />\s*\/(etc|usr|bin|dev|sys|boot|var)\b/i },
];

// A command with any of these is not a stable, single simple command — a prefix
// allowlist entry would over-match (e.g. `Bash(git status:*)` would auto-approve
// `git status && rm -rf /`). We refuse to propose from compound/piped/redirected
// commands entirely — that is the core allowlist footgun this tool avoids.
const SHELL_META = /(&&|\|\||[;&|`<>]|\$\(|\n)/;

/** True when `command` is a single simple command (no shell operators). */
export function isSimpleCommand(command) {
  return typeof command === "string" && command.trim().length > 0 && !SHELL_META.test(command);
}

/** Returns a deny label when the command is dangerous, else null. */
export function isDenied(command) {
  if (typeof command !== "string" || !command.trim()) return "empty";
  const first = command.trim().split(/\s+/)[0] || "";
  const base = first.split("/").pop(); // /bin/rm → rm
  if (DENIED_PREFIXES.has(base)) return `prefix:${base}`;
  for (const { label, re } of DENY_PATTERNS) if (re.test(command)) return label;
  return null;
}

/**
 * The 1–2 token prefix that anchors an allowlist entry. Second token is kept only
 * when it is a sub-command (alnum, not a flag, not a path, not an env assignment) —
 * so `npm test` → "npm test", `git status` → "git status", `ls -la` → "ls".
 * Returns null when there is no stable prefix (e.g. leading `FOO=bar` assignment).
 */
export function commandPrefix(command) {
  const toks = command.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const first = toks[0];
  if (first.includes("=")) return null; // `FOO=bar cmd` — unstable, skip
  const parts = [first];
  const second = toks[1];
  if (second && /^[a-z][a-z0-9:._-]*$/i.test(second) && !second.includes("/")) {
    parts.push(second);
  }
  return parts.join(" ");
}

/**
 * Classify one Bash command → what the suggester should do with it.
 * @returns {{kind:"propose",prefix:string,entry:string}
 *          |{kind:"deny",label:string}
 *          |{kind:"complex"}}
 */
export function classifyCommand(command) {
  const denied = isDenied(command);
  if (denied) return { kind: "deny", label: denied };
  if (!isSimpleCommand(command)) return { kind: "complex" };
  const prefix = commandPrefix(command);
  if (!prefix) return { kind: "complex" };
  return { kind: "propose", prefix, entry: `Bash(${prefix}:*)` };
}

function walkJsonl(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/**
 * Scan the target repo's Claude session transcripts for the tool calls the agent
 * made and aggregate them into allowlist proposals + a denied-command tally.
 *
 * @param {object} o
 * @param {string} o.repo            repo whose transcripts to scan (cwd-scoped)
 * @param {string} [o.transcriptsDir] explicit dir of *.jsonl (tests) — bypasses the
 *   ~/.claude discovery AND the cwd filter (fixtures are already repo-scoped)
 * @param {string} [o.home]          HOME override for ~/.claude discovery (tests)
 */
export function scanTranscripts({ repo, transcriptsDir = null, home = os.homedir() } = {}) {
  const files = transcriptsDir ? walkJsonl(path.resolve(transcriptsDir)) : discoverClaude(home);
  const filterByCwd = !transcriptsDir;
  const repoReal = safeReal(repo);

  const proposals = new Map(); // entry → { entry, tool, prefix, count, sample }
  const denied = new Map(); // key → { label, sample, count }
  let scannedFiles = 0;
  let toolCalls = 0;
  let complex = 0;

  const bump = (map, key, seed, sample) => {
    let e = map.get(key);
    if (!e) map.set(key, (e = { ...seed, count: 0, sample: sample ?? null }));
    e.count += 1;
    if (sample && !e.sample) e.sample = sample;
  };

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scannedFiles += 1;
    for (const r of parseJsonl(text)) {
      if (r?.type !== "assistant") continue;
      if (filterByCwd) {
        const cwdReal = safeReal(r.cwd);
        if (!cwdReal || cwdReal !== repoReal) continue;
      }
      const content = Array.isArray(r.message?.content) ? r.message.content : [];
      for (const b of content) {
        if (!b || b.type !== "tool_use") continue;
        const name = b.name || "";
        if (name === "Bash") {
          const cmd = b.input?.command;
          if (typeof cmd !== "string" || !cmd.trim()) continue;
          toolCalls += 1;
          const cls = classifyCommand(cmd);
          if (cls.kind === "propose") {
            bump(proposals, cls.entry, { entry: cls.entry, tool: "Bash", prefix: cls.prefix }, cmd);
          } else if (cls.kind === "deny") {
            const sig = `${cls.label}::${commandPrefix(cmd) || cmd.slice(0, 24)}`;
            bump(denied, sig, { label: cls.label }, cmd);
          } else {
            complex += 1;
          }
        } else if (SAFE_TOOLS.has(name)) {
          toolCalls += 1;
          bump(proposals, name, { entry: name, tool: name, prefix: null }, null);
        }
        // every other tool (Write/Edit/MCP/…) stays gated — never proposed.
      }
    }
  }

  return {
    repo: repoReal,
    proposals: [...proposals.values()],
    denied: [...denied.values()],
    scannedFiles,
    toolCalls,
    complex,
  };
}

/** Build the review-ready suggestion from a scan: kept proposals + the allow list. */
export function buildSuggestion(scan, { minCount = DEFAULT_MIN_COUNT } = {}) {
  const kept = scan.proposals
    .filter((p) => p.count >= minCount)
    .sort((a, b) => b.count - a.count || a.entry.localeCompare(b.entry));
  const below = scan.proposals.filter((p) => p.count < minCount).sort((a, b) => b.count - a.count);
  const allow = [...new Set(kept.map((p) => p.entry))].sort((a, b) => a.localeCompare(b));
  return {
    minCount,
    allow,
    proposals: kept,
    below,
    denied: scan.denied.sort((a, b) => b.count - a.count),
    stats: { scannedFiles: scan.scannedFiles, toolCalls: scan.toolCalls, complex: scan.complex },
  };
}

// ── settings.json merge (apply) ───────────────────────────────────────────────

/**
 * Merge `additions` into a parsed settings object's `permissions.allow`, deduped +
 * sorted. Everything else (hooks, permissions.deny/ask, any other key) is preserved
 * exactly — this is the acceptance safety invariant: applying an allowlist must not
 * disable guard hooks.
 */
export function mergeAllow(settings, additions) {
  const next = { ...settings };
  const perms = { ...(settings.permissions || {}) };
  const set = new Set(Array.isArray(perms.allow) ? perms.allow : []);
  for (const a of additions) set.add(a);
  perms.allow = [...set].sort((a, b) => a.localeCompare(b));
  next.permissions = perms;
  return next;
}

function settingsPath(repo) {
  return path.join(repo, ".claude", "settings.json");
}

// ── missing-rails backlog ─────────────────────────────────────────────────────

// Lenient read for READ-ONLY checks (missing-rails scoring): corrupt file → null.
function readSettings(repo) {
  const p = settingsPath(repo);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Strict read for the WRITE path (apply): a corrupt existing settings.json must abort — treating
// it as empty would silently wipe the user's hooks and every other key on rewrite.
function readSettingsForWrite(repo) {
  const p = settingsPath(repo);
  if (!existsSync(p)) return {};
  const parsed = JSON.parse(readFileSync(p, "utf8")); // throws → caller dies, file untouched
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`settings file is not a JSON object: ${p}`);
  }
  return parsed;
}

function hasAllowlist(repo) {
  const s = readSettings(repo);
  return Boolean(
    s && s.permissions && Array.isArray(s.permissions.allow) && s.permissions.allow.length
  );
}

function hasGuardHooks(repo) {
  const s = readSettings(repo);
  if (s && s.hooks && (s.hooks.PreToolUse || s.hooks.PostToolUse)) return true;
  const hooksDir = path.join(repo, "hooks");
  try {
    return readdirSync(hooksDir).some((f) => f.endsWith(".sh") || f.endsWith(".mjs"));
  } catch {
    return false;
  }
}

function hasLeakGate(repo) {
  return [
    "scripts/leak-gate.sh",
    "hooks/leak-gate.sh",
    "leak-gate.sh",
    ".config/aios-nda",
    "scripts/leak-gate-terms.sh",
  ].some((rel) => existsSync(path.join(repo, rel)));
}

// The rails backlog. Rubric-derived rows REUSE `aios assess-codebase` scoring
// (validation/agent-readiness-lib.mjs) via `fromCheck`; the AIOS-native rails
// (allowlist / guard hooks / leak gate) are the only new probes — the general
// rubric does not cover them. Order = remediation priority (highest first).
const RAILS = [
  {
    id: "claude_md",
    title: "Agent instructions (CLAUDE.md / AGENTS.md)",
    fromCheck: "agent_instructions_present",
    how: "add a CLAUDE.md at the repo root describing build/test/conventions",
  },
  {
    id: "guard_hooks",
    title: "Guard hooks (PreToolUse guard / hooks dir)",
    probe: hasGuardHooks,
    how: "add a PreToolUse hook in .claude/settings.json (see hooks/team-ops-guard.sh)",
  },
  {
    id: "allowlist",
    title: "Permission allowlist (.claude/settings.json → permissions.allow)",
    probe: hasAllowlist,
    how: "run `aios rails suggest` then `aios rails apply`",
  },
  {
    id: "secret_scanning",
    title: "Secret scanning / ignore hygiene",
    fromCheck: "secret_scanning",
    how: "add a secrets check + .gitignore for .env (see validation/check-secrets.sh)",
  },
  {
    id: "leak_gate",
    title: "Leak gate (confidential-term guard)",
    probe: hasLeakGate,
    how: "add scripts/leak-gate.sh + a pre-commit hook (see aios-workspace)",
  },
  {
    id: "tests",
    title: "Test suite",
    fromCheck: "tests_present",
    how: "add a test/ suite and a `test` script",
  },
  {
    id: "precommit",
    title: "Pre-commit / pre-push hooks",
    fromCheck: "precommit_hooks",
    how: "add .husky/ or .pre-commit-config.yaml (or git hooks)",
  },
  {
    id: "linter",
    title: "Linter configured",
    fromCheck: "linter_configured",
    how: "add an eslint/ruff/etc. config",
  },
  {
    id: "ci",
    title: "CI on PRs",
    fromCheck: "ci_on_pr",
    how: "add a CI workflow that runs on pull_request",
  },
];

/** Compute the missing-rails backlog for a repo (reuses assess-codebase scoring). */
export function missingRails(repo) {
  const result = scoreRepo(repo, loadRubric());
  const passById = new Map(result.checks.map((ck) => [ck.id, ck.pass]));
  const items = [];
  for (const r of RAILS) {
    const present = r.fromCheck ? passById.get(r.fromCheck) === true : r.probe(repo);
    if (!present) items.push({ id: r.id, title: r.title, how: r.how });
  }
  return { repo, level: result.level, levelName: result.levelName, missing: items };
}

// ── flag parsing ──────────────────────────────────────────────────────────────

function flagVal(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

function intFlag(args, name, dflt) {
  const v = flagVal(args, name);
  if (v == null) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ── subcommands ───────────────────────────────────────────────────────────────

function railsSuggest(repo, args) {
  const asJson = args.includes("--json");
  const minCount = intFlag(args, "--min-count", DEFAULT_MIN_COUNT);
  const transcriptsDir = flagVal(args, "--transcripts-dir");
  const scan = scanTranscripts({ repo, transcriptsDir });
  const s = buildSuggestion(scan, { minCount });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          repo,
          minCount,
          permissions: { allow: s.allow },
          proposals: s.proposals.map((p) => ({ entry: p.entry, count: p.count })),
          denied: s.denied.map((d) => ({ label: d.label, sample: d.sample, count: d.count })),
          stats: s.stats,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(c.bold(`Permission-rails suggestion — ${repo}`));
  console.log(
    c.dim(
      `  scanned ${s.stats.scannedFiles} transcript file(s), ${s.stats.toolCalls} tool call(s); ` +
        `min-count ${minCount}; ${s.stats.complex} compound command(s) skipped`
    )
  );
  if (!s.proposals.length) {
    console.log(c.yellow("  no proposals — nothing safe seen ≥ min-count in the log"));
  } else {
    console.log(c.bold("\n  proposed permissions.allow (review before applying):"));
    for (const p of s.proposals) console.log(`    ${p.entry.padEnd(32)} ${c.dim(`×${p.count}`)}`);
    console.log(c.bold("\n  JSON snippet:"));
    console.log("    " + JSON.stringify({ permissions: { allow: s.allow } }));
  }
  if (s.denied.length) {
    console.log(c.bold("\n  excluded by the safety denylist (never proposed):"));
    for (const d of s.denied)
      console.log(`    ${c.red(d.label.padEnd(20))} ${c.dim(`×${d.count}`)}  ${d.sample || ""}`);
  }
  if (s.below.length) {
    console.log(
      c.dim(`\n  ${s.below.length} candidate(s) below min-count (raise --min-count to see fewer)`)
    );
  }
  console.log(
    c.dim("\n  apply with: aios rails apply   (guards + human review still gate everything)")
  );
  return 0;
}

function railsApply(repo, args) {
  const dryRun = args.includes("--dry-run");
  const fromFile = flagVal(args, "--from");
  const minCount = intFlag(args, "--min-count", DEFAULT_MIN_COUNT);
  const transcriptsDir = flagVal(args, "--transcripts-dir");

  let allow;
  if (fromFile) {
    let j;
    try {
      j = JSON.parse(readFileSync(path.resolve(fromFile), "utf8"));
    } catch (e) {
      throw new Error(`cannot read proposals file ${fromFile}: ${e.message}`);
    }
    allow = j.permissions?.allow || j.allow || [];
    if (!Array.isArray(allow)) throw new Error(`proposals file has no permissions.allow array`);
  } else {
    const scan = scanTranscripts({ repo, transcriptsDir });
    allow = buildSuggestion(scan, { minCount }).allow;
  }

  const sp = settingsPath(repo);
  let existing;
  try {
    existing = readSettingsForWrite(repo);
  } catch (e) {
    console.error(
      c.red(
        `error: ${sp} exists but cannot be parsed (${e.message}) — fix it by hand; ` +
          `apply refuses to rewrite a file it cannot read.`
      )
    );
    return 4;
  }
  const beforeAllow = existing.permissions?.allow || [];
  const merged = mergeAllow(existing, allow);
  const added = merged.permissions.allow.filter((a) => !beforeAllow.includes(a));
  const nextText = JSON.stringify(merged, null, 2) + "\n";

  console.log(c.bold(`rails apply — ${sp}${existsSync(sp) ? "" : "  (will be created)"}`));
  if (!allow.length) {
    console.log(c.yellow("  no proposals to apply — run `aios rails suggest` first"));
    return 0;
  }
  console.log(c.dim("  permissions.allow diff:"));
  for (const a of beforeAllow) console.log(`    ${c.dim(" " + a)}`);
  for (const a of added) console.log(`    ${c.green("+" + a)}`);
  if (!added.length)
    console.log(c.dim("    (no new entries — allowlist already covers proposals)"));

  if (dryRun) {
    console.log(c.dim("\n  --dry-run: nothing written. hooks + other keys untouched."));
    return 0;
  }

  mkdirSync(path.dirname(sp), { recursive: true });
  const tmp = sp + ".tmp";
  writeFileSync(tmp, nextText);
  renameSync(tmp, sp); // atomic
  console.log(
    c.green(
      `\n  wrote ${added.length} new entr${added.length === 1 ? "y" : "ies"}. hooks preserved.`
    )
  );
  return 0;
}

function railsMissing(repo, args) {
  const asJson = args.includes("--json");
  const report = missingRails(repo);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log(c.bold(`Missing rails — ${repo}`));
  console.log(c.dim(`  agent-readiness: ${report.level} — ${report.levelName}`));
  if (!report.missing.length) {
    console.log(c.green("  ✓ all tracked rails present"));
    return 0;
  }
  console.log(c.bold(`\n  ${report.missing.length} rail(s) absent (priority order):`));
  for (const m of report.missing) {
    console.log(`    ${c.yellow("✗")} ${c.bold(m.title)}`);
    console.log(`        ${c.dim("→ " + m.how)}`);
  }
  return 0;
}

/**
 * `aios rails <suggest|apply|missing>` dispatcher. Offline + read-only except
 * `rails apply` (without --dry-run), which is the only writer and only ever touches
 * `permissions.allow`.
 */
export async function cmdRails(repo, _cfg, args = []) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "suggest") return railsSuggest(repo, rest);
  if (sub === "apply") return railsApply(repo, rest);
  if (sub === "missing") return railsMissing(repo, rest);
  throw new Error(
    "usage: aios rails <suggest|apply|missing> [--repo <path>] [--json]\n" +
      "  suggest [--min-count N] [--transcripts-dir <dir>]   propose a safe permissions.allow\n" +
      "  apply   [--dry-run] [--from <json>] [--min-count N]  merge proposals into .claude/settings.json\n" +
      "  missing                                              list absent rails (reuses assess-codebase)"
  );
}
