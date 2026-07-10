#!/usr/bin/env node
/**
 * aios.mjs — AIOS Team Brain sync client for aios-workspace repos.
 *
 * Zero npm dependencies (Node >= 18: built-in fetch, crypto, fs).
 * Contract: docs/brain-api.md (v1). Tier vocabulary: admin | team | external
 * (`client` accepted as a legacy alias of `external`). `admin` and untagged
 * files NEVER sync — default-deny before any network call.
 *
 * Commands:
 *   aios status                what would sync: new / modified / blocked / clean
 *   aios push [--dry-run] [paths…]
 *   aios pull                  fetch team updates → 01-intake/from-brain/ (append-only)
 *   aios query "question"      NL query against the Team Brain
 *   aios export-okf [dir]      emit a tier-filtered OKF bundle (offline, no brain needed)
 *   aios pull-bundle           pull OKF link graph from Team Brain → .aios/bundle.json
 *   aios graph [--from <file>] traverse local OKF link graph (offline, no brain needed)
 *
 * Options: --repo <path> (default: walk up from cwd to find aios.yaml)
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  cpSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listConnectors,
  getDescriptor,
  validateConnector,
  storeConnector,
  vaultSet,
  vaultGet,
  ensureGitignore,
  backupConfig,
  startOAuth,
  pollOAuthStatus,
  postBrainToken,
} from "./connector.mjs";
// Lazy-loaded only inside cmdOnboard (below the non-TTY early-return) — every other
// `aios` command (status/push/pull/query/...) must stay fast and dependency-free at
// import time; only the interactive onboarding wizard needs @clack/prompts.
import { parseFlatYaml } from "./flat-yaml.mjs";
import { loadDotEnv, envGet, resolveBrainConfig } from "./brain-config.mjs";
import { parseTaskRows, mergeTaskWriteback } from "./tasks-table.mjs";
import {
  parseFrontmatter,
  normalizeTier,
  classifyKind,
  parseDecisionRows,
} from "./workspace-parse.mjs";
import { EXPORT_RUNTIMES } from "./runtimes.mjs";
import { loadRubric, scoreRepo } from "../validation/agent-readiness-lib.mjs";
import { c, die, sha256, slugify, gitConfig } from "./cli-common.mjs";
import { cmdAnalyze } from "./analyze/index.mjs";
import { cmdRelay } from "./relay.mjs";
import { cmdBuild } from "./build.mjs";
import { cmdSimplify } from "./simplify.mjs";
import { cmdSpec } from "./spec-eval.mjs";
import { runCouncil } from "./council.mjs";
import { cmdReviewBugbot } from "./review-bugbot.mjs";
import { cmdPr } from "./pr.mjs";
import { cmdConsolidateFindings } from "./consolidate-findings.mjs";
import { cmdShip } from "./ship.mjs";
import { cmdRoadmapRun } from "./roadmap-run.mjs";
import { cmdRails } from "./rails.mjs";
import { cmdMember } from "./member-cli.mjs";
import { createBrainClient } from "./brain-client.mjs";
import { cmdInstincts } from "./instincts.mjs";
import { cmdMode } from "./mode.mjs";
import { cmdWorktree } from "./worktree.mjs";
import { cmdMaturityWeek } from "./maturity-week-cmd.mjs";
import { cmdTime } from "./time.mjs";
import { cmdTimeline } from "./timeline.mjs";
import { cmdAsks } from "./asks.mjs";
import { cmdDecisions } from "./decisions.mjs";
import { cmdLoop } from "./loop.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SYNCABLE_TIERS = ["team", "external"]; // canonical; `client` normalizes to external

// Embedded fallback if validation/secret-patterns.txt is unavailable
const FALLBACK_SECRET_PATTERNS = [
  "AKIA[0-9A-Z]{16}",
  "-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
  "gh[ps]_[A-Za-z0-9_]{36,}",
  "xox[bporas]-[A-Za-z0-9-]+",
  "sk-[A-Za-z0-9_-]{40,}",
];

// ── tiny helpers ────────────────────────────────────────────────────────────
// c / die / sha256 / slugify / gitConfig now live in ./cli-common.mjs (the single
// source of truth, shared with relay-core.mjs, build.mjs, and loop-config.mjs).
// Imported at the top of this file.

// ── restricted YAML (flat scalars + one level of string lists) ─────────────
// Deliberately minimal: aios.yaml is constrained to this subset (OGR04
// enforces it). Nested structures are NOT supported — by design.

// parseFlatYaml + stripQuotes now live in ./flat-yaml.mjs (shared with the GUI
// runtime-adapter config reader). Imported at the top of this file.

// ── frontmatter / tiers ──────────────────────────────────────────────────────
// parseFrontmatter + normalizeTier now live in ./workspace-parse.mjs (shared with the
// operator-loop collector so tier normalization stays single-sourced). Imported above.

// ── config + identity ───────────────────────────────────────────────────────

function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "aios.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Offline commands (export-okf, graph) don't require aios.yaml.
// Walk up looking for project.yaml | engagement.yaml | README.md as fallbacks.
function findRepoRootOffline(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (
      existsSync(path.join(dir, "aios.yaml")) ||
      existsSync(path.join(dir, "project.yaml")) ||
      existsSync(path.join(dir, "engagement.yaml")) ||
      existsSync(path.join(dir, "README.md"))
    )
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadOfflineConfig(repo) {
  let projCfg = {};
  for (const f of ["project.yaml", "engagement.yaml"]) {
    const p = path.join(repo, f);
    if (existsSync(p)) {
      projCfg = parseFlatYaml(readFileSync(p, "utf8"));
      break;
    }
  }
  // Brain config from env/.env so offline-capable commands that opt into the
  // network (e.g. `aios analyze --push`) work outside a stamped workspace — the
  // toolkit repo and ad-hoc dirs have no aios.yaml. Mirrors loadConfig's resolution.
  const keyEnv = "AIOS_API_KEY";
  const cfg = {
    project: projCfg.slug || slugify(path.basename(repo)),
    project_members: projCfg.members || [],
    sync_tiers: ["team", "external"],
    sync_include: [],
    sync_exclude: [],
    brain_url: "",
    api_key: "",
    api_key_env: keyEnv,
    team_id: "",
  };
  return mergeBrainSecrets(cfg, repo);
}

/**
 * Resolve brain URL + API key from process.env and .env files on the target
 * workspace AND the aios-workspace toolkit root. Delegates to the shared
 * resolveBrainConfig (./brain-config.mjs) so the CLI and the GUI server reach the
 * brain the same way; the only CLI-specific bit is the cfg.brain_url fallback +
 * cfg.api_key_env override.
 */
function mergeBrainSecrets(cfg, repo) {
  const resolved = resolveBrainConfig(repo, { apiKeyEnv: cfg.api_key_env || "AIOS_API_KEY" });
  cfg.brain_url = resolved.brain_url || (cfg.brain_url || "").trim();
  cfg.api_key = resolved.api_key;
  if (resolved.team_id) cfg.team_id = resolved.team_id;
  return cfg;
}

function loadConfig(repo) {
  const cfgPath = path.join(repo, "aios.yaml");
  if (!existsSync(cfgPath)) die(`no aios.yaml found in ${repo}`);
  const raw = readFileSync(cfgPath, "utf8");
  const unfilled = raw.match(/\{\{[A-Z_]+\}\}/);
  if (unfilled) {
    die(
      `aios.yaml still has an unfilled template placeholder (${unfilled[0]}). ` +
        `This looks like scaffold/aios.yaml.tmpl was copied in directly instead of generated. ` +
        `Run scripts/scaffold-project.sh to create a real aios.yaml, or hand-fill one from ` +
        `scaffold/aios.yaml.example (see docs/GETTING-STARTED.md).`
    );
  }
  const cfg = parseFlatYaml(raw);

  cfg.sync_tiers = (cfg.sync_tiers || []).map(normalizeTier);
  if (cfg.sync_tiers.includes("admin")) {
    die("aios.yaml lists 'admin' in sync_tiers — admin content never syncs. Remove it.");
  }
  for (const t of cfg.sync_tiers) {
    if (!SYNCABLE_TIERS.includes(t)) die(`aios.yaml: unknown sync tier '${t}'`);
  }
  cfg.sync_include = cfg.sync_include || [];
  cfg.sync_exclude = cfg.sync_exclude || [];

  mergeBrainSecrets(cfg, repo);

  // Project slug from project.yaml | engagement.yaml
  let projCfg = {};
  for (const f of ["project.yaml", "engagement.yaml"]) {
    const p = path.join(repo, f);
    if (existsSync(p)) {
      projCfg = parseFlatYaml(readFileSync(p, "utf8"));
      break;
    }
  }
  cfg.project = projCfg.slug || slugify(path.basename(repo));
  cfg.project_members = projCfg.members || [];
  return cfg;
}

function resolveMember(repo, cfg, dotenv) {
  const toolkit = path.join(SCRIPT_DIR, "..");
  const extra = path.resolve(toolkit) !== path.resolve(repo) ? loadDotEnv(toolkit) : {};
  const candidate =
    envGet("AIOS_MEMBER", dotenv, extra) ||
    cfg.member ||
    gitConfig(repo, "aios.member") ||
    slugify(gitConfig(repo, "user.name"));
  if (!candidate) {
    die(
      "cannot resolve member identity. Set one of: $AIOS_MEMBER, aios.yaml `member`, " +
        "`git config aios.member <name>`, or git user.name"
    );
  }
  if (cfg.project_members.length && !cfg.project_members.includes(candidate)) {
    die(
      `member '${candidate}' is not in project.yaml members ` +
        `[${cfg.project_members.join(", ")}]. Fix your identity or the member list.`
    );
  }
  return candidate;
}

// ── secret scanning (shared patterns) ──────────────────────────────────────

function loadSecretPatterns() {
  const shared = path.join(SCRIPT_DIR, "..", "validation", "secret-patterns.txt");
  let lines = FALLBACK_SECRET_PATTERNS;
  if (existsSync(shared)) {
    lines = readFileSync(shared, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }
  return lines.map((l) => new RegExp(l));
}

function findSecret(content, patterns) {
  for (const re of patterns) if (re.test(content)) return re.source;
  return null;
}

// ── file walking + classification ───────────────────────────────────────────

function walkFiles(repo, cfg) {
  const files = [];
  const excludes = cfg.sync_exclude.map((e) => e.replace(/\/$/, ""));
  const isExcluded = (rel) => excludes.some((e) => rel === e || rel.startsWith(e + "/"));

  for (const inc of cfg.sync_include) {
    const abs = path.join(repo, inc);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (st.isFile()) {
      if (!isExcluded(inc)) files.push(inc);
      continue;
    }
    const stack = [abs];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const absChild = path.join(dir, entry.name);
        const rel = path.relative(repo, absChild);
        if (isExcluded(rel)) continue;
        if (entry.isDirectory()) stack.push(absChild);
        else if (entry.name.endsWith(".md") || entry.name.endsWith(".yaml")) {
          files.push(rel);
        }
      }
    }
  }
  return [...new Set(files)].sort();
}

// classifyKind + parseDecisionRows now live in ./workspace-parse.mjs (shared with the
// operator-loop collector). Imported above. parseTableRows/parseTaskRows stay in
// ./tasks-table.mjs.

// ── state ───────────────────────────────────────────────────────────────────

function loadState(repo) {
  const p = path.join(repo, ".aios", "state.json");
  if (!existsSync(p))
    return { items: {}, last_pull: null, last_tasks_pull: null, last_decisions_pull: null };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { items: {}, last_pull: null, last_tasks_pull: null };
  }
}

function saveState(repo, state) {
  const dir = path.join(repo, ".aios");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
}

// ── plan: classify every candidate file ─────────────────────────────────────

function buildPlan(repo, cfg, patterns, onlyPaths = null) {
  const state = loadState(repo);
  const plan = { push: [], blocked: [], clean: [] };

  let files = walkFiles(repo, cfg);
  if (onlyPaths?.length) {
    const wanted = onlyPaths.map((p) => path.relative(repo, path.resolve(repo, p)));
    files = files.filter((f) => wanted.some((w) => f === w || f.startsWith(w + "/")));
  }

  for (const rel of files) {
    const raw = readFileSync(path.join(repo, rel), "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const kind = classifyKind(rel, frontmatter);
    const hash = sha256(raw);

    const tier = normalizeTier(frontmatter?.access || "");
    if (!frontmatter || !frontmatter.access) {
      plan.blocked.push({ rel, reason: "no `access:` frontmatter (default-deny)" });
      continue;
    }
    if (tier === "admin") {
      plan.blocked.push({ rel, reason: "`access: admin` never syncs" });
      continue;
    }
    if (!cfg.sync_tiers.includes(tier)) {
      plan.blocked.push({ rel, reason: `tier '${tier}' not in sync_tiers` });
      continue;
    }
    const secret = findSecret(raw, patterns);
    if (secret) {
      plan.blocked.push({ rel, reason: `secret pattern matched: ${secret}` });
      continue;
    }

    const prev = state.items[rel];
    if (prev && prev.sha === hash) {
      plan.clean.push({ rel });
      continue;
    }
    let rows;
    if (kind === "task") rows = parseTaskRows(body);
    if (kind === "decision") rows = parseDecisionRows(body);
    plan.push.push({
      rel,
      kind,
      hash,
      tier,
      frontmatter,
      body,
      rows,
      isNew: !prev,
    });
  }
  return { plan, state };
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function requireOnline(cfg) {
  if (!cfg.brain_url) {
    die("aios.yaml has no brain_url (offline/standalone mode). Set brain_url or AIOS_BRAIN_URL.");
  }
  if (!cfg.api_key) {
    die(`no API key found in $${cfg.api_key_env || "AIOS_API_KEY"} (env or .env)`);
  }
}

// Resolved-config → shared brain client. Config resolution stays here (workspace-
// walking, see loadConfig); only the authed-request/SSE layer is shared with the
// MCP server via scripts/brain-client.mjs.
function brainClient(cfg) {
  return createBrainClient({
    brain_url: cfg.brain_url,
    api_key: cfg.api_key,
    team_id: cfg.team_id,
  });
}

async function api(cfg, method, route, body = null) {
  return brainClient(cfg).fetchJson(method, route, body);
}

// GET an OPTIONAL endpoint: tolerate a 404 (older brain that predates it) by returning
// `fallback`; surface any other failure (auth/server) as a visible warning rather than
// silently swallowing it. Never throws — a missing writeback endpoint must not break pull.
async function apiOptional(cfg, route, fallback) {
  try {
    return await api(cfg, "GET", route);
  } catch (e) {
    if (/^404\b/.test(String(e?.message))) return fallback;
    console.warn(c.yellow(`  ${route} unavailable: ${e?.message ?? e}`));
    return fallback;
  }
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdStatus(repo, cfg, patterns, args = []) {
  const { plan } = buildPlan(repo, cfg, patterns);
  if (args.includes("--json")) {
    const item = (i) => ({
      rel: i.rel,
      kind: i.kind || null,
      tier: i.tier || null,
      isNew: !!i.isNew,
    });
    console.log(
      JSON.stringify({
        project: cfg.project,
        brain_url: cfg.brain_url || null,
        items: {
          new: plan.push.filter((i) => i.isNew).map(item),
          modified: plan.push.filter((i) => !i.isNew).map(item),
          blocked: plan.blocked.map((i) => ({ rel: i.rel, reason: i.reason })),
          clean: plan.clean.map((i) => ({ rel: i.rel })),
        },
      })
    );
    return;
  }
  if (args.includes("--porcelain")) {
    const newCount = plan.push.filter((i) => i.isNew).length;
    console.log(
      `new=${newCount} modified=${plan.push.length - newCount} ` +
        `blocked=${plan.blocked.length} clean=${plan.clean.length}`
    );
    return;
  }
  const mode = cfg.brain_url ? cfg.brain_url : c.dim("<offline/standalone>");
  console.log(c.blue(`aios status — project '${cfg.project}' → ${mode}`));
  console.log("");

  const newItems = plan.push.filter((i) => i.isNew);
  const modified = plan.push.filter((i) => !i.isNew);

  const section = (label, items, fmt) => {
    if (!items.length) return;
    console.log(label);
    for (const i of items) console.log(`  ${fmt(i)}`);
    console.log("");
  };
  section(
    c.green(`new (${newItems.length}):`),
    newItems,
    (i) => `${i.rel} ${c.dim(`[${i.kind}, ${i.tier}]`)}`
  );
  section(
    c.yellow(`modified (${modified.length}):`),
    modified,
    (i) => `${i.rel} ${c.dim(`[${i.kind}, ${i.tier}]`)}`
  );
  section(
    c.red(`blocked (${plan.blocked.length}):`),
    plan.blocked,
    (i) => `${i.rel} — ${i.reason}`
  );
  console.log(c.dim(`clean (already synced): ${plan.clean.length}`));

  if (plan.blocked.length) {
    console.log("");
    console.log(
      c.dim(
        "blocked files never leave this machine. To sync one: add `access: team` " +
          "(or `external`) frontmatter — promotion is deliberate."
      )
    );
  }
}

// Best-effort: open a URL in the user's default browser. Returns false (caller prints the
// URL) if the platform opener isn't available.
function openUrl(u) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    execFileSync(cmd, [u], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// One-click OAuth connect: ask the brain for an authorize_url, open the browser, poll until
// the brain has the token, then install the skill. The token never touches this machine.
// On timeout/denial (or `--token`), falls back to a manual paste POSTed straight to the brain.
async function oauthConnectFlow(repo, d, { ask, tokenFlag } = {}) {
  const cfg = resolveBrainConfig(repo);
  console.log(c.blue(`\nConnect ${d.name}`));
  if (!cfg.brain_url || !cfg.api_key) {
    console.log(
      c.red(
        "  no brain connection — set brain_url in aios.yaml (or AIOS_BRAIN_URL) and your API key (run `aios onboard`)."
      )
    );
    return false;
  }
  if (d.scopes?.length) console.log(c.dim(`  scopes: ${d.scopes.join(" · ")}`));

  // Manual token provided up front (--token xoxp-…) → skip the browser dance.
  if (tokenFlag) return storeOAuthToken(repo, d, cfg, tokenFlag);

  let authorizeUrl;
  try {
    ({ authorize_url: authorizeUrl } = await startOAuth(d, cfg));
  } catch (e) {
    console.log(c.red(`  couldn't start sign-in: ${e.message}`));
    return false;
  }
  console.log("  opening your browser to authorize…");
  if (!openUrl(authorizeUrl))
    console.log(c.dim(`  open this URL to authorize:\n  ${authorizeUrl}`));

  process.stdout.write(c.dim("  waiting for you to finish in the browser… "));
  let status;
  try {
    status = await pollOAuthStatus(d, cfg, { onTick: () => process.stdout.write(c.dim(".")) });
  } catch (e) {
    console.log("");
    if (e.code !== "oauth_timeout") {
      console.log(c.red(`  sign-in failed: ${e.message}`));
      return false;
    }
    console.log(c.yellow("  timed out waiting for authorization."));
    const ownRl = ask
      ? null
      : readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask_ = ask || ((q) => new Promise((res) => ownRl.question(q, res)));
    const token = (
      await ask_("  paste a Slack user token (xoxp-…), or press Enter to skip: ")
    ).trim();
    if (ownRl) ownRl.close();
    if (!token) {
      console.log(c.red(`  ${d.name} not connected.`));
      return false;
    }
    return storeOAuthToken(repo, d, cfg, token);
  }
  console.log("");
  return finishOAuth(repo, d, status);
}

// Manual fallback: send a pasted token straight to the brain, then install the skill.
async function storeOAuthToken(repo, d, cfg, token) {
  let res;
  try {
    res = await postBrainToken(d, cfg, token);
  } catch (e) {
    console.log(c.red(`  ${d.name} not connected: ${e.message}`));
    return false;
  }
  return finishOAuth(repo, d, {
    slack_user_id: res.slack_user_id,
    workspace: res.workspace,
  });
}

// Install the skill artifact + flip status, print the confident "connected as … in …".
function finishOAuth(repo, d, status) {
  try {
    storeConnector(repo, d, {}); // no secret to vault — the token lives in the brain
  } catch (e) {
    console.log(
      c.yellow(`\n⚠ Authorized in the team brain, but skill install failed: ${e.message}`)
    );
    console.log(c.dim("  retry: aios connect slack-personal"));
    return false;
  }
  const who = status.slack_user_id ? ` as ${status.slack_user_id}` : "";
  const where = status.workspace ? ` in ${status.workspace}` : "";
  console.log(c.green(`\n✓ Connected to ${d.name}${who}${where}.`));
  console.log(
    c.dim(
      `  token stored in the team brain (not on this machine) · skill installed → .claude/skills/${d.skill.skill_name}/`
    )
  );
  return true;
}

// Connect one already-resolved descriptor: print guidance → collect secrets → validate
// live → store. Returns true on success, false on a skipped/failed attempt (callers decide
// how to signal that). Pass `ask` to swap in a different secret-collection prompt — the
// onboarding wizard (cmdOnboard) and an interactive `aios connect <id>` both pass
// onboard-ui.mjs's clack-backed askViaClack (masked input); omit it and connectFlow opens
// its own plain readline question for a single non-interactive-safe standalone connect.
async function connectFlow(repo, d, { sets = {}, tokenFlag = null, ask } = {}) {
  // OAuth connectors take a separate one-click path (browser → brain), not local secrets.
  if (d.auth_mode === "oauth") return oauthConnectFlow(repo, d, { ask, tokenFlag });

  const required = (d.secrets || []).filter((s) => s.required !== false);

  // print connect guidance (the "exact URL + scopes" moment)
  console.log(c.blue(`\nConnect ${d.name}`));
  if (d.docs?.token_create_url) console.log(`  create a key:  ${d.docs.token_create_url}`);
  if (d.docs?.instructions) console.log(c.dim(`  ${d.docs.instructions}`));
  if (d.scopes?.length)
    console.log(
      c.dim(
        `  scopes: ${d.scopes.join(" · ")}${d.scopes_advisory ? " (set these on the key)" : ""}`
      )
    );
  console.log("");

  const ownRl = ask
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask_ = ask || ((q) => new Promise((res) => ownRl.question(q, res)));
  const values = {};
  for (const s of required) {
    if (sets[s.env] != null) values[s.env] = sets[s.env];
    else if (tokenFlag && s === required[0]) values[s.env] = tokenFlag;
    else values[s.env] = (await ask_(`  ${s.label} (${s.env}): `)).trim();
  }
  if (ownRl) ownRl.close();
  if (required.some((s) => !values[s.env])) {
    console.log(c.red("  missing required value(s) — skipped."));
    return false;
  }

  // validate live
  process.stdout.write(c.dim("  validating… "));
  const result = await validateConnector(d, values);
  console.log("");
  for (const ch of result.checks)
    console.log(`  ${ch.ok ? c.green("✓") : c.red("✗")} ${ch.name} ${c.dim("— " + ch.detail)}`);
  if (!result.ok) {
    console.log(c.red(`\n${d.name} not connected (${result.error}).`));
    if (d.docs?.token_create_url)
      console.log(c.dim(`  fix: create a fresh key at ${d.docs.token_create_url}`));
    return false;
  }

  // store (encrypt + write artifact + flip status); include any captured values (e.g. team id)
  const stored = storeConnector(repo, d, { ...values, ...(result.captured || {}) });
  const who = result.identity?.value ? ` as ${result.identity.value}` : "";
  const where = result.instance?.value ? ` in ${result.instance.value}` : "";
  console.log(c.green(`\n✓ Connected to ${d.name}${who}${where}.`));
  console.log(
    c.dim(
      `  secret encrypted in .env (dotenvx) · ${stored.transport === "mcp" ? "MCP server added to .mcp.json" : `skill installed → .claude/skills/${d.skill.skill_name}/`}`
    )
  );
  return true;
}

// aios connect [<id>] — guided connect→validate→store for an integration (headless engine).
async function cmdConnect(repo, args) {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.log(c.blue("connectable integrations:"));
    for (const conn of listConnectors(repo)) {
      const badge = conn.status === "wired" ? c.green("✓ wired") : c.dim("○ available");
      console.log(
        `  ${conn.id.padEnd(12)} ${badge}  ${c.dim(`[${conn.transport}] ${conn.summary}`)}`
      );
    }
    console.log(c.dim("\nrun: aios connect <id>"));
    return;
  }
  let d;
  try {
    d = getDescriptor(repo, id);
  } catch (e) {
    die(e.message);
  }

  // collect secret values: --token sets the primary required secret; --set ENV=VALUE for others.
  const sets = {};
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--set" && args[i + 1]) {
      const [k, ...v] = args[i + 1].split("=");
      sets[k] = v.join("=");
    }
  const tokenFlag = args.includes("--token") ? args[args.indexOf("--token") + 1] : null;

  // Interactively prompted secrets (not covered by --set/--token) get masked input too —
  // this is the same connectFlow the onboarding wizard drives, and the plaintext-echo
  // fix applies equally to `aios connect <id>` run standalone.
  const ask = process.stdin.isTTY ? (await import("./onboard-ui.mjs")).askViaClack : undefined;

  const ok = await connectFlow(repo, d, { sets, tokenFlag, ask });
  if (!ok) process.exitCode = 1;
}

const TEAM_BRAIN_PSEUDO_ID = "__team_brain__";

/**
 * The ONE next action for this workspace, computed from real state instead of a static
 * multi-step list — replaces the "7-step next steps" wall (scaffold-project.sh's own
 * post-scaffold print, and this file's old cmdOnboard closing lines) with a small
 * 3-branch state machine reused by both call sites. `scripts/scaffold-project.sh` calls
 * into this via `aios onboard --print-next-only` so the logic lives in exactly one place.
 */
function nextAction(repo) {
  if (!vaultGet(repo, "AIOS_API_KEY")) {
    return "Connect the Team Brain: run `aios onboard` (or set AIOS_API_KEY + brain_url/team_id in aios.yaml).";
  }
  const state = loadState(repo);
  if (!Object.keys(state.items || {}).length) {
    return "Run `aios status` to see what would sync, then `aios push`.";
  }
  return "Start the workspace GUI: `npm run gui -- --repo .`";
}

// aios onboard — guided first-run setup: one multi-select over every connector the
// workspace knows about (Team Brain pinned + pre-selected at top, already-wired tools
// pre-selected too), then masked secret entry + live validation feedback per item.
// Every step is optional. Interactive only — on a non-TTY (CI, piped scaffold) it prints
// the same guidance and exits 0 so it never blocks.
async function cmdOnboard(repo, args = []) {
  if (args.includes("--print-next-only")) {
    console.log(nextAction(repo));
    return;
  }

  const connectors = listConnectors(repo);

  if (!process.stdin.isTTY) {
    console.log(c.blue("AIOS onboarding"));
    console.log("  Run these from an interactive terminal:");
    console.log(c.dim("    aios onboard              # guided setup (brain + tools)"));
    console.log(c.dim("    aios connect <id>         # any one tool"));
    console.log(
      c.dim(
        "  Brain: set AIOS_API_KEY in .env, fill brain_url + team_id in aios.yaml, then: aios status"
      )
    );
    return;
  }

  const { pickConnectors, askSecret, askViaClack, reportValidation, clack } =
    await import("./onboard-ui.mjs");

  clack.intro("AIOS onboarding");
  const backedUp = backupConfig(repo);
  if (backedUp.length) clack.log.info(`Backed up existing config first: ${backedUp.join(", ")}`);

  const hasBrainKey = !!vaultGet(repo, "AIOS_API_KEY");
  const teamBrainOption = {
    id: TEAM_BRAIN_PSEUDO_ID,
    name: "AIOS Team Brain",
    summary: "Powers push/pull/status/query — get your key from your dashboard's profile page",
    status: hasBrainKey ? "wired" : "available",
  };

  const selection = await pickConnectors(connectors, { pinned: teamBrainOption });

  if (selection.includes(TEAM_BRAIN_PSEUDO_ID) && !hasBrainKey) {
    const key = await askSecret("AIOS_API_KEY", {
      instructions: "Sign in to your Team Brain dashboard → your profile → Generate my API key.",
    });
    if (!key) {
      clack.log.warn("AIOS_API_KEY: no key entered — skipped.");
    } else {
      try {
        vaultSet(repo, "AIOS_API_KEY", key);
        ensureGitignore(repo);
        reportValidation([
          { name: "AIOS_API_KEY", ok: true, detail: "encrypted into .env (dotenvx)" },
        ]);
      } catch (e) {
        reportValidation([{ name: "AIOS_API_KEY", ok: false, detail: e.message }]);
      }
    }
  }

  // Every other selected connector goes through the SAME connect→validate→store engine
  // as standalone `aios connect <id>` — only the `ask` callback changes (clack's masked
  // password prompt instead of a plaintext-echoing readline question). connectFlow
  // already renders its own ✓/✗ check lines and the "connected as … in …" confirmation.
  for (const id of selection.filter((v) => v !== TEAM_BRAIN_PSEUDO_ID)) {
    const conn = connectors.find((cn) => cn.id === id);
    if (conn?.status === "wired") continue; // already connected — nothing to do
    try {
      await connectFlow(repo, getDescriptor(repo, id), { ask: askViaClack });
    } catch (e) {
      clack.log.error(`${conn?.name || id}: ${e.message}`);
    }
  }

  // Profile — the agent doesn't know who you are yet. Point at the workspace-setup skill
  // rather than invoking it here (this is a plain Node script, not a Claude session). Kept
  // as its own follow-on question, after the connector list finishes, not interleaved.
  const wantsProfile = await clack.confirm({
    message: "Set up your profile now — name, role, working style?",
  });
  if (!clack.isCancel(wantsProfile) && wantsProfile) {
    clack.log.step('Say this once your GUI/CLI session starts: "set me up"');
    clack.log.message("(interviews you, or drafts from a link — always confirms before writing)");
  }

  clack.outro(nextAction(repo));
}

// aios review — interactive review-and-push panel for the terminal.
async function cmdReview(repo, cfg, patterns, _args) {
  const { plan } = buildPlan(repo, cfg, patterns);
  const pushable = plan.push;

  if (!pushable.length) {
    console.log(c.green("nothing to review — all eligible files are clean."));
    if (plan.blocked.length) {
      console.log(c.red(`\nblocked (${plan.blocked.length}):`));
      for (const b of plan.blocked) console.log(`  ${b.rel} — ${b.reason}`);
    }
    return;
  }

  const selected = new Set(pushable.map((_, i) => i));
  const render = () => {
    console.log("");
    console.log(
      c.blue(`aios review — project '${cfg.project}' → ${cfg.brain_url || c.dim("<offline>")}`)
    );
    console.log(c.dim("toggle inclusion, then push only what you chose. Promotion is deliberate."));
    console.log("");
    pushable.forEach((i, idx) => {
      const box = selected.has(idx) ? c.green("[x]") : "[ ]";
      const tag = i.isNew ? c.green("NEW") : c.yellow("MOD");
      console.log(
        `  ${box} ${String(idx + 1).padStart(2)}. ${i.rel} ${c.dim(`[${i.kind}, ${i.tier}]`)} ${tag}`
      );
    });
    if (plan.blocked.length) {
      console.log("");
      console.log(c.red(`  blocked (${plan.blocked.length}) — cannot be selected:`));
      for (const b of plan.blocked) console.log(c.dim(`    ${b.rel} — ${b.reason}`));
    }
    console.log(c.dim(`\n  clean (already synced): ${plan.clean.length}`));
    console.log("");
    console.log(
      c.dim("  commands: <n> toggle · a all · n none · d dry-run · p push selected · q quit")
    );
  };

  // Queue-based line reader: buffers lines from the 'line' event (so piped input
  // isn't lost to a race) and returns null only once the queue is drained at EOF.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = [];
  let waiting = null,
    ended = false;
  rl.on("line", (l) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(l);
    } else queue.push(l);
  });
  rl.on("close", () => {
    ended = true;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(null);
    }
  });
  const ask = (q) => {
    process.stdout.write(q);
    if (queue.length) return Promise.resolve(queue.shift());
    if (ended) return Promise.resolve(null);
    return new Promise((res) => {
      waiting = res;
    });
  };

  for (;;) {
    render();
    const ans = await ask(c.blue("> "));
    if (ans === null) {
      rl.close();
      console.log("\naborted — nothing pushed.");
      return;
    }
    const raw = ans.trim().toLowerCase();
    if (raw === "" || raw === "q") {
      rl.close();
      console.log("aborted — nothing pushed.");
      return;
    }
    if (raw === "a") {
      pushable.forEach((_, i) => selected.add(i));
      continue;
    }
    if (raw === "n") {
      selected.clear();
      continue;
    }
    if (/^\d/.test(raw)) {
      for (const tok of raw.split(/[\s,]+/)) {
        const idx = parseInt(tok, 10) - 1;
        if (idx >= 0 && idx < pushable.length) {
          if (selected.has(idx)) selected.delete(idx);
          else selected.add(idx);
        }
      }
      continue;
    }
    if (raw === "d" || raw === "p") {
      const chosen = [...selected].sort((a, b) => a - b).map((i) => pushable[i].rel);
      if (!chosen.length) {
        console.log(c.yellow("nothing selected."));
        continue;
      }
      rl.close();
      const flags = raw === "d" ? ["--dry-run"] : [];
      return cmdPush(repo, cfg, patterns, [...chosen, ...flags]);
    }
    console.log(c.yellow(`unknown command: ${raw}`));
  }
}

async function cmdPush(repo, cfg, patterns, args) {
  if (args[0] === "skill") return cmdPushSkill(repo, cfg, patterns, args.slice(1));
  if (args[0] === "blueprint") return cmdPushBlueprint(repo, cfg, args.slice(1));
  const dryRun = args.includes("--dry-run");
  const paths = args.filter((a) => !a.startsWith("--"));
  const { plan, state } = buildPlan(repo, cfg, patterns, paths);

  if (!plan.push.length) {
    console.log(c.green("nothing to push — all eligible files are clean."));
    if (plan.blocked.length)
      console.log(c.dim(`(${plan.blocked.length} blocked — run 'aios status' for reasons)`));
    return;
  }

  if (dryRun) {
    console.log(c.yellow(`DRY RUN — would push ${plan.push.length} item(s):`));
    for (const item of plan.push) {
      const rowInfo = item.rows ? ` rows=${item.rows.length}` : "";
      console.log(
        `  ${item.rel} [${item.kind}, ${item.tier}]${rowInfo} sha=${item.hash.slice(0, 12)}`
      );
    }
    if (plan.blocked.length) {
      console.log(c.red(`blocked (${plan.blocked.length}):`));
      for (const b of plan.blocked) console.log(`  ${b.rel} — ${b.reason}`);
    }
    return;
  }

  requireOnline(cfg);
  const dotenv = loadDotEnv(repo);
  const member = resolveMember(repo, cfg, dotenv);

  let pushed = 0;
  for (const item of plan.push) {
    const payload = {
      project: cfg.project,
      path: item.rel,
      kind: item.kind,
      content_sha256: item.hash,
      actor: member,
      access: item.tier,
      frontmatter: item.frontmatter || {},
      body: item.body,
    };
    if (item.rows) payload.rows = item.rows;
    try {
      const res = await api(cfg, "POST", "/items", payload);
      state.items[item.rel] = {
        sha: item.hash,
        remote_id: res.id || null,
        pushed_at: new Date().toISOString(),
      };
      pushed++;
      console.log(`  ${c.green("✓")} ${item.rel} ${c.dim(res.status || "")}`);
    } catch (e) {
      console.log(`  ${c.red("✗")} ${item.rel} — ${e.message}`);
    }
  }
  saveState(repo, state);
  console.log("");
  console.log(c.green(`pushed ${pushed}/${plan.push.length} item(s).`));
  if (plan.blocked.length)
    console.log(c.dim(`${plan.blocked.length} blocked — run 'aios status' for reasons.`));
}

async function cmdPull(repo, cfg, args = []) {
  if (args[0] === "skill") return cmdPullSkill(repo, cfg, args.slice(1));
  if (args[0] === "deliverable") return cmdPullDeliverable(repo, cfg, args.slice(1));
  if (args[0] === "blueprint") return cmdPullBlueprint(repo, cfg);
  requireOnline(cfg);
  const state = loadState(repo);
  const since = state.last_pull || "1970-01-01T00:00:00Z";
  // New spine: 1-inbox/from-brain/; legacy: 01-intake/from-brain/.
  const inboxDir = existsSync(path.join(repo, "1-inbox")) ? "1-inbox" : "01-intake";
  const destRel = `${inboxDir}/from-brain`;
  const destRoot = path.join(repo, inboxDir, "from-brain");
  mkdirSync(destRoot, { recursive: true });

  let cursor = null;
  let fetched = 0;
  do {
    const qs = new URLSearchParams({ since });
    if (cursor) qs.set("cursor", cursor);
    const res = await api(cfg, "GET", `/items?${qs}`);
    for (const item of res.items || []) {
      // Append-only: never overwrite working files; flatten path under from-brain/
      const flat = `${item.project}__${item.path.replace(/\//g, "__")}`;
      const dest = path.join(destRoot, flat);
      if (existsSync(dest) && sha256(readFileSync(dest)) === item.content_sha256) continue;
      const fm = [
        "---",
        `from_brain: true`,
        `origin_project: ${item.project}`,
        `origin_path: ${item.path}`,
        `origin_actor: ${item.actor || "unknown"}`,
        `access: ${item.access}`,
        `pulled_at: ${new Date().toISOString()}`,
        "---",
        "",
      ].join("\n");
      writeFileSync(dest, fm + (item.body || ""));
      fetched++;
      console.log(`  ${c.green("✓")} ${destRel}/${flat}`);
    }
    cursor = res.next_cursor || null;
  } while (cursor);

  // Task writeback: UI-created/modified rows → merge into 03-status/tasks.md
  const tasksRes = await api(
    cfg,
    "GET",
    `/tasks?${new URLSearchParams({ since: state.last_tasks_pull || "1970-01-01T00:00:00Z" })}`
  );
  let merged = 0;
  const tasksPath = existsSync(path.join(repo, "3-log", "tasks.md"))
    ? path.join(repo, "3-log", "tasks.md")
    : path.join(repo, "03-status", "tasks.md");
  const incomingTaskRows = (tasksRes.tasks || [])
    .filter((g) => g.project === cfg.project)
    .flatMap((g) => g.rows || []);
  if (existsSync(tasksPath) && incomingTaskRows.length) {
    let content = mergeTaskWriteback(readFileSync(tasksPath, "utf8"), incomingTaskRows);
    merged += incomingTaskRows.length;
    writeFileSync(tasksPath, content);
  }

  // Decision writeback: UI-created/edited rows → merge into 3-log/decision-log.md
  // (mirrors the task writeback; keyed on the `#` column = row_key).
  const decRes = await apiOptional(
    cfg,
    `/decisions?${new URLSearchParams({ since: state.last_decisions_pull || "1970-01-01T00:00:00Z" })}`,
    { decisions: [] }
  );
  let mergedDecisions = 0;
  const decPath = existsSync(path.join(repo, "3-log", "decision-log.md"))
    ? path.join(repo, "3-log", "decision-log.md")
    : path.join(repo, "03-status", "decision-log.md");
  if (existsSync(decPath) && (decRes.decisions || []).length) {
    let content = readFileSync(decPath, "utf8");
    for (const group of decRes.decisions) {
      if (group.project !== cfg.project) continue;
      for (const row of group.rows || []) {
        const line = `| ${row.row_key} | ${row.decided_at || ""} | ${row.title} | ${row.rationale || ""} | ${row.decided_by || ""} | ${row.impact || ""} | ${row.tier ?? ""} | ${row.audience || ""} |`;
        const re = new RegExp(
          `^\\|\\s*${row.row_key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|.*$`,
          "m"
        );
        if (re.test(content)) content = content.replace(re, line);
        else content = content.trimEnd() + "\n" + line + "\n";
        mergedDecisions++;
      }
    }
    writeFileSync(decPath, content);
  }

  // Project registration: brain-created projects (never pushed from a repo) → marker
  // files under from-brain/_projects/ so the workspace is aware of them. Append-only;
  // full local scaffold generation is deferred. Tolerates an older brain (404 → skip).
  let registered = 0;
  const projRes = await apiOptional(cfg, "/projects", { projects: [] });
  const projDir = path.join(repo, inboxDir, "from-brain", "_projects");
  for (const p of projRes.projects || []) {
    if (!p.brain_only || p.slug === cfg.project) continue;
    const marker = path.join(projDir, `${p.slug}.md`);
    if (existsSync(marker)) continue;
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      marker,
      `---\naccess: team\nkind: project-registration\nslug: ${p.slug}\n---\n\n# ${p.name || p.slug}\n\nBrain-created project \`${p.slug}\` (created in the team dashboard; no local workspace yet).\n`
    );
    registered++;
  }

  state.last_pull = new Date().toISOString();
  state.last_tasks_pull = state.last_pull;
  state.last_decisions_pull = state.last_pull;
  saveState(repo, state);
  console.log("");
  console.log(
    c.green(
      `pulled ${fetched} item(s); merged ${merged} task row(s), ${mergedDecisions} decision row(s)` +
        (registered ? `, registered ${registered} brain project(s)` : "") +
        "."
    )
  );
}

// ── skill + artifact share/pull (P4) ─────────────────────────────────────────

function listFilesRec(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRec(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

function isBinary(buf) {
  // crude but effective: a NUL byte in the first 8KB → treat as binary
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Guard against path traversal in server-supplied relative paths.
function safeJoin(base, rel) {
  const dest = path.resolve(base, rel);
  if (dest !== base && !dest.startsWith(base + path.sep)) {
    die(`refusing unsafe path from brain: ${rel}`);
  }
  return dest;
}

// aios push skill <name> — share a skill (SKILL.md as kind 'skill' + references as artifacts)
function resolveSkillDir(repo, name) {
  const direct = path.join(repo, ".claude", "skills", name);
  if (existsSync(path.join(direct, "SKILL.md"))) return direct;
  const scaffold = path.join(repo, "scaffold", ".claude", "skills", name);
  if (existsSync(path.join(scaffold, "SKILL.md"))) return scaffold;
  die(
    `no skill '${name}' at .claude/skills/${name}/SKILL.md` +
      (existsSync(path.join(repo, "scaffold"))
        ? ` or scaffold/.claude/skills/${name}/SKILL.md`
        : "")
  );
}

async function cmdPushSkill(repo, cfg, patterns, args) {
  const dryRun = args.includes("--dry-run");
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) die("usage: aios push skill <name> [--dry-run]");
  const skillDir = resolveSkillDir(repo, name);
  const skillMd = path.join(skillDir, "SKILL.md");

  const raw = readFileSync(skillMd, "utf8");
  const { frontmatter } = parseFrontmatter(raw);
  const tier = normalizeTier(frontmatter?.access || "team");
  if (tier === "admin")
    die(`skill '${name}' is access: private — cannot share. Set access: team to share.`);
  if (!SYNCABLE_TIERS.includes(tier))
    die(`skill tier '${tier}' is not syncable (use team or an outward tier)`);

  // reference files = everything under the skill dir except SKILL.md
  const refs = [];
  for (const r of listFilesRec(skillDir).sort()) {
    if (r === "SKILL.md") continue;
    const buf = readFileSync(path.join(skillDir, r));
    if (isBinary(buf)) {
      console.log(c.yellow(`  skip (binary): ${r}`));
      continue;
    }
    const text = buf.toString("utf8");
    const secret = findSecret(text, patterns);
    if (secret) {
      console.log(c.red(`  skip (secret '${secret}'): ${r}`));
      continue;
    }
    refs.push({ rel: r, body: text, hash: sha256(text) });
  }

  const dotenv = loadDotEnv(repo);
  const member = resolveMember(repo, cfg, dotenv);
  const base = `.claude/skills/${name}`;
  const items = [
    {
      path: `${base}/SKILL.md`,
      kind: "skill",
      body: raw,
      hash: sha256(raw),
      frontmatter: {
        skill: name,
        access: tier,
        manifest: { references: refs.map((r) => r.rel) },
        source_project: cfg.project,
        source_actor: member,
      },
    },
    ...refs.map((r) => ({
      path: `${base}/${r.rel}`,
      kind: "artifact",
      body: r.body,
      hash: r.hash,
      frontmatter: { skill: name, access: tier, skill_ref: true },
    })),
  ];

  if (dryRun) {
    console.log(
      c.yellow(`DRY RUN — would share skill '${name}' (${items.length} file(s), tier ${tier}):`)
    );
    for (const it of items) console.log(`  ${it.path} [${it.kind}] sha=${it.hash.slice(0, 12)}`);
    return;
  }

  requireOnline(cfg);
  const state = loadState(repo);
  let pushed = 0;
  for (const it of items) {
    try {
      const res = await api(cfg, "POST", "/items", {
        project: cfg.project,
        path: it.path,
        kind: it.kind,
        content_sha256: it.hash,
        actor: member,
        access: tier,
        frontmatter: it.frontmatter,
        body: it.body,
      });
      state.items[it.path] = {
        sha: it.hash,
        remote_id: res.id || null,
        pushed_at: new Date().toISOString(),
      };
      pushed++;
      console.log(`  ${c.green("✓")} ${it.path} ${c.dim(`${it.kind} ${res.status || ""}`)}`);
    } catch (e) {
      console.log(`  ${c.red("✗")} ${it.path} — ${e.message}`);
    }
  }
  saveState(repo, state);
  console.log("");
  console.log(
    c.green(`shared skill '${name}': ${pushed}/${items.length} file(s) at tier ${tier}.`)
  );
}

// aios pull skill <name> — fetch SKILL.md + references → 1-inbox/from-brain/skills/<name>/
async function cmdPullSkill(repo, cfg, args) {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) die("usage: aios pull skill <name>");
  requireOnline(cfg);
  const prefix = `.claude/skills/${name}/`;
  const res = await api(cfg, "GET", `/items?${new URLSearchParams({ path_prefix: prefix })}`);
  const items = res.items || [];
  if (!items.length) die(`no skill '${name}' found in the brain (nothing under ${prefix})`);

  const inboxDir = existsSync(path.join(repo, "1-inbox")) ? "1-inbox" : "01-intake";
  const destBase = path.join(repo, inboxDir, "from-brain", "skills", name);
  mkdirSync(destBase, { recursive: true });

  let wrote = 0,
    provenance = null;
  for (const it of items) {
    const rel = it.path.startsWith(prefix) ? it.path.slice(prefix.length) : path.basename(it.path);
    if (!rel) continue;
    const dest = safeJoin(destBase, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, it.body || "");
    if (it.kind === "skill") provenance = it.frontmatter || {};
    wrote++;
    console.log(`  ${c.green("✓")} ${inboxDir}/from-brain/skills/${name}/${rel} ${c.dim(it.kind)}`);
  }
  console.log("");
  console.log(c.green(`pulled skill '${name}': ${wrote} file(s).`));
  if (provenance)
    console.log(
      c.dim(`  source: ${provenance.source_project || "?"} · by ${provenance.source_actor || "?"}`)
    );
  console.log(c.dim(`  review it, then promote: aios install-skill ${name}`));
  console.log(
    c.dim(
      `  (pulled skills are executable code — install is a deliberate act; they never auto-activate)`
    )
  );
}

// aios pull deliverable <path> — fetch one item (or a folder by prefix) on demand
async function cmdPullDeliverable(repo, cfg, args) {
  const p = args.find((a) => !a.startsWith("--"));
  if (!p) die("usage: aios pull deliverable <path>");
  requireOnline(cfg);
  const res = await api(cfg, "GET", `/items?${new URLSearchParams({ path_prefix: p })}`);
  const items = (res.items || []).filter((it) => it.path === p || it.path.startsWith(p));
  if (!items.length) die(`no item matching '${p}' in the brain (above your tier, or not pushed)`);

  const inboxDir = existsSync(path.join(repo, "1-inbox")) ? "1-inbox" : "01-intake";
  let wrote = 0;
  for (const it of items) {
    const fromBrain = path.join(repo, inboxDir, "from-brain");
    const dest = safeJoin(fromBrain, path.join(it.project, it.path));
    mkdirSync(path.dirname(dest), { recursive: true });
    const fm = [
      "---",
      "from_brain: true",
      `origin_project: ${it.project}`,
      `origin_path: ${it.path}`,
      `origin_actor: ${it.actor || "unknown"}`,
      `access: ${it.access}`,
      `pulled_at: ${new Date().toISOString()}`,
      "---",
      "",
    ].join("\n");
    writeFileSync(dest, fm + (it.body || ""));
    wrote++;
    console.log(
      `  ${c.green("✓")} ${inboxDir}/from-brain/${it.project}/${it.path} ${c.dim(it.kind)}`
    );
  }
  console.log("");
  console.log(
    c.green(`pulled ${wrote} item(s) on demand → ${inboxDir}/from-brain/ (append-only).`)
  );
}

// aios install-skill <name> — promote a pulled skill into .claude/skills/ (offline, explicit)
function cmdInstallSkill(repo, args) {
  const force = args.includes("--force");
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) die("usage: aios install-skill <name> [--force]");
  const inboxDir = existsSync(path.join(repo, "1-inbox")) ? "1-inbox" : "01-intake";
  const src = path.join(repo, inboxDir, "from-brain", "skills", name);
  if (!existsSync(src))
    die(
      `no pulled skill '${name}' at ${inboxDir}/from-brain/skills/${name}/ — run: aios pull skill ${name}`
    );
  const dest = path.join(repo, ".claude", "skills", name);
  if (existsSync(dest) && !force) {
    die(
      `.claude/skills/${name}/ already exists — refusing to overwrite (append-only). Re-run with --force to replace.`
    );
  }
  let copied = 0;
  for (const rel of listFilesRec(src)) {
    const to = path.join(dest, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(path.join(src, rel)));
    copied++;
  }
  console.log(c.green(`installed skill '${name}' → .claude/skills/${name}/ (${copied} file(s)).`));
  console.log(
    c.dim("pulled skills are executable code — review SKILL.md + workflow before trusting.")
  );
  console.log(c.dim("refresh the catalog: npm run gen:catalog"));
}

// ── team blueprint (P4 lead→IC) ──────────────────────────────────────────────

// aios push blueprint — publish the team's tool set (from .aios/team-blueprint.json).
async function cmdPushBlueprint(repo, cfg, _args) {
  const selPath = path.join(repo, ".aios", "team-blueprint.json");
  if (!existsSync(selPath))
    die("no .aios/team-blueprint.json — define the team's tools (Team tab) first");
  let sel;
  try {
    sel = JSON.parse(readFileSync(selPath, "utf8"));
  } catch {
    die("team-blueprint.json is not valid JSON");
  }
  requireOnline(cfg);
  const member = resolveMember(repo, cfg, loadDotEnv(repo));
  const body = JSON.stringify(
    {
      blueprint_version: 1,
      team: cfg.team_id || "",
      published_by: member,
      connectors: sel.connectors || {},
    },
    null,
    2
  );
  const payload = {
    project: "_team",
    path: ".aios/blueprint.json",
    kind: "blueprint",
    content_sha256: sha256(body),
    actor: member,
    access: "team",
    frontmatter: { blueprint_version: 1, published_by: member },
    body,
  };
  try {
    const res = await api(cfg, "POST", "/items", payload);
    const n = Object.values(sel.connectors || {}).filter((c) => c.enabled).length;
    console.log(c.green(`published team blueprint: ${n} tool(s) ${c.dim(res.status || "")}`));
  } catch (e) {
    die(e.message.includes("403") ? "only a team lead/admin can publish the blueprint" : e.message);
  }
}

// aios pull blueprint — fetch the team's published tool set → .aios/blueprint.json.
async function cmdPullBlueprint(repo, cfg) {
  requireOnline(cfg);
  const res = await api(cfg, "GET", `/items?${new URLSearchParams({ kinds: "blueprint" })}`);
  const items = res.items || [];
  if (!items.length) {
    console.log(c.dim("no team blueprint published yet."));
    return;
  }
  const latest = items[items.length - 1]; // GET returns ascending by updated_at
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  writeFileSync(path.join(repo, ".aios", "blueprint.json"), latest.body || "{}");
  let n = 0,
    by = "";
  try {
    const b = JSON.parse(latest.body || "{}");
    n = Object.values(b.connectors || {}).filter((c) => c.enabled).length;
    by = b.published_by || "";
  } catch {
    /* */
  }
  console.log(
    c.green(`pulled team blueprint: ${n} tool(s)${by ? ` (by ${by})` : ""} → .aios/blueprint.json`)
  );
}

// aios whoami — print the authenticated member's identity + role (JSON). Lets the
// cockpit tailor the UI (e.g. only leads/admins see the Team publish surface).
async function cmdWhoami(repo, cfg) {
  requireOnline(cfg);
  const me = await api(cfg, "GET", "/me");
  console.log(JSON.stringify(me));
}

// aios stakeholders — query the team-brain Company-Graph (AIO-141). Team-tier only:
// the graph tables carry a team_id but no per-row tier column and there is no RLS
// backstop, so the boundary is enforced in app code — the endpoint 403s an external
// key, and this CLI probes GET /me and rejects EVERY mode for a non-team key up front
// (so --meeting, which reads /items, can't leak a partial answer).
//
//   --owns <domain>    people who OWN/TOUCH/PRODUCE a workflow matching <domain>
//   --who <person>     one person's role, job family, reports-to, and owned workflows
//   --meeting <title>  attendees of a meeting, derived from items.participants
async function cmdStakeholders(repo, cfg, rest) {
  requireOnline(cfg);
  const owns = flagValue(rest, "--owns");
  const who = flagValue(rest, "--who");
  const meeting = flagValue(rest, "--meeting");
  const json = rest.includes("--json");
  const modes = [owns, who, meeting].filter((v) => v != null).length;
  if (modes !== 1) {
    die("usage: aios stakeholders (--owns <domain> | --who <person> | --meeting <title>) [--json]");
  }

  // Tier probe FIRST — reject non-team keys on ALL three modes before any data leg runs.
  let me;
  try {
    me = await api(cfg, "GET", "/me");
  } catch (e) {
    die(`could not verify identity: ${e?.message ?? e}`);
  }
  if (me?.tier !== "team") {
    die("403 forbidden_tier: the stakeholder map is team-tier only");
  }

  if (meeting != null) return stakeholdersMeeting(cfg, meeting, json);

  // --owns / --who read the structured graph. Tolerate ONLY a 404 (an older brain that
  // predates the endpoint) → clean not-available result; surface any other failure
  // (500/network/auth) as an error rather than masquerading it as an empty graph, mirroring
  // the MCP tool. Do NOT route this through apiOptional — that helper is for pull writebacks
  // where swallowing errors is correct; here a hidden failure would look like an empty team.
  let graph;
  try {
    graph = await api(cfg, "GET", "/company-graph");
  } catch (e) {
    if (/^404\b/.test(String(e?.message))) {
      graph = { people: [], ownership: [] };
    } else {
      die(`company graph unavailable: ${e?.message ?? e}`);
    }
  }
  const people = Array.isArray(graph.people) ? graph.people : [];
  const ownership = Array.isArray(graph.ownership) ? graph.ownership : [];
  if (!people.length && !ownership.length) {
    if (json) {
      // Match each mode's found/not-found shape: owns → matches[], who → person.
      console.log(
        owns != null
          ? JSON.stringify({ mode: "owns", query: owns, matches: [] })
          : JSON.stringify({ mode: "who", query: who, person: null })
      );
      return;
    }
    console.log(c.dim("company graph not available or empty on this team."));
    return;
  }
  const byId = new Map(people.map((p) => [p.entity_id, p]));
  const nameOf = (id) => byId.get(id)?.name || id || "unknown";

  if (owns != null) return stakeholdersOwns(owns, ownership, byId, json);
  return stakeholdersWho(who, people, ownership, nameOf, json);
}

// --owns: match ownership edges by case-insensitive substring on the resolved workflow
// name AND its job_family, then map each match's person_id → the actor's name/role.
function stakeholdersOwns(domain, ownership, byId, json) {
  const q = domain.toLowerCase();
  const rows = ownership
    .filter(
      (o) =>
        String(o.target_name || "")
          .toLowerCase()
          .includes(q) ||
        String(o.target_job_family || "")
          .toLowerCase()
          .includes(q)
    )
    .map((o) => {
      const p = byId.get(o.person_id);
      return {
        person: p?.name || o.person_id,
        role: p?.role || null,
        relationship: o.relationship,
        target: o.target_name,
        job_family: o.target_job_family || null,
      };
    });
  if (json) {
    console.log(JSON.stringify({ mode: "owns", query: domain, matches: rows }));
    return;
  }
  if (!rows.length) {
    console.log(c.dim(`no one owns anything matching "${domain}".`));
    return;
  }
  console.log(c.blue(`owners of "${domain}":`));
  for (const r of rows) {
    console.log(
      `  ${c.bold(r.person)}${r.role ? c.dim(` (${r.role})`) : ""} — ${r.relationship} ${r.target}` +
        (r.job_family ? c.dim(` · ${r.job_family}`) : "")
    );
  }
}

// --who: first person whose name substring-matches; report role/job_family, reports-to
// (resolved to a name via people[]), and the workflows they own.
function stakeholdersWho(person, people, ownership, nameOf, json) {
  const q = person.toLowerCase();
  const p = people.find((x) =>
    String(x.name || "")
      .toLowerCase()
      .includes(q)
  );
  if (!p) {
    if (json) {
      console.log(JSON.stringify({ mode: "who", query: person, person: null }));
      return;
    }
    console.log(c.dim(`no person matching "${person}" in the company graph.`));
    return;
  }
  const owns = ownership.filter((o) => o.person_id === p.entity_id).map((o) => o.target_name);
  const record = {
    name: p.name,
    role: p.role || null,
    job_family: p.job_family || null,
    reports_to: p.reports_to ? nameOf(p.reports_to) : null,
    owns,
  };
  if (json) {
    console.log(JSON.stringify({ mode: "who", query: person, person: record }));
    return;
  }
  console.log(c.blue(record.name));
  if (record.role) console.log(`  role: ${record.role}`);
  if (record.job_family) console.log(`  job family: ${record.job_family}`);
  if (record.reports_to) console.log(`  reports to: ${record.reports_to}`);
  console.log(`  owns: ${owns.length ? owns.join(", ") : c.dim("—")}`);
}

// --meeting: attendance is items-derived, not graph-derived. Paginate the FULL /items
// cursor loop (page size 200) so a team with >200 artifacts doesn't miss the meeting,
// filtering frontmatter.meeting === true + a case-insensitive title match, then read the
// comma-joined participants string.
async function stakeholdersMeeting(cfg, title, json) {
  const q = title.toLowerCase();
  let cursor = null;
  const found = [];
  do {
    const qs = new URLSearchParams({ since: "1970-01-01T00:00:00Z", kinds: "artifact" });
    if (cursor) qs.set("cursor", cursor);
    const res = await api(cfg, "GET", `/items?${qs}`);
    for (const item of res.items || []) {
      const fm = item.frontmatter || {};
      if (fm.meeting !== true) continue;
      const t = String(fm.title || item.path || "");
      if (!t.toLowerCase().includes(q)) continue;
      const participants = String(fm.participants || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      found.push({ title: t, path: item.path, participants });
    }
    cursor = res.next_cursor || null;
  } while (cursor);

  if (json) {
    console.log(JSON.stringify({ mode: "meeting", query: title, meetings: found }));
    return;
  }
  if (!found.length) {
    console.log(c.dim(`no meeting matching "${title}" found.`));
    return;
  }
  for (const m of found) {
    console.log(c.blue(`attendees of "${m.title}":`));
    console.log(
      `  ${m.participants.length ? m.participants.join(", ") : c.dim("(none recorded)")}`
    );
  }
}

async function cmdQuery(repo, cfg, args) {
  const question = args
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (!question) die('usage: aios query "your question"');
  requireOnline(cfg);

  // SSE stream: delta / sources / done. The shared client owns the request,
  // error mapping, and robust event-block parsing; we keep the CLI's live
  // side effects (stream deltas to stdout, print the done cost line) in handlers.
  let sources = [];
  try {
    await brainClient(cfg).streamQuery(question, null, {
      onDelta: (text) => process.stdout.write(text || ""),
      onSources: (s) => {
        sources = s || [];
      },
      onDone: (data) => {
        process.stdout.write("\n");
        if (typeof data.cost_usd === "number")
          console.log(
            c.dim(
              `(${data.input_tokens} in / ${data.output_tokens} out · $${data.cost_usd.toFixed(4)})`
            )
          );
      },
    });
  } catch (e) {
    die(`query failed: ${e?.message ?? e}`);
  }
  if (sources.length) {
    console.log("");
    console.log(c.blue("sources:"));
    for (const s of sources)
      console.log(`  [${s.id}] ${s.project}/${s.path} ${c.dim(`(${s.kind})`)}`);
  }
}

// ── OKF export helpers ──────────────────────────────────────────────────────

const OKF_SPINE_DIRS = [
  // new intent-named spine
  "0-context",
  "1-inbox",
  "2-work",
  "3-log",
  "4-shared",
  // legacy numbered spine (back-compat)
  "00-engagement",
  "00-project",
  "01-intake",
  "02-deliverables",
  "03-status",
  "04-client-surface",
];

function inferOkfType(rel, frontmatter) {
  // Preserve lowercase "transcript" from source files — classifyKind() uses it.
  // Normalize only during export.
  if (frontmatter?.type) {
    const t = frontmatter.type;
    if (t === "transcript") return "Transcript";
    return t;
  }
  if (/(?:^|[/\\])decision-log\.md$/.test(rel)) return "Decision Log";
  if (/(?:^|[/\\])tasks\.md$/.test(rel)) return "Task List";
  if (/sprint-\d+-ledger\.md$/.test(rel)) return "Sprint Ledger";
  if (/scope-baseline\.md$|scope-ledger\.md$|role\.md$|okrs\.md$/.test(rel)) return "Scope";
  if (/[/\\]transcripts[/\\]/.test(rel)) return "Transcript";
  if (/^(2-work|02-deliverables)[/\\]|[/\\](2-work|02-deliverables)[/\\]/.test(rel))
    return "Deliverable";
  if (/^(4-shared|04-client-surface|04-shared)[/\\]/.test(rel)) return "Deliverable";
  return "Artifact";
}

function walkOkfFiles(repo, tierFilter) {
  const allowedTiers = tierFilter === "team" ? ["team"] : ["team", "external"];
  const files = [];
  for (const dir of OKF_SPINE_DIRS) {
    const abs = path.join(repo, dir);
    if (!existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length) {
      const cur = stack.pop();
      for (const entry of readdirSync(cur, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (entry.name === "index.md") continue; // reserved; generated, not source content
        const absChild = path.join(cur, entry.name);
        const rel = path.relative(repo, absChild);
        if (entry.isDirectory()) {
          stack.push(absChild);
          continue;
        }
        if (!entry.name.endsWith(".md")) continue;
        const raw = readFileSync(absChild, "utf8");
        const { frontmatter } = parseFrontmatter(raw);
        if (!frontmatter?.access) continue;
        const tier = normalizeTier(frontmatter.access);
        if (tier === "admin") continue;
        if (!allowedTiers.includes(tier)) continue;
        files.push({ rel, raw, frontmatter });
      }
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function injectOkfFrontmatter(raw, frontmatter, okfType) {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  const fmLines = raw
    .slice(raw.indexOf("\n") + 1, end)
    .split("\n")
    .filter((l) => l !== "");
  const today = new Date().toISOString().slice(0, 10);
  if (!frontmatter.type) fmLines.push(`type: "${okfType}"`);
  if (!frontmatter.timestamp) {
    const ts = frontmatter.updated || frontmatter.created || today;
    fmLines.push(`timestamp: ${ts}`);
  }
  const newFm = "---\n" + fmLines.join("\n") + "\n---";
  const bodyStart = raw.indexOf("\n", end + 1) + 1;
  return newFm + "\n" + raw.slice(bodyStart);
}

function extractTitle(body) {
  for (const line of body.split("\n")) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

function generateDirIndex(dirRel, entries) {
  const heading = `# Index — ${path.basename(dirRel) || dirRel}`;
  const lines = [heading, ""];
  for (const e of entries) {
    // Use path relative to this index file's directory for standard markdown compat
    const relLink = path.relative(dirRel, e.rel).replace(/\\/g, "/");
    const title = e.title || path.basename(e.rel, ".md");
    const desc = e.frontmatter?.description ? ` — ${e.frontmatter.description}` : "";
    lines.push(`* [${title}](${relLink})${desc}`);
  }
  return lines.join("\n") + "\n";
}

function generateRootLogMd(decisionRows) {
  if (!decisionRows?.length) return "# Change Log\n\n_No decisions recorded._\n";
  const lines = ["# Change Log", ""];
  for (const row of decisionRows) {
    const date = row.decided_at || "";
    const title = row.title || "(untitled)";
    const by = row.decided_by ? ` — ${row.decided_by}` : "";
    lines.push(`## ${date}${date && title ? " — " : ""}${title}${by}`);
    if (row.rationale) {
      lines.push("", row.rationale);
    }
    if (row.impact) {
      lines.push("", `Impact: ${row.impact}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function generateRootIndex(project, members, tierFilter, spineFound) {
  const today = new Date().toISOString().slice(0, 10);
  const memberList =
    Array.isArray(members) && members.length
      ? members.map((m) => `- ${m}`).join("\n")
      : "- (see project.yaml)";
  const contentLinks = spineFound.map((d) => `* [${d}/](${d}/index.md)`).join("\n");
  return [
    "---",
    `okf_version: "0.1"`,
    `type: "Project"`,
    `title: "${project}"`,
    `timestamp: ${today}`,
    "---",
    "",
    `# ${project}`,
    "",
    `OKF bundle exported ${today}. Tier: ${tierFilter}.`,
    "",
    "## Team",
    "",
    memberList,
    "",
    "## Contents",
    "",
    contentLinks,
    "",
    `* [log.md](log.md) — change log (from decision log)`,
    "",
  ].join("\n");
}

async function cmdExportOkf(repo, cfg, args) {
  // Parse flags first, then collect remaining positional args
  let tierFilter = "external";
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier") {
      tierFilter = args[++i] || "external";
      continue;
    }
    if (args[i].startsWith("--")) {
      i++;
      continue;
    } // skip unknown flag + value
    positional.push(args[i]);
  }
  if (!["external", "team"].includes(tierFilter))
    die(`--tier must be 'external' or 'team'; got '${tierFilter}'`);
  const outputArg = positional[0] || null;
  const outputDir = outputArg ? path.resolve(outputArg) : path.join(repo, ".aios", "okf-export");

  console.log(
    c.blue(`aios export-okf — project '${cfg.project}' tier=${tierFilter} → ${outputDir}`)
  );
  if (existsSync(outputDir))
    console.log(c.yellow("  warning: output dir exists — files will be overwritten"));
  mkdirSync(outputDir, { recursive: true });

  const files = walkOkfFiles(repo, tierFilter);
  if (!files.length) {
    console.log(c.yellow("  nothing to export — no files matched tier filter"));
    return;
  }

  const dirEntries = {};
  let exportedCount = 0;

  for (const { rel, raw, frontmatter } of files) {
    const okfType = inferOkfType(rel, frontmatter);
    const injected = injectOkfFrontmatter(raw, frontmatter, okfType);
    const { body } = parseFrontmatter(raw);
    const title = extractTitle(body) || frontmatter.title || path.basename(rel, ".md");

    const dest = path.join(outputDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, injected);
    exportedCount++;
    console.log(`  ${c.green("✓")} ${rel}`);

    const dir = path.dirname(rel);
    if (!dirEntries[dir]) dirEntries[dir] = [];
    dirEntries[dir].push({ rel, frontmatter, title });
  }

  // Per-directory index.md files
  for (const [dir, entries] of Object.entries(dirEntries)) {
    const indexContent = generateDirIndex(dir, entries);
    const indexPath = path.join(outputDir, dir, "index.md");
    writeFileSync(indexPath, indexContent);
    console.log(`  ${c.green("✓")} ${dir}/index.md`);
  }

  // Root log.md from decision-log
  const dlPath = existsSync(path.join(repo, "3-log", "decision-log.md"))
    ? path.join(repo, "3-log", "decision-log.md")
    : path.join(repo, "03-status", "decision-log.md");
  if (existsSync(dlPath)) {
    const dlRaw = readFileSync(dlPath, "utf8");
    const { frontmatter: dlFm, body: dlBody } = parseFrontmatter(dlRaw);
    const dlTier = normalizeTier(dlFm?.access || "");
    const allowed = tierFilter === "team" ? ["team"] : ["team", "external"];
    if (dlFm && allowed.includes(dlTier)) {
      const rows = parseDecisionRows(dlBody);
      writeFileSync(path.join(outputDir, "log.md"), generateRootLogMd(rows));
      console.log(`  ${c.green("✓")} log.md`);
    }
  }

  // Root index.md
  const spineFound = [...new Set(files.map((f) => f.rel.split(/[/\\]/)[0]))].sort();
  writeFileSync(
    path.join(outputDir, "index.md"),
    generateRootIndex(cfg.project, cfg.project_members, tierFilter, spineFound)
  );
  console.log(`  ${c.green("✓")} index.md`);

  console.log("");
  console.log(c.green(`exported ${exportedCount} file(s) → ${outputDir}`));
  console.log(c.dim(`OKF bundle ready — git-hostable; pass a path outside the repo to commit it`));
}

async function cmdPullBundle(repo, cfg, args) {
  requireOnline(cfg);
  const includeBody = args.includes("--include-body");
  let cursor = null;
  const allNodes = [];
  do {
    const qs = new URLSearchParams({ project: cfg.project });
    if (cursor) qs.set("cursor", cursor);
    if (includeBody) qs.set("include_body", "true");
    const res = await api(cfg, "GET", `/okf-bundle?${qs}`);
    allNodes.push(...(res.bundle?.nodes || []));
    cursor = res.next_cursor || null;
  } while (cursor);

  const dest = path.join(repo, ".aios", "bundle.json");
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  writeFileSync(
    dest,
    JSON.stringify(
      {
        project: cfg.project,
        pulled_at: new Date().toISOString(),
        nodes: allNodes,
      },
      null,
      2
    )
  );
  console.log(c.green(`pulled ${allNodes.length} node(s) → .aios/bundle.json`));
  if (!includeBody)
    console.log(c.dim("(frontmatter + links only; add --include-body for full text)"));
}

// ── OKF graph traversal ─────────────────────────────────────────────────────

const LINK_RE = /\[(?:[^\]]*)\]\(([^)#:]+\.(?:md|yaml))\)/g;

function cmdGraph(repo, cfg, args) {
  const fromIdx = args.indexOf("--from");
  const depthIdx = args.indexOf("--depth");
  const formatIdx = args.indexOf("--format");

  let seedRel = null;
  if (fromIdx !== -1) {
    seedRel = path.relative(repo, path.resolve(repo, args[fromIdx + 1]));
  } else {
    // Default: first index.md in a spine dir
    for (const dir of OKF_SPINE_DIRS) {
      const candidate = path.join(dir, "index.md");
      if (existsSync(path.join(repo, candidate))) {
        seedRel = candidate;
        break;
      }
    }
    if (!seedRel && existsSync(path.join(repo, "index.md"))) seedRel = "index.md";
  }
  if (!seedRel || !existsSync(path.join(repo, seedRel)))
    die("no seed file found — use --from <file> or generate index.md stubs (see Tier 3 docs)");

  const maxDepth = depthIdx !== -1 ? parseInt(args[depthIdx + 1], 10) || 3 : 3;
  const format = formatIdx !== -1 ? args[formatIdx + 1] : "text";

  const visited = new Map(); // rel → { title, tier, depth, links }
  const broken = [];
  const queue = [{ rel: seedRel, depth: 0 }];

  while (queue.length) {
    const { rel, depth } = queue.shift();
    if (visited.has(rel)) continue;
    const absPath = path.join(repo, rel);
    if (!existsSync(absPath)) {
      broken.push(rel);
      continue;
    }

    const raw = readFileSync(absPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const tier = normalizeTier(frontmatter?.access || "");
    const titleMatch = (body || raw).match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : path.basename(rel);

    const links = [];
    let m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(raw)) !== null) {
      const rawLink = m[1];
      if (rawLink.startsWith("http")) continue;
      const resolved = path.normalize(path.join(path.dirname(rel), rawLink));
      links.push(resolved);
    }

    visited.set(rel, { title, tier: tier || null, depth, links });

    if (tier === "admin") continue; // don't follow admin-tier outbound links

    if (depth < maxDepth) {
      for (const linkRel of links) {
        if (!visited.has(linkRel)) queue.push({ rel: linkRel, depth: depth + 1 });
      }
    }
  }

  if (format === "json") {
    const out = {};
    for (const [rel, node] of visited)
      out[rel] = { title: node.title, tier: node.tier, depth: node.depth, links: node.links };
    if (broken.length) out["__broken__"] = broken;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(c.blue(`aios graph — '${cfg.project}' from '${seedRel}' (depth ${maxDepth})`));
  console.log("");
  const sorted = [...visited.entries()].sort(
    (a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0])
  );
  for (const [rel, node] of sorted) {
    const indent = "  ".repeat(node.depth);
    const tierTag = node.tier ? c.dim(` [${node.tier}]`) : c.red(" [no-access]");
    const linkCount = node.links.length ? c.dim(` → ${node.links.length} link(s)`) : "";
    console.log(`${indent}${c.green(node.title)}${tierTag}${linkCount}`);
    console.log(`${indent}  ${c.dim(rel)}`);
  }
  if (broken.length) {
    console.log("");
    console.log(c.yellow(`broken links (${broken.length}):`));
    for (const b of broken) console.log(`  ${b}`);
  }
  console.log("");
  console.log(c.dim(`${visited.size} node(s) | ${broken.length} broken link(s)`));
}

// ── skills export (BYOA Phase 2) ─────────────────────────────────────────────
// Export workspace skills into a target agent runtime's format. SKILL.md is the
// canonical, runtime-neutral manifest; runtimes are adapters around it. Runtimes
// without a multi-agent harness get the SKILL.md body as single-agent
// instructions (a flagged degrade), never a silent drop. See docs/byoa.md.

// Skill-export targets are a view over the canonical registry (scripts/runtimes.mjs):
//   { runtime: { harness, layout } }. Single source of truth — see runtimes.mjs.
const SKILL_RUNTIMES = EXPORT_RUNTIMES;

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

// parseFlatYaml flattens `key: |` block scalars to "|"; re-extract them from the
// raw frontmatter text (handles inline + `|`/`>` block scalars).
function readFmField(fmText, key) {
  const lines = fmText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!m) continue;
    const inline = m[1].trim();
    if (inline && !/^[|>][-+]?$/.test(inline)) return inline.replace(/^["']|["']$/g, "");
    const base = (lines[i].match(/^\s*/) || [""])[0].length;
    const collected = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") {
        collected.push("");
        continue;
      }
      if ((lines[j].match(/^\s*/) || [""])[0].length <= base) break;
      collected.push(lines[j].trim());
    }
    return collected.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

// Pull a leading `# Title` off the body so renderers emit exactly one H1.
function splitTitle(body, fallback) {
  const m = body.match(/^#\s+(.+?)\n+/);
  return m
    ? { title: m[1].trim(), rest: body.slice(m[0].length) }
    : { title: fallback, rest: body };
}

// Read .claude/skills/<name>/SKILL.md → {dir,name,kind,description,triggers,workflow,body}
function readWorkspaceSkills(repo) {
  const dir = path.join(repo, ".claude", "skills");
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const sub = path.join(dir, name);
    if (!statSync(sub).isDirectory()) continue;
    const skillMd = path.join(sub, "SKILL.md");
    if (!existsSync(skillMd)) continue; // skips README.md / INDEX.md
    const raw = readFileSync(skillMd, "utf8");
    const { frontmatter: fm, body } = parseFrontmatter(raw);
    if (!fm || !fm.name) continue;
    let description = (fm.description || "").replace(/\s+/g, " ").trim();
    if (!description || /^[|>][-+]?$/.test(description)) {
      const fmText = raw.slice(raw.indexOf("\n") + 1, raw.indexOf("\n---", 3));
      description = readFmField(fmText, "description");
    }
    out.push({
      dir: sub,
      name: fm.name,
      kind: fm.kind || "skill",
      version: fm.version || "1.0.0",
      description,
      triggers: Array.isArray(fm.triggers) ? fm.triggers : [],
      workflow: fm.workflow || null,
      body: (body || "").trim(),
    });
  }
  return out;
}

function degradeNote(runtime) {
  return (
    `> ⚠ Authored as a multi-agent harness for Claude Code. On \`${runtime}\` ` +
    `it runs **single-agent**: follow the steps below directly, without the parallel ` +
    `sub-agent + adversarial-verification passes. Expect more false positives — spot-check results.\n\n`
  );
}

function triggersToTags(triggers) {
  return triggers
    .map((t) =>
      String(t)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    )
    .filter(Boolean)
    .slice(0, 12);
}

// Hermes/OpenClaw-flavored SKILL.md (installable via `hermes skills install`).
function renderSkillMd(runtime, s, degrade) {
  const tags = triggersToTags(s.triggers);
  const fm = [
    "---",
    `name: ${s.name}`,
    `description: ${JSON.stringify(s.description)}`,
    `version: ${s.version}`,
    "platforms: [linux, macos, windows]",
    "metadata:",
    "  byoa:",
    "    source: aios-workspace",
    `    kind: ${s.kind}`,
    ...(runtime === "hermes"
      ? ["  hermes:", `    tags: [${tags.join(", ")}]`]
      : [`  tags: [${tags.join(", ")}]`]),
    "---",
    "",
  ].join("\n");
  const { title, rest } = splitTitle(s.body, s.name);
  return fm + (degrade ? degradeNote(runtime) : "") + `# ${title}\n\n${rest}\n`;
}

// Plain instruction file for Codex / OpenCode / a bare Claude-API loop.
function renderInstructions(runtime, s, degrade) {
  const { title, rest } = splitTitle(s.body, s.name);
  const use = s.triggers.length ? `**Use when:** ${s.triggers.join(" · ")}\n\n` : "";
  return (
    `# ${title}\n\n` +
    `> Skill exported from aios-workspace for \`${runtime}\` (BYOA).\n\n` +
    (degrade ? degradeNote(runtime) : "") +
    use +
    `${rest}\n`
  );
}

function cmdSkills(repo, args) {
  if (args[0] !== "export") {
    die(
      "usage: aios skills export --runtime <name> [--skill <name>] [--out <dir>]\n" +
        `       runtimes: ${Object.keys(SKILL_RUNTIMES).join(", ")}`
    );
  }
  const runtime = flagValue(args, "--runtime");
  const rt = SKILL_RUNTIMES[runtime];
  if (!rt) die(`--runtime must be one of: ${Object.keys(SKILL_RUNTIMES).join(", ")}`);
  const only = flagValue(args, "--skill");
  const outBase = flagValue(args, "--out") || path.join(repo, ".aios", "export", runtime);
  const doInstall = args.includes("--install");

  let skills = readWorkspaceSkills(repo);
  if (only) skills = skills.filter((s) => s.name === only);
  if (!skills.length) {
    die(
      only ? `no skill named '${only}' in .claude/skills/` : "no skills found in .claude/skills/"
    );
  }

  mkdirSync(outBase, { recursive: true });
  const degraded = [];
  const installable = []; // {name, md} for SKILL.md-layout runtimes
  for (const s of skills) {
    const willDegrade = s.kind === "workflow-harness" && !rt.harness;
    if (willDegrade) degraded.push(s.name);
    const skillOut = path.join(outBase, s.name);
    if (rt.layout === "claude") {
      cpSync(s.dir, skillOut, { recursive: true }); // identity: SKILL.md + workflow + refs
    } else {
      mkdirSync(skillOut, { recursive: true });
      const file = rt.layout === "skillmd" ? "SKILL.md" : `${s.name}.md`;
      const render = rt.layout === "skillmd" ? renderSkillMd : renderInstructions;
      const outFile = path.join(skillOut, file);
      writeFileSync(outFile, render(runtime, s, willDegrade));
      if (rt.layout === "skillmd") installable.push({ name: s.name, md: outFile });
    }
    console.log(`  ${s.name}${willDegrade ? " (harness→single-agent)" : ""}`);
  }
  console.log(
    `\nexported ${skills.length} skill(s) for '${runtime}' → ${path.relative(repo, outBase)}/`
  );
  if (degraded.length) {
    console.log(
      `\n⚠ multi-agent harness(es) degraded to single-agent instructions: ${degraded.join(", ")}`
    );
    console.log(
      `  Only claude-code runs the .workflow.js multi-agent harness; ${runtime} uses the SKILL.md body.`
    );
  }

  if (doInstall) {
    installIntoHermes(runtime, installable);
  } else if (runtime === "hermes") {
    console.log(
      `\ninstall into Hermes:  hermes skills install <path-to-SKILL.md> --name <skill> --yes`
    );
    console.log(`  (or re-run with --install to install them now)`);
  }
}

// Best-effort: drive `hermes skills install` for each exported SKILL.md. Never
// throws — Hermes' own skill scanner may block individual skills; we report
// per-skill outcomes rather than failing the whole export.
function installIntoHermes(runtime, installable) {
  if (runtime !== "hermes") {
    console.log(`\n--install currently supports only --runtime hermes (got '${runtime}').`);
    return;
  }
  try {
    execFileSync("hermes", ["--version"], { stdio: "pipe" });
  } catch {
    console.log(
      `\n⚠ 'hermes' not found on PATH — skipping --install. Install Hermes, then re-run.`
    );
    return;
  }
  console.log(`\ninstalling ${installable.length} skill(s) into Hermes…`);
  let ok = 0;
  for (const { name, md } of installable) {
    try {
      execFileSync(
        "hermes",
        ["skills", "install", md, "--name", name, "--category", "aios", "--yes"],
        { stdio: "pipe" }
      );
      console.log(`  ✓ ${name}`);
      ok++;
    } catch (e) {
      const last = String(e.stdout || e.stderr || e.message)
        .split("\n")
        .filter((l) => l.trim())
        .pop();
      console.log(`  ✗ ${name} — ${last || "install failed"}`);
    }
  }
  console.log(
    `installed ${ok}/${installable.length} into Hermes (any ✗ were rejected by Hermes' own scanner).`
  );
}

// ── assess-codebase ───────────────────────────────────────────────────────────

// `aios assess-codebase [path] [--json]` — score a repo's agent-readiness against the
// canonical AEM rubric (validation/agent-readiness.rubric.json). Offline, read-only.
// Scoring lives in validation/agent-readiness-lib.mjs (shared with OGR10). This does NOT
// push to the Team Brain: the brain's ingestion scanner (`aios-ingest scan`) is the single
// canonical codebase-metrics writer — it sends the FULL raw-metrics block + readiness, so
// the row is never overwritten with a sparse readiness-only payload.
async function cmdAssessCodebase(repo, _cfg, _patterns, args = []) {
  const target = path.resolve(args.find((a) => !a.startsWith("--")) || repo);
  const asJson = args.includes("--json");

  const result = scoreRepo(target, loadRubric());

  // OGR13 rides along; buildReport is null on machines without the codebase-memory binary.
  const { buildReport, formatReportLines } = await import("../validation/check-modularity.mjs");
  const modularity = buildReport(target);

  if (asJson) {
    console.log(JSON.stringify(modularity ? { ...result, modularity } : result, null, 2));
    return;
  }

  console.log(`${c.bold ? c.bold("Agent-readiness") : "Agent-readiness"}: ${target}`);
  console.log(
    `  Level ${result.level} — ${result.levelName}  (${result.pct}% of checks, ${result.passed}/${result.total})`
  );
  if (result.capped) console.log(`  ⚠ verification cap applied (no passing verification checks)`);
  for (const p of result.pillars)
    console.log(
      `    ${p.passed === p.total ? "✓" : p.passed === 0 ? "✗" : "•"} ${p.title} (${p.passed}/${p.total})`
    );
  if (result.nextLevel && result.gaps.length) {
    console.log(
      `  To reach ${result.nextLevel}: ${result.gaps
        .slice(0, 4)
        .map((g) => g.title)
        .join(", ")}${result.gaps.length > 4 ? ", …" : ""}`
    );
  }
  if (modularity) for (const line of formatReportLines(modularity)) console.log(line);
}

// `aios learn` — read the owner's saved AEM placement (.claude/memory/MATURITY.md)
// and prescribe the next module + patterns from the individual rubric's patternMap.
// Offline. The `agentic-maturity` skill is what writes MATURITY.md; this is the quick
// "what should I practise next" lookup on top of it.
function cmdLearn(repo, cfg, patterns, _args = []) {
  // The rubric ships beside the skill — in a stamped workspace at .claude/…, in the
  // toolkit dev repo under scaffold/.claude/…. Try both.
  const rubricPath = [
    path.join(repo, ".claude", "skills", "agentic-maturity", "individual.rubric.json"),
    path.join(repo, "scaffold", ".claude", "skills", "agentic-maturity", "individual.rubric.json"),
  ].find((p) => existsSync(p));
  if (!rubricPath) die("agentic-maturity rubric not found — is this an AIOS workspace?");
  const rubric = JSON.parse(readFileSync(rubricPath, "utf8"));

  const memPath = [
    path.join(repo, ".claude", "memory", "MATURITY.md"),
    path.join(repo, "scaffold", ".claude", "memory", "MATURITY.md"),
  ].find((p) => existsSync(p));
  const mem = memPath ? readFileSync(memPath, "utf8") : "";
  const spine = (mem.match(/Spine level:\s*(L[1-5])/) || [])[1] || null;
  const weakest = (mem.match(/Weakest axis:\s*([a-z_]+)/) || [])[1] || null;

  if (!spine) {
    console.log("No agentic-maturity placement found yet.");
    console.log("  Run the assessment first:");
    console.log('    • in the cockpit: ask "assess my agentic maturity" (agentic-maturity skill)');
    console.log("    • or from signals:  npm run aios -- analyze --since 30d");
    return;
  }

  // Prefer a patternMap entry matching spine + weakest axis; fall back to spine-only.
  const entries = rubric.patternMap || [];
  const match =
    entries.find((e) => e.when?.spine === spine && e.when?.weakestAxis === weakest) ||
    entries.find((e) => e.when?.spine === spine && !e.when?.weakestAxis) ||
    entries.find((e) => e.when?.spine === spine);

  console.log(
    `Your agentic-maturity (AM) placement: ${spine}${weakest ? `  (weakest axis: ${weakest})` : ""}`
  );
  if (!match) {
    console.log("  No prescription mapped — see /agentic/patterns.");
    return;
  }

  if (match.priority === "highest")
    console.log("  ▲ highest-priority focus — verification is the differentiator");
  console.log(`\n  Next module: ${match.module}`);
  console.log("  Practise these patterns:");
  for (const id of match.prescribe || []) {
    console.log(`    ${id} — ${rubric.patternTitles?.[id] || id}`);
  }
  console.log(
    `\n  Details: .claude/skills/agentic-maturity/curriculum.md  ·  full library: /agentic/patterns`
  );
}

function tasksFile(repo) {
  const modern = path.join(repo, "3-log", "tasks.md");
  if (existsSync(modern)) return { abs: modern, rel: "3-log/tasks.md" };
  const legacy = path.join(repo, "03-status", "tasks.md");
  if (existsSync(legacy)) return { abs: legacy, rel: "03-status/tasks.md" };
  die("no tasks.md found at 3-log/tasks.md or 03-status/tasks.md");
}

function rowCells(line) {
  return line
    .split("|")
    .slice(1, -1)
    .map((x) => x.trim());
}

function renderRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function setTaskStatus(repo, key, status) {
  const file = tasksFile(repo);
  const lines = readFileSync(file.abs, "utf8").split("\n");
  const headerIdx = lines.findIndex((line) => {
    const cells = rowCells(line).map((h) => h.toLowerCase());
    return cells.includes("id") && cells.includes("task");
  });
  if (headerIdx === -1) die("tasks.md has no task table header");
  const header = rowCells(lines[headerIdx]).map((h) => h.toLowerCase());
  const idIdx = header.indexOf("id");
  const statusIdx = header.indexOf("status");
  if (statusIdx === -1) die("tasks.md task table has no Status column");

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = rowCells(lines[i]);
    if (cells.every((x) => /^[-: ]*$/.test(x))) continue;
    if (cells[idIdx] !== key) continue;
    while (cells.length < header.length) cells.push("");
    cells[statusIdx] = status;
    lines[i] = renderRow(cells);
    writeFileSync(file.abs, lines.join("\n"));
    return file;
  }
  die(`task key '${key}' not found in ${file.rel}`);
}

function gitSha(repo) {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return `manual-${Date.now()}`;
  }
}

function repoFullName(repo) {
  const remote = gitConfig(repo, "remote.origin.url");
  const m = remote.match(/[:/]([^/:]+\/[^/.]+)(?:\.git)?$/);
  return m ? m[1] : path.basename(repo);
}

async function postWorkEvent(repo, cfg, key, actor) {
  try {
    const res = await api(cfg, "POST", "/work-events", {
      project: cfg.project,
      event_kind: "merged",
      repo: repoFullName(repo),
      merged_sha: gitSha(repo),
      pr_url: "",
      pr_title: `Manual completion ${key}`,
      pr_body: `AIOS-Work: ${key}`,
      work_keys: [key],
      actor,
    });
    console.log(
      `  ${c.green("✓")} PM sync event ${c.dim(`${res.applied?.length ?? 0} applied, ${res.unresolved?.length ?? 0} unresolved`)}`
    );
  } catch (e) {
    if (String(e.message).startsWith("404")) {
      console.log(
        c.dim("work-events endpoint not available on this Team Brain; task push succeeded.")
      );
      return;
    }
    throw e;
  }
}

async function cmdWork(repo, cfg, patterns, args) {
  const sub = args[0];
  if (sub !== "done") die("usage: aios work done <key> [--push]");
  const key = args.find((a, i) => i > 0 && !a.startsWith("--"));
  if (!key) die("usage: aios work done <key> [--push]");
  const push = args.includes("--push");
  const file = setTaskStatus(repo, key, "done");
  console.log(`${c.green("✓")} ${file.rel}: ${key} → done`);
  if (!push) {
    console.log(c.dim("run with --push to notify the Team Brain and PM provider"));
    return;
  }
  requireOnline(cfg);
  const member = resolveMember(repo, cfg, loadDotEnv(repo));
  await cmdPush(repo, cfg, patterns, [file.rel]);
  await postWorkEvent(repo, cfg, key, member);
}

// ── operator loop (C1 collector + manifest, C2 evidence ledger) ──────────────
// loadOperatorLoop now lives in ./operator-loop-loader.mjs (shared with the extracted
// mode/loop/asks/decisions/time handler modules). Imported at the top of this file.

// aios loop (V1 Operator Loop CLI): collect / daily / manifest --explain / verify / weekly /
// writeback / telemetry. Extracted to ./loop.mjs (AIO-315); dispatched below as
// cmdLoop(repo, cfg, rest).

// aios time (AIO-139): native agent-session runtime capture. Extracted to ./time.mjs
// (AIO-315); dispatched below as cmdTime(repo, cfg, rest).

// aios asks (AIO-167): non-blocking escalation queue + hook wiring. Extracted to ./asks.mjs
// (AIO-315); dispatched below as cmdAsks(repo, cfg, rest).

// aios decisions (AIO-170 / EE4): human-in-the-loop decision-capture corpus. Extracted to
// ./decisions.mjs (AIO-315); dispatched below as cmdDecisions(repo, cfg, rest).

// aios mode (AIO-168): deep-work / orchestration attention toggle. Extracted to
// ./mode.mjs (AIO-315); dispatched below as cmdMode(repo, cfg, rest).

// aios maturity-week — local weekly AEM report + belts (AM6, AIO-231). Extracted to
// ./maturity-week-cmd.mjs (AIO-315); dispatched below as cmdMaturityWeek(repo, rest).

// aios timeline (AIO-203): screenshot-rich weekly summaries, team + external.
// Extracted to ./timeline.mjs (AIO-315); dispatched below as
// process.exit((await cmdTimeline(repo, cfg, rest)) ?? 0).

// ── main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

// `pr` and `consolidate-findings` own their own `--repo` flag — a GitHub owner/repo slug,
// NOT the workspace path. `timeline` owns it too — repeatable TARGET repo paths (its
// workspace root comes from the cwd walk-up or its own `--workspace`). Don't consume it
// here, or the command never sees the target-repo override.
const repoFlagIdx =
  cmd === "pr" || cmd === "consolidate-findings" || cmd === "timeline"
    ? -1
    : rest.indexOf("--repo");
let repoArg = null;
if (repoFlagIdx !== -1) {
  repoArg = rest[repoFlagIdx + 1];
  rest.splice(repoFlagIdx, 2);
}

// aios worktree — git worktree wrapper with automatic config propagation.
// Extracted to ./worktree.mjs (AIO-315); dispatched below as cmdWorktree(repo, cfg, rest).

const USAGE = `aios — AIOS Team Brain sync client (contract: docs/brain-api.md)

usage:
  aios status [--json|--porcelain]      what would sync (new/modified/blocked/clean)
  aios onboard                          guided first-run setup (brain + tools, one multi-select)
  aios connect [<id>]                   connect an integration (guided + live-validated)
    [--token <v>] [--set ENV=v]         non-interactive credential input
  aios review                           interactive: toggle inclusion, then push selected
  aios push [--dry-run] [paths…]
  aios work done <key> [--push]         mark a task done; --push notifies Brain/PM sync
  aios push skill <name> [--dry-run]    share a skill (SKILL.md + references) to the brain
  aios push blueprint                   publish the team's tool set (lead/admin only)
  aios pull blueprint                   fetch the team's tool set → .aios/blueprint.json
  aios pull                             fetch team updates → 1-inbox/from-brain/
  aios pull skill <name>                fetch a shared skill → 1-inbox/from-brain/skills/<name>/
  aios pull deliverable <path>          fetch one item (or a folder by prefix) on demand
  aios install-skill <name> [--force]   promote a pulled skill into .claude/skills/ (explicit)
  aios query "question"                 ask the Team Brain
  aios member invite <email>            create/re-invite a member + cascade tool invites
    --name <n> --handle <h>              (Linear/Slack/GitHub); admin-key only (brain-api v1.7)
    [--role member|lead|admin]           role default member; tolerates a pre-v1.7 brain (404)
    [--tools linear,slack,github|all|none]  tools default "all"
  aios member list                      team roster (GET /members; team-tier key required)
  aios stakeholders (--owns <domain>    query the team Company-Graph (team-tier only)
    | --who <person> | --meeting <t>)    owners/org from GET /company-graph; attendees from
    [--json]                            meeting items; external key → 403 forbidden_tier
  aios loop collect [--daily|--weekly]  collect local work signals → tier-tagged run manifest
    [--json]                            (.aios/loop/manifests/; offline, never synced)
  aios loop manifest --explain          inspect a manifest's evidence + tiers
    [--as team|external] [--daily]      simulate what a digest audience would see
  aios loop verify --manifest <p>       verify a drafted ledger (evidence + tier-policy) →
    --ledger <p> [--as ...] [--json]    pass/failed (corrected needs C5's drafter); non-zero on failed
    [--smoke]                           --smoke derives a debug ledger from a fresh manifest
  aios loop weekly [--as team|external] weekly closeout: private owner brief + shareable digest(s),
    [--all] [--remote] [--json]         C3-verified + bounded correction → .aios/loop/closeouts/;
    [--manifest <p>] [--dry-run]        offline by default (--remote sends ≤-audience projection only)
  aios loop daily [--as team|external]  fast daily orientation: changed / blocked / owed today
    [--no-record] [--json]              (read-only; owner run records a local change-snapshot)
  aios loop writeback <stamp>           approval-gated promotion of a saved closeout (default: preview)
    [--local] [--sync] [--pm] [--json]  --local/--sync/--pm each opt in one target; stages for aios push
  aios loop telemetry [--window <days>] local dogfood dashboard: the six V1 exit-criteria metrics
    [--all] [--json]                    (owner-only; reads .aios/loop/telemetry/, never synced)
  aios timeline [--since <date|Nd>]     cross-repo "what we shipped": merged PRs + commits →
    --repo <path[=liveUrl]> [...]       screenshot-rich, self-contained HTML per audience
    [--as team|external|all] [--open]   (.aios/timeline/<stamp>/index-<audience>.html);
    [--until <date>] [--dry-run]        external render is tier-filtered + leak-gate swept,
    [--no-shots] [--config <p>] [--json]  fail-closed (exit 2 leak · 3 sweep unavailable);
    [--workspace <p>] [--max-shots N]   repos/tiers/live URLs: .aios/timeline-config.json
  aios mcp                              run the Team Brain MCP server over stdio, for
                                        GUI-only agents (Claude Desktop/Cowork/Codex/Conductor)
                                        that can't shell out; env-first, no workspace needed
  aios analyze [--since 7d|billing] [--tool x]   agentic-maturity + cost from local session logs
    [--report] [--json] [--push]        --push also sends Cursor dashboard billing (W2.1)
    [--full] [--no-cache]               tools: claude|codex|cursor; billing = Cursor cycle
    [--calibrate]                       CE Phase-B verdict (rho vs autonomy); analysis-only, writes .aios/
  aios maturity-week [--json] [--out p]  weekly AEM trajectory: Spine delta, axis gains, next-belt criteria
  aios instincts distill [--limit N] [--dry-run] [--json]  batch-distill observations → homunculus instincts
    [--project <slug>]                  belts White→Black; ≥5 sessions/week → 3-log/maturity/ (admin, never synced)
  aios time capture [--dry-run] [--json]   native agent-session runtime → admin-tier 3-log/time-log.md
    [--config <p>] [--repos <a,b>]      scopes by realpath allowlist (.aios/time-config.json); never syncs
  aios time report [--window daily|weekly]  local runtime-by-tag from the store (read-only) [--json]
  aios time reconcile --id <a,b>        confirm/correct rows (confirmed rows are immutable)
    [--set-tag <t>] [--set-tier <t>] [--confirm] [--dry-run] [--json]
  aios asks list [--status open|resolved|orphaned|all]  escalation queue (local, admin-tier, never synced)
    [--json]                            list open (default) / resolved / orphaned / all
  aios asks add --kind <k>              enqueue an ask (severity: blocker|decision|fyi)
    --severity <s> --title <t> [--body <b>] [--ref <r>] [--json]
  aios asks show <id> | resolve <id...> inspect one ask; mark ask(s) resolved (bookkeeping)
  aios asks drain [--keep-open] [--json]  orphan-detect → resolve open → GC old closed (inbox-zero)
  aios asks harvest [--cadence d|w]     surface loop events (decisions/assignments/…) into the queue
    [--json]                            via the tier-gated comms sender (collect→detect→dispatch)
  aios asks wire [--all-worktrees]      stamp/refresh the asks+decision capture hooks into
    [--dry-run] [--json]                .claude/settings.json via ABSOLUTE toolkit paths — fixes
                                         worktrees whose checked-out branch predates the hooks
  aios mode [status|deep-work|orchestration]  attention toggle: deep-work silences the local ping
    [--json]                            (preferredNotifChannel); orchestration restores it — push untouched
  aios decisions list [--kind k]        human-in-the-loop decision corpus (local, admin-tier, never synced)
    [--since date] [--json]             AskUserQuestion + plan-approval prompts, newest first
  aios decisions show <id> [--json]     full record: options, choice, notes, outcome
  aios decisions outcome <id> <text>    annotate a decision's outcome (append; decisions never mutate)
  aios decisions export [--json]        dump all records as a JSON array (the training-corpus read path)
  aios decisions backfill [--all]       recover historical decisions from ~/.claude transcripts
    [--home d] [--since date]           --all ingests allowlisted repos (foreign origin redacted);
    [--include tag,…] [--dry-run]       client/unknown roots skipped + counted, never ingested
  aios decisions distill --remote       draft reusable steering mental models for HUMAN REVIEW
    [--context tag] [--min-support n]   --remote = consent to third-party (Anthropic) egress
    [--out file]                        default draft: .aios/loop/decisions/decision-principles.draft.md
  aios council "<question>"             fan a question out to a cross-lab model panel (OpenRouter)
    [--models id,id,id]                 P0 prototype: stage-1 first opinions only, no ranking yet
                                         (AIO-225; needs OPENROUTER_API_KEY; fail-closed diversity guard)
  aios export-okf [output-dir]          emit OKF bundle (no brain needed)
    [--tier external|team]              default: external (includes team + external)
  aios pull-bundle [--include-body]     pull OKF link graph from Team Brain → .aios/bundle.json
  aios graph [--from <file>]            traverse local OKF link graph (no brain needed)
    [--depth N] [--format text|json]
  aios skills export --runtime <name>   export skills to another agent runtime (BYOA)
    [--skill <name>] [--out <dir>]      runtimes: claude-code|hermes|openclaw|codex|opencode|claude-api
    [--install]                         for hermes: also run hermes skills install on each
  aios assess-codebase [path]           score a repo's AM agent-readiness (offline, read-only)
    [--json]                            machine output; the Team Brain scanner records scores
  aios worktree add <feat/branch>    create a git worktree + hydrate all config from primary
    [--base <ref>]                     --base defaults to origin/main; links node_modules,
                                       copies opencode.json/.claude/settings, wires hooks
  aios worktree init                  hydrate the current worktree dir (idempotent)
  aios worktree list                  list all worktrees for this repo
  aios rails suggest [--repo <path>]  propose a SAFE permissions.allow from the transcript log
    [--min-count N] [--json]            entries seen ≥N (default 3); denylist excludes dangerous cmds
    [--transcripts-dir <dir>]           NEVER writes; guards + human review still gate everything
  aios rails apply [--repo <path>]      merge proposals into .claude/settings.json (allow only)
    [--dry-run] [--from <json>]         --dry-run prints the diff; hooks + other keys untouched
  aios rails missing [--repo <path>]    list absent rails (CLAUDE.md/allowlist/guards/leak-gate…)
    [--json]                            reuses assess-codebase scoring; each with a how-to pointer
  aios learn                            prescribe your next AM patterns from MATURITY.md (offline)
  aios relay "task" [branch] [opts]     Opus 4.8 ↔ Cursor plan/review loop (PLAN_READY)
    [--rounds N] [--skill /name]        rounds default 3; skill default /review-plan
    [--merge] [--log <file>]            --merge auto-merges branch on approval (off by default)
    [--cursor-timeout N] [--dry-run]    cursor-timeout default 300s; --dry-run skips git ops
    [--build] [--build-rounds N]        after approval, hand the plan to the build phase
  aios build <plan-file|task> [branch]  implement a plan with Opus, reviewed by Cursor (MERGE_READY)
    [--rounds N] [--merge] [--task]     build/review on a worktree; --merge → primary's current branch
    [--pr] [--issue AIO-<n>]            --pr pushes + opens a PR on approval (mutually exclusive with --merge)
    [--build-timeout N] [--verify cmd]  builder timeout default 1800s; --verify runs before review
    [--base ref] [--log <file>]         base default origin/main; --log saves rounds + reviews (appends)
    [--bugbot] [--no-bugbot]            local /review-bugbot before merge (default with --merge)
  aios simplify [--range base..HEAD]    post-review cleanup pass on the branch diff (verify-gated,
    [--model m] [--verify cmd]          reverts on failure; default model from loop-models 'simplify')
  aios spec eval <file> [--json]        score a spec/plan against .claude/rubrics/spec-readiness.md
    [--no-llm] [--rubric <path>]        deterministic + adversarial; exit 0/1/2/3 (verdict-gated)
  aios spec fix <file> [--budget N]     iterate a spec through the bounded fix loop until ready
    [--write | --out <path>] [--no-llm]   default writes <name>.improved.md; --write overwrites
  aios pr [--branch b] [--issue AIO-n]  push the branch + open a GitHub PR (idempotent; prints PR_NUMBER)
    [--title t] [--body-file p]         title default '<issue>: <branch>'; --repo/--dry-run supported
  aios consolidate-findings --pr <n>    merge CI + Bugbot + CodeRabbit + GPT reviews + the PR
    --issue AIO-<n> [--round N]         diff into one severity-ranked finding list (fail-closed)
    [--repo owner/repo] [--gpt-review p]  → .aios/loop/<issue>/findings-r<N>.md; feed to aios build
    [--out p]                           --findings. Exit 0 CLEAR · 3 BLOCKED · 1 error (red CI → 3)
  aios review-bugbot [branch] [opts]     local Cursor Bugbot on worktree branch diff (offline)
    [--base ref] [--worktree path]      requires an existing build worktree for the branch
  aios ship AIO-<n> [--auto]            run the whole gated loop for one issue: plan→build→PR→
    [--auto-merge] [--max-fix-rounds N]  review→fix→merge→cleanup (plan + merge gates default on)
    [--reviewers b,g] [--dry-run]        --dry-run prints the step plan (offline, no key needed)
    [--plan-runner cli|sdk]              plan via Claude Code login (cli) or Opus SDK (sdk; needs key)
  aios roadmap-run (--label|--epic|      serial Linear walker: ship one unblocked issue at a time
    --project) [--max-issues N]          --dry-run lists ordered candidates; digest every run
    [--comment-digest [--digest-target   (requires LINEAR_API_KEY except ship --dry-run)
    AIO-<n>]] [--dry-run]
options:
  --repo <path>               team-ops repo (default: walk up from cwd)`;

if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(USAGE);
  process.exit(0);
}

// `mcp` is the GUI-surface bridge: a long-lived stdio MCP server for agents that can't
// shell out to this CLI (Claude Desktop/Cowork/Codex/Conductor). It must run with NO
// workspace — config is env-first — so it's handled before any repo resolution, and it
// owns the process (blocks on stdin) until the client disconnects.
if (cmd === "mcp") {
  const { resolveBrainConfig, runStdio } = await import("./brain-mcp.mjs");
  const mcpCfg = resolveBrainConfig();
  if (mcpCfg.missing.length) {
    // Brain unconfigured: still start IF a workspace resolves here, exposing local aios_*
    // tools (the Operator Loop collector). brain_* tools return a clear "not configured"
    // error when called. With neither brain config nor a workspace, there's nothing to do.
    // Use the offline resolver so project.yaml / engagement.yaml workspaces are recognized too
    // (matches `aios loop` + the MCP tool's findWorkspaceRoot, not just aios.yaml).
    const ws = findRepoRootOffline(process.cwd());
    if (!ws) {
      die(
        `aios mcp: missing brain config: ${mcpCfg.missing.join(", ")} and no workspace at cwd. ` +
          `Set the brain env (AIOS_BRAIN_URL/AIOS_API_KEY/AIOS_TEAM) or run from a workspace.`
      );
    }
    process.stderr.write(
      `aios mcp: brain not configured (${mcpCfg.missing.join(", ")}); ` +
        `starting in local-only mode — aios_* tools available.\n`
    );
  }
  await runStdio(mcpCfg);
  process.exit(0);
}

// export-okf, graph, install-skill, connect, skills, assess-codebase, learn, analyze, relay
// are offline-capable: no aios.yaml required (analyze reads local ~/.<tool> logs; time reads
// ~/.claude session logs; --push uses env/.env or aios.yaml brain config).
const OFFLINE_CMDS = new Set([
  "export-okf",
  "graph",
  "install-skill",
  "connect",
  "onboard",
  "skills",
  "assess-codebase",
  "learn",
  "analyze",
  "relay",
  "build",
  "simplify",
  "spec",
  "pr",
  "consolidate-findings",
  "review-bugbot",
  // ship + roadmap-run take `--repo <path>` as a WORKSPACE path (the generic walk-up, like
  // build/relay) — NOT a GitHub slug — so they are NOT in the pr/consolidate --repo opt-out.
  // Ship derives the GitHub slug internally via detectRepo(repo).
  "ship",
  "roadmap-run",
  "loop",
  "time",
  "asks",
  "decisions",
  "mode",
  "rails",
  "council",
  "maturity-week",
  "instincts",
  "worktree",
  // timeline reads arbitrary --repo paths + .aios/timeline-config.json; no brain needed
  // (the brain only enriches avatars when configured).
  "timeline",
]);

let repo, cfg;
if (OFFLINE_CMDS.has(cmd)) {
  repo = repoArg ? path.resolve(repoArg) : findRepoRootOffline(process.cwd());
  if (!repo) die("could not locate repo root — pass --repo <path>");
  cfg = existsSync(path.join(repo, "aios.yaml")) ? loadConfig(repo) : loadOfflineConfig(repo);
} else {
  repo = repoArg ? path.resolve(repoArg) : findRepoRoot(process.cwd());
  if (!repo) die("no aios.yaml found walking up from cwd — pass --repo <path>");
  cfg = loadConfig(repo);
}
const patterns = loadSecretPatterns();

try {
  if (cmd === "status") cmdStatus(repo, cfg, patterns, rest);
  else if (cmd === "review") await cmdReview(repo, cfg, patterns, rest);
  else if (cmd === "push") await cmdPush(repo, cfg, patterns, rest);
  else if (cmd === "work") await cmdWork(repo, cfg, patterns, rest);
  else if (cmd === "pull") await cmdPull(repo, cfg, rest);
  else if (cmd === "install-skill") cmdInstallSkill(repo, rest);
  else if (cmd === "connect") await cmdConnect(repo, rest);
  else if (cmd === "onboard") await cmdOnboard(repo, rest);
  else if (cmd === "whoami") await cmdWhoami(repo, cfg);
  else if (cmd === "stakeholders") await cmdStakeholders(repo, cfg, rest);
  else if (cmd === "query") await cmdQuery(repo, cfg, rest);
  else if (cmd === "member")
    await cmdMember(repo, cfg, rest, { api: (m, r, b) => api(cfg, m, r, b) });
  else if (cmd === "export-okf") await cmdExportOkf(repo, cfg, rest);
  else if (cmd === "pull-bundle") await cmdPullBundle(repo, cfg, rest);
  else if (cmd === "graph") cmdGraph(repo, cfg, rest);
  else if (cmd === "skills") cmdSkills(repo, rest);
  else if (cmd === "assess-codebase") await cmdAssessCodebase(repo, cfg, patterns, rest);
  else if (cmd === "learn") cmdLearn(repo, cfg, patterns, rest);
  else if (cmd === "analyze") await cmdAnalyze(repo, cfg, rest, { api, resolveMember, loadDotEnv });
  else if (cmd === "relay") await cmdRelay(repo, rest);
  else if (cmd === "build") await cmdBuild(repo, rest);
  else if (cmd === "simplify") process.exit(await cmdSimplify(repo, rest));
  else if (cmd === "spec") await cmdSpec(repo, rest);
  else if (cmd === "pr") await cmdPr(repo, rest);
  else if (cmd === "consolidate-findings") process.exit(await cmdConsolidateFindings(repo, rest));
  else if (cmd === "review-bugbot") await cmdReviewBugbot(repo, rest);
  else if (cmd === "ship") process.exit(await cmdShip(repo, rest));
  else if (cmd === "roadmap-run") process.exit(await cmdRoadmapRun(repo, rest));
  else if (cmd === "loop") await cmdLoop(repo, cfg, rest);
  else if (cmd === "time") await cmdTime(repo, cfg, rest);
  else if (cmd === "asks") await cmdAsks(repo, cfg, rest);
  else if (cmd === "decisions") await cmdDecisions(repo, cfg, rest);
  else if (cmd === "mode") await cmdMode(repo, cfg, rest);
  else if (cmd === "timeline") process.exit((await cmdTimeline(repo, cfg, rest)) ?? 0);
  else if (cmd === "rails") process.exitCode = (await cmdRails(repo, cfg, rest)) ?? 0;
  else if (cmd === "council") await runCouncil(repo, rest);
  else if (cmd === "maturity-week") cmdMaturityWeek(repo, rest);
  else if (cmd === "instincts") await cmdInstincts(repo, rest);
  else if (cmd === "worktree") await cmdWorktree(repo, cfg, rest);
  else {
    console.log(USAGE);
    process.exit(1);
  }
} catch (e) {
  die(e.message);
}
