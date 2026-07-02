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

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  cpSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  listConnectors,
  getDescriptor,
  validateConnector,
  storeConnector,
  vaultSet,
  ensureGitignore,
  startOAuth,
  pollOAuthStatus,
  postBrainToken,
} from "./connector.mjs";
import { parseFlatYaml } from "./flat-yaml.mjs";
import { loadDotEnv, envGet, resolveBrainConfig } from "./brain-config.mjs";
import { parseTaskRows, mergeTaskWriteback } from "./tasks-table.mjs";
import {
  parseFrontmatter,
  normalizeTier,
  classifyKind,
  parseDecisionRows,
} from "./workspace-parse.mjs";
import { resolveLoopIdentity } from "./loop-config.mjs";
import { EXPORT_RUNTIMES } from "./runtimes.mjs";
import { loadRubric, scoreRepo } from "../validation/agent-readiness-lib.mjs";
import { cmdAnalyze } from "./analyze/index.mjs";
import { cmdRelay } from "./relay.mjs";
import { cmdBuild } from "./build.mjs";
import { cmdReviewBugbot } from "./review-bugbot.mjs";
import { cmdPr } from "./pr.mjs";
import { createBrainClient } from "./brain-client.mjs";

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

const c = {
  red: (s) => `\x1b[0;31m${s}\x1b[0m`,
  green: (s) => `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
  blue: (s) => `\x1b[0;34m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function die(msg) {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function gitConfig(repo, key) {
  try {
    return execFileSync("git", ["-C", repo, "config", "--get", key], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

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
  const cfg = parseFlatYaml(readFileSync(cfgPath, "utf8"));

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
// how to signal that). Pass `ask` to share one readline across several connects (onboard);
// omit it and connectFlow opens+closes its own for a single standalone connect.
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

  const ok = await connectFlow(repo, d, { sets, tokenFlag });
  if (!ok) process.exitCode = 1;
}

// aios onboard — guided first-run setup: connect Firecrawl (so the GUI's "draft from a
// link" works), the Team Brain key, and any other tools the workspace knows about. Every
// step is optional. Interactive only — on a non-TTY (CI, piped scaffold) it prints the
// same guidance and exits 0 so it never blocks.
async function cmdOnboard(repo, _args) {
  const connectors = listConnectors(repo);
  const isWired = (id) => connectors.find((conn) => conn.id === id)?.status === "wired";

  if (!process.stdin.isTTY) {
    console.log(c.blue("AIOS onboarding"));
    console.log("  Run these from an interactive terminal:");
    console.log(c.dim("    aios onboard              # guided setup (Firecrawl, brain, tools)"));
    console.log(c.dim("    aios connect firecrawl    # read a link to draft your profile"));
    console.log(c.dim("    aios connect <id>         # any other tool"));
    console.log(
      c.dim(
        "  Brain: set AIOS_API_KEY in .env, fill brain_url + team_id in aios.yaml, then: aios status"
      )
    );
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const yes = async (q) => /^y(es)?$/i.test((await ask(q)).trim());

  console.log(c.blue("\nWelcome to AIOS. Let's connect a few things — every step is optional.\n"));

  // 1) Firecrawl — powers "draft from a link" in the GUI.
  try {
    if (isWired("firecrawl")) {
      console.log(c.green("✓ Firecrawl already connected."));
    } else if (await yes("Connect Firecrawl, so you can draft your profile from a link? [y/N] ")) {
      await connectFlow(repo, getDescriptor(repo, "firecrawl"), { ask });
    }
  } catch (e) {
    console.log(c.dim(`  (skipping Firecrawl — ${e.message})`));
  }

  // 2) Team Brain — store the API key so push/pull/status work (same dotenvx vault).
  console.log("");
  if (await yes("Connect the Team Brain now (set AIOS_API_KEY)? [y/N] ")) {
    const key = (await ask("  AIOS_API_KEY: ")).trim();
    if (!key) {
      console.log(c.dim("  (no key entered — skipped)"));
    } else {
      try {
        vaultSet(repo, "AIOS_API_KEY", key);
        ensureGitignore(repo);
        console.log(c.green("  ✓ AIOS_API_KEY encrypted into .env (dotenvx)"));
        console.log(c.dim("    confirm brain_url + team_id in aios.yaml, then run: aios status"));
      } catch (e) {
        console.log(c.red(`  could not store the key (${e.message}).`));
        console.log(
          c.dim("    install dotenvx, or run: aios connect <a tool> to bootstrap the vault.")
        );
      }
    }
  }

  // 3) Any other tools the workspace knows about.
  const others = connectors.filter((conn) => conn.id !== "firecrawl" && conn.status !== "wired");
  if (others.length) {
    console.log("");
    if (await yes(`Connect any other tools (${others.map((o) => o.id).join(", ")})? [y/N] `)) {
      for (const conn of others) {
        if (await yes(`  Connect ${conn.id}? [y/N] `)) {
          try {
            await connectFlow(repo, getDescriptor(repo, conn.id), { ask });
          } catch (e) {
            console.log(c.dim(`    (skipping ${conn.id} — ${e.message})`));
          }
        }
      }
    }
  }

  rl.close();
  console.log(c.green("\n✓ You're set."));
  console.log(c.dim("  Start the workspace GUI:  npm run gui -- --repo ."));
  console.log(c.dim("  Re-run anytime:           aios onboard"));
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
async function cmdPushSkill(repo, cfg, patterns, args) {
  const dryRun = args.includes("--dry-run");
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) die("usage: aios push skill <name> [--dry-run]");
  const skillDir = path.join(repo, ".claude", "skills", name);
  const skillMd = path.join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) die(`no skill '${name}' at .claude/skills/${name}/SKILL.md`);

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

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
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
    console.log("No AEM placement found yet.");
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

  console.log(`Your AEM placement: ${spine}${weakest ? `  (weakest axis: ${weakest})` : ""}`);
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
// The collector is TypeScript (workflow layer, per the Engineering Constitution), compiled
// to dist/operator-loop. Imported dynamically ONLY here so no other command depends on the
// build; if it's not built, fail with a clear hint instead of a module-not-found stack.

async function loadOperatorLoop() {
  const distPath = path.join(SCRIPT_DIR, "..", "dist", "operator-loop", "index.js");
  if (!existsSync(distPath)) {
    die("operator-loop is not built — run: npm run build:loop");
  }
  return import(pathToFileURL(distPath).href);
}

const LOOP_TIERS = ["admin", "team", "external"];

// Read + parse a JSON file for `aios loop verify`, failing loud with a precise message rather
// than a module-not-found / SyntaxError stack. CLI inputs are a user-visible contract.
function parseJsonFile(p) {
  if (!existsSync(p)) die(`file not found: ${p}`);
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    die(`cannot read ${p}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`invalid JSON in ${p}: ${e.message}`);
  }
}

// Lightweight runtime shape checks before handing JSON to the typed verifier. An empty
// evidence array is intentionally allowed through — the verifier reports it as an ungrounded
// must-fail (V1), which is the behavior under test, not a CLI usage error.
function validateManifestShape(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) die("manifest: expected a JSON object");
  if (!Array.isArray(m.signals)) die("manifest: missing signals[] array");
  if (!m.window || typeof m.window !== "object") die("manifest: missing window object");
  // Each signal carries the evidence ref the verifier indexes — validate it so a malformed ref
  // becomes a clear CLI error, not a TypeError deep in the verifier's manifest indexing.
  m.signals.forEach((s, i) => {
    if (!s || typeof s !== "object") die(`manifest.signals[${i}]: expected an object`);
    // The top-level `tier` is the field C5's projection trusts as the egress gate — validate it
    // (not just ref.tier) so a hand-edited --manifest with a bogus signal tier is a clear error.
    if (!LOOP_TIERS.includes(s.tier))
      die(`manifest.signals[${i}].tier must be admin|team|external`);
    const ref = s.ref;
    if (!ref || typeof ref.path !== "string")
      die(`manifest.signals[${i}].ref: path must be a string`);
    if (!LOOP_TIERS.includes(ref.tier))
      die(`manifest.signals[${i}].ref: tier must be admin|team|external`);
    if (ref.row !== undefined && typeof ref.row !== "string")
      die(`manifest.signals[${i}].ref: row must be a string when present`);
  });
  return m;
}

function validateLedgerShape(l) {
  if (!l || typeof l !== "object" || Array.isArray(l)) die("ledger: expected a JSON object");
  if (!Array.isArray(l.entries)) die("ledger: missing entries[] array");
  l.entries.forEach((e, i) => {
    if (!e || typeof e !== "object") die(`ledger.entries[${i}]: expected an object`);
    if (typeof e.claim !== "string") die(`ledger.entries[${i}]: claim must be a string`);
    if (!Array.isArray(e.evidence)) die(`ledger.entries[${i}]: evidence must be an array`);
    e.evidence.forEach((r, j) => {
      if (!r || typeof r.path !== "string")
        die(`ledger.entries[${i}].evidence[${j}]: path must be a string`);
      if (!LOOP_TIERS.includes(r.tier))
        die(`ledger.entries[${i}].evidence[${j}]: tier must be admin|team|external`);
      if (r.row !== undefined && typeof r.row !== "string")
        die(`ledger.entries[${i}].evidence[${j}]: row must be a string when present`);
    });
  });
  return l;
}

// A clearly-labeled DEBUG ledger: one grounded claim per manifest signal (each claim's evidence
// is exactly that signal's ref). This is NOT a digest drafter — it exists only to demonstrate the
// verifier contract end-to-end before C5 exists. Output still flows through the tier-safe path.
function smokeLedgerFrom(manifest) {
  return {
    entries: manifest.signals.map((s) => ({
      claim: s.summary || `${s.kind} signal`,
      evidence: [{ path: s.ref.path, row: s.ref.row, tier: s.ref.tier }],
    })),
  };
}

// Audience-safe serialization of a C6 writeback plan: whitelisted fields only (paths repo-relative,
// never file content, never the admin brief body). A final leak sweep on the serialized string is a
// belt-and-suspenders guard — if it ever trips, we refuse to emit rather than risk a leak.
function jsonWriteback(plan, targets, manifest, loop) {
  const payload = {
    stamp: plan.stamp,
    targets,
    files: plan.fileWrites.map((f) => ({
      id: f.id,
      tier: f.tier,
      destRel: f.destRel,
      syncable: f.syncable,
    })),
    taskRows: plan.taskWrite
      ? plan.taskWrite.rows.map((r) => ({ row_key: r.row_key, title: r.title }))
      : [],
    skips: plan.skips,
    tierSafetyWithheld: plan.tierSafetyWithheld,
  };
  const json = JSON.stringify(payload, null, 2);
  if (manifest) {
    // Belt-and-suspenders: the serialized payload must carry no above-audience string.
    const hits = loop.sweepForLeaks(json, loop.aboveAudienceStrings(manifest, "external"));
    if (hits.length) {
      console.error("writeback --json: refusing to emit — payload tripped the leak sweep");
      process.exit(2);
    }
  } else if (payload.taskRows.length > 0 || payload.files.some((f) => f.syncable)) {
    // No manifest ⇒ no leak corpus to sweep against. Syncable content must already have been
    // withheld (fail-closed); if any survived into the payload, refuse rather than emit it unswept.
    console.error("writeback --json: refusing to emit syncable content without a leak backstop");
    process.exit(2);
  }
  return json;
}

// Human render of a C4 DailyOrientation — three sections, one screen, seconds to read. The
// machine surface is `--json` (the full orientation); this is the terse owner-local view.
function renderDaily(o) {
  const today = o.generatedAt.slice(0, 10);
  const marker = o.audience === "owner" ? "owner-private · local only" : `view: ${o.audience}`;
  const printExcludedHint = () => {
    if (!o.counts.excluded) return;
    console.log("");
    console.log(
      c.dim(
        `  ${o.counts.excluded} excluded (default-deny) — run \`aios loop manifest --explain --daily\` to inspect`
      )
    );
  };
  // "Ran (agent runtime)" — aggregate { tag, durationMin } only; safe at any audience (AIO-139).
  const renderRan = () => {
    if (!o.ranByTag?.length) return;
    const h = (m) => `${(m / 60).toFixed(1)}h`;
    const total = o.ranByTag.reduce((a, t) => a + t.durationMin, 0);
    console.log("");
    console.log(c.bold(`Ran (agent runtime · ${h(total)})`));
    for (const t of o.ranByTag)
      console.log(`  • ${c.dim(String(t.tag).padEnd(14))} ${h(t.durationMin)}`);
  };

  console.log(
    c.blue("aios loop daily") +
      c.dim(`  window ${o.window.from.slice(0, 10)} → ${o.window.to.slice(0, 10)}`) +
      c.dim(`     ${marker}`)
  );

  if (o.counts.changed === 0 && o.counts.blocked === 0 && o.counts.owedToday === 0) {
    console.log("");
    console.log(
      `${c.bold("Changed (0)")}   ${c.bold("Blocked (0)")}   ${c.bold("Owed today (0)")}`
    );
    console.log(
      c.green(
        o.counts.excluded
          ? "No classifiable daily items. ✓"
          : "Nothing carried over. You're clear. ✓"
      )
    );
    renderRan();
    printExcludedHint();
    return;
  }

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const refLabel = (it) => (it.ref.row ? `${it.ref.path}#${it.ref.row}` : it.ref.path);
  const annot = (it) => {
    if (it.stale != null) return c.dim(`  (stale ${it.stale}d)`);
    if (it.due) {
      const dd = String(it.due).slice(0, 10);
      return c.dim(`  (due ${dd === today ? "today" : it.due})`);
    }
    return "";
  };
  const section = (title, items, total) => {
    console.log("");
    console.log(c.bold(`${title} (${total})`));
    for (const it of items) {
      console.log(
        `  • ${c.dim(String(it.kind).padEnd(11))} ${truncate(it.summary, 60)}${annot(it)}   ${c.dim(
          refLabel(it)
        )}`
      );
    }
    if (total > items.length) console.log(c.dim(`  +${total - items.length} more`));
  };

  section("Changed", o.changed, o.counts.changed);
  section("Blocked", o.blocked, o.counts.blocked);
  section("Owed today", o.owedToday, o.counts.owedToday);
  renderRan();
  printExcludedHint();
}

// C8 — the local dogfood dashboard. Owner-only (admin-tier operational data). Tier-leak first
// (the product-ending metric), then a data-quality banner if the ledger has unreadable lines.
function renderTelemetry(m) {
  const badge = (met) =>
    met === true ? c.green("MET") : met === false ? c.red("NOT MET") : c.yellow("N/A ");
  const showVal = (mr) =>
    mr.value === null
      ? "—"
      : mr.unit === "rate"
        ? `${Math.round(mr.value * 100)}%`
        : `${mr.value} ${mr.unit}`;
  const line = (mr) =>
    console.log(
      `  ${badge(mr.met)}  ${mr.label}: ${showVal(mr)} ` +
        c.dim(`(target ${mr.threshold}, n=${mr.sampleSize}${mr.note ? "; " + mr.note : ""})`)
    );

  const w = m.window;
  console.log(
    c.blue("aios loop telemetry") +
      c.dim(
        `  window ${w.days === null ? "all" : w.days + "d"} · ${w.from.slice(0, 10)} → ${w.to.slice(0, 10)}`
      )
  );

  // Tier-leak FIRST — the one that's product-ending.
  const leak = m.tierLeakCount;
  const leakBadge =
    leak.met === true ? c.green("CLEAN") : leak.met === false ? c.red("LEAK ") : c.yellow("?????");
  console.log(
    `  ${leakBadge}  ${leak.label}: ${leak.value === null ? "—" : leak.value} ` +
      c.dim(`(target == 0, n=${leak.sampleSize}${leak.note ? "; " + leak.note : ""})`)
  );

  const dq = m.breakdown.dataQuality;
  const badLines = dq.corruptLines + dq.unknownVersionLines + dq.missingFieldLines;
  if (badLines > 0)
    console.log(
      c.yellow(
        `  ⚠ data quality: ${badLines} unreadable line(s) — ${dq.corruptLines} corrupt, ` +
          `${dq.unknownVersionLines} unknown-version, ${dq.missingFieldLines} missing-fields; ` +
          `${dq.unattributableGaps} unattributable, ${dq.degradedRunIds.length} degraded run(s)`
      )
    );

  line(m.weeklyWallClock);
  line(m.verifierShippableRate);
  line(m.nextWeekActionAcceptance);
  line(m.dailyRunFrequency);
  line(m.consecutiveCleanWeeklies);

  const b = m.breakdown;
  console.log(
    c.dim(
      `  runs: ${b.weeklyRuns} weekly, ${b.dailyRuns} daily · verifier ` +
        `${b.verifier.pass}✓/${b.verifier.corrected}~/${b.verifier.failed}✗ · leak-withheld ${b.leakWithheldTotal}`
    )
  );
  for (const wn of m.warnings)
    if (wn.phase === "semantic")
      console.log(
        c.yellow(
          `  ⚠ ${wn.reason}${wn.runId ? " " + wn.runId : ""}${wn.detail ? ": " + wn.detail : ""}`
        )
      );
}

async function cmdLoop(repo, cfg, args) {
  const sub = args[0];
  const flags = new Set(args.slice(1));
  const loop = await loadOperatorLoop();
  // Identity resolved via the shared helper so CLI + MCP stamp identical member/project.
  const { member, project } = resolveLoopIdentity(repo);

  if (sub === "collect") {
    const cadence = flags.has("--daily") ? "daily" : "weekly";
    const manifest = loop.collect({ root: repo, cadence, member, project });

    // Manifests carry admin-tier signals → write to .aios/loop (outside sync_include; never pushed).
    const dir = path.join(repo, ".aios", "loop", "manifests");
    mkdirSync(dir, { recursive: true });
    const stamp = manifest.generatedAt.replace(/[:.]/g, "-");
    const out = path.join(dir, `${cadence}-${stamp}.json`);
    writeFileSync(out, JSON.stringify(manifest, null, 2));

    if (flags.has("--json")) {
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }
    const byKind = {};
    for (const s of manifest.signals) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    const kinds =
      Object.entries(byKind)
        .map(([k, n]) => `${k}:${n}`)
        .join("  ") || "(none)";
    console.log(
      c.blue(`aios loop ${cadence}`) +
        c.dim(`  window ${manifest.window.from.slice(0, 10)} → ${manifest.window.to.slice(0, 10)}`)
    );
    console.log(`  signals: ${manifest.signals.length}   ${kinds}`);
    if (manifest.excluded.length) {
      console.log(c.yellow(`  excluded (default-deny): ${manifest.excluded.length}`));
      for (const e of manifest.excluded.slice(0, 10))
        console.log(c.dim(`    - ${e.ref} — ${e.reason}`));
    }
    console.log(c.dim(`  manifest → ${path.relative(repo, out)}`));
    return;
  }

  if (sub === "manifest") {
    if (!flags.has("--explain"))
      die("usage: aios loop manifest --explain [--as team|external] [--daily]");
    const cadence = flags.has("--daily") ? "daily" : "weekly";
    const asIdx = args.indexOf("--as");
    const audience = asIdx >= 0 ? args[asIdx + 1] : "owner";
    if (!["owner", "team", "external"].includes(audience)) die(`--as must be owner|team|external`);
    const manifest = loop.collect({ root: repo, cadence, member, project });
    const view = loop.explainManifest(manifest, audience);
    console.log(
      c.blue(`evidence — ${cadence}, audience: ${audience}`) +
        c.dim(`  (${view.lines.length} signals)`)
    );
    // Owner view (default) shows every line in full. When simulating a digest audience
    // (--as team|external), a line the audience may NOT see is redacted to kind + tier only —
    // its ref (path/row) and summary are suppressed so the simulation itself doesn't leak.
    const ownerView = audience === "owner";
    for (const line of view.lines) {
      if (!ownerView && !line.visibleToAudience) {
        console.log(`  [${c.yellow("withheld")}] ${c.bold(line.kind)} (${line.tier})`);
        continue;
      }
      const mark = line.visibleToAudience ? c.green("shown") : c.yellow("withheld");
      const wh = line.withheldFrom.length
        ? c.dim(` · withheld from: ${line.withheldFrom.join(",")}`)
        : "";
      console.log(`  [${mark}] ${c.bold(line.kind)} (${line.tier}) ${line.ref}${wh}`);
      console.log(c.dim(`        ${line.summary}`));
    }
    if (view.excluded.length)
      console.log(c.yellow(`  excluded (default-deny): ${view.excluded.length}`));
    return;
  }

  if (sub === "verify") {
    // Cadence drives the correction budget + status semantics, so reject a conflicting pair
    // rather than silently picking one.
    if (flags.has("--daily") && flags.has("--weekly"))
      die("--daily and --weekly are mutually exclusive");
    const cadence = flags.has("--daily") ? "daily" : "weekly";
    const asIdx = args.indexOf("--as");
    const audience = asIdx >= 0 ? args[asIdx + 1] : "team";
    if (!["owner", "team", "external"].includes(audience)) die("--as must be owner|team|external");
    const asJson = flags.has("--json");

    const manIdx = args.indexOf("--manifest");
    const ledIdx = args.indexOf("--ledger");
    const manifestPath = manIdx >= 0 ? args[manIdx + 1] : null;
    const ledgerPath = ledIdx >= 0 ? args[ledIdx + 1] : null;

    let manifest;
    let ledger;
    if (flags.has("--smoke")) {
      manifest = manifestPath
        ? validateManifestShape(parseJsonFile(manifestPath))
        : loop.collect({ root: repo, cadence, member, project });
      ledger = smokeLedgerFrom(manifest);
      if (!asJson)
        console.log(c.dim("# smoke ledger (debug, not a drafter) — one grounded claim per signal"));
    } else {
      if (!ledgerPath)
        die(
          "usage: aios loop verify --manifest <path> --ledger <path> [--as owner|team|external] [--daily|--weekly] [--json]\n" +
            "       aios loop verify --smoke [--manifest <path>] [--as ...] [--json]"
        );
      // A ledger's refs only resolve against the run it was drafted from — require the pair.
      if (!manifestPath)
        die(
          "--ledger requires a matching --manifest so evidence refs resolve against the right run"
        );
      manifest = validateManifestShape(parseJsonFile(manifestPath));
      ledger = validateLedgerShape(parseJsonFile(ledgerPath));
    }

    const result = await loop.runVerification({ manifest, ledger, audience, cadence });

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const badge =
        result.status === "pass"
          ? c.green("PASS")
          : result.status === "corrected"
            ? c.yellow("CORRECTED")
            : c.red("FAILED");
      console.log(c.blue(`verify — ${cadence}, audience: ${audience}`) + `  ${badge}`);
      console.log(
        c.dim(`  claims: ${result.checkedClaims}   loops: ${result.loopsUsed}/${result.budget}`)
      );
      for (const f of result.findings) {
        console.log(
          c.red(`  ✗ [${f.ruleId} ${f.check}] entry #${f.entryIndex}: ${f.claimPreview}`)
        );
        console.log(c.dim(`      ${f.detail}`));
      }
      for (const a of result.advisory)
        console.log(
          c.yellow(`  · [advisory ${a.ruleId}] entry #${a.entryIndex}: ${a.claimPreview}`)
        );
      if (!result.findings.length) console.log(c.green("  no must-fails"));
    }
    // Fail loud: a failed verification must gate (non-zero) for scripts/CI. Not a usage error,
    // so set the exit code rather than die().
    if (result.status === "failed") process.exitCode = 1;
    return;
  }

  if (sub === "weekly") {
    // ── Audience selection: default brief(owner)+team; --as external; --all = both shareable. ──
    const asIdx = args.indexOf("--as");
    const asArg = asIdx >= 0 ? args[asIdx + 1] : null;
    let shareableAudiences;
    if (flags.has("--all")) shareableAudiences = ["team", "external"];
    else if (asArg) {
      if (!["team", "external"].includes(asArg)) die("weekly --as must be team|external");
      shareableAudiences = [asArg];
    } else shareableAudiences = ["team"];

    // --smoke forces the offline path even alongside --remote (used by tests/demos).
    const remote = flags.has("--remote") && !flags.has("--smoke");
    const asJson = flags.has("--json");
    const dryRun = flags.has("--dry-run");

    // C8 telemetry: wall-clock spans the whole closeout command (CLI-duration fallback for the
    // ritual span, which is completed later by the C6 writeback approval event).
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    const manIdx = args.indexOf("--manifest");
    const manifestPath = manIdx >= 0 ? args[manIdx + 1] : null;
    const manifest = manifestPath
      ? validateManifestShape(parseJsonFile(manifestPath))
      : loop.collect({ root: repo, cadence: "weekly", member, project });

    // Egress consent: the remote drafter runs ONLY under --remote AND with the key present.
    let complete;
    if (remote) {
      if (!loop.hasAnthropicKey()) {
        die(
          "--remote requires ANTHROPIC_API_KEY (the egress-consent key). Run offline (omit --remote) or set the key."
        );
      }
      complete = loop.anthropicCompletion;
      if (!asJson)
        console.log(
          c.dim(
            `# remote drafting ENABLED — sends only the ≤-audience projection (admin never leaves the machine)`
          )
        );
    } else if (!asJson) {
      console.log(
        c.dim(
          "# offline: LLM synthesis skipped — pass --remote to send the ≤-audience projection to Anthropic"
        )
      );
    }

    const closeout = await loop.runCloseout({
      fullManifest: manifest,
      shareableAudiences,
      complete,
    });

    // ── Verifier status BEFORE any approval/write. ──
    if (!asJson) {
      for (const s of closeout.shareables) {
        const badge =
          s.status === "pass"
            ? c.green("PASS")
            : s.status === "corrected"
              ? c.yellow("CORRECTED")
              : c.red("FAILED");
        console.log(
          c.blue(`weekly digest — ${s.audience}`) +
            `  ${badge}` +
            (s.shippable ? "" : c.red(" · NOT SHIPPABLE"))
        );
        console.log(
          c.dim(
            `  claims: ${s.result.checkedClaims}  loops: ${s.result.loopsUsed}/${s.result.budget}  leak-withheld: ${s.leakWithheld}`
          )
        );
        for (const f of s.result.findings)
          console.log(c.red(`  ✗ [${f.ruleId} ${f.check}] #${f.entryIndex}: ${f.claimPreview}`));
      }
    }

    // ── Write artifacts under .aios/loop/closeouts/<stamp>/ (outside sync_include; C6 owns
    //    approval→writeback into the spine). admin-tier brief never enters the synced spine. ──
    const stamp = manifest.generatedAt.replace(/[:.]/g, "-");
    const outDir = path.join(repo, ".aios", "loop", "closeouts", stamp);
    if (!dryRun) mkdirSync(outDir, { recursive: true });

    let briefPath = null;
    if (!dryRun) {
      briefPath = path.join(outDir, "brief.md"); // owner-only
      writeFileSync(briefPath, closeout.briefMarkdown);
      writeFileSync(
        path.join(outDir, "next-week-actions.json"),
        JSON.stringify(closeout.ownerNextWeekActions, null, 2)
      );
      // Persist the exact manifest this closeout was verified against. C6's writeback uses it as the
      // drift-free source for its independent leak re-sweep. Lives under .aios/loop (outside
      // sync_include), so it is never pushed.
      writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    }

    let anyFailed = false;
    const audienceBlocks = [];
    for (const s of closeout.shareables) {
      if (!s.shippable) anyFailed = true;
      let digestPath = null;
      let unshippablePath = null;
      if (!dryRun) {
        if (s.shippable) {
          digestPath = path.join(outDir, `digest-${s.audience}.md`);
          writeFileSync(digestPath, s.digestMarkdown);
        } else {
          // Clearly-marked, inspection-only — NEVER referenced as an approved artifact.
          unshippablePath = path.join(outDir, `digest-${s.audience}.FAILED.md`);
          writeFileSync(unshippablePath, s.digestMarkdown);
        }
        writeFileSync(
          path.join(outDir, `verifier-${s.audience}.json`),
          JSON.stringify(s.result, null, 2)
        );
      }
      audienceBlocks.push({
        audience: s.audience,
        status: s.status,
        shippable: s.shippable,
        digestPath: digestPath ? path.relative(repo, digestPath) : null,
        unshippablePath: unshippablePath ? path.relative(repo, unshippablePath) : null,
        verifier: s.result, // audience-safe by the C3 contract
        nextWeekActions: s.nextWeekActions, // already tier <= this audience
      });
    }

    if (asJson) {
      // Audience-safe payload: brief by PATH only (never its content); no raw ledger; no admin
      // actions; per-audience action filtering already applied by each pipeline.
      console.log(
        JSON.stringify(
          {
            runStamp: stamp,
            cadence: "weekly",
            briefPath: briefPath ? path.relative(repo, briefPath) : null,
            audiences: audienceBlocks,
          },
          null,
          2
        )
      );
    } else {
      if (briefPath) console.log(c.dim(`  brief (owner-only) → ${path.relative(repo, briefPath)}`));
      for (const b of audienceBlocks) {
        const p = b.digestPath || b.unshippablePath;
        if (p) console.log(c.dim(`  digest (${b.audience}) → ${p}`));
      }
      if (dryRun) console.log(c.dim("  (--dry-run: no files written)"));
    }
    // A non-shippable audience must gate (non-zero) for scripts/CI.
    if (anyFailed) process.exitCode = 1;

    // ── C8 telemetry + independent post-ship leak re-check (safety runs even if telemetry is off) ──
    if (!dryRun) {
      const telem = loop.telemetryEnabled();
      const endedAt = new Date().toISOString();
      const durationMs = Date.now() - startedMs;
      if (telem) {
        loop.recordEvent(repo, {
          kind: "weekly.run",
          runId: stamp,
          cadence: "weekly",
          member,
          project,
          at: endedAt,
          payload: { startedAt, endedAt, durationMs, audiences: shareableAudiences, anyFailed },
        });
        for (const s of closeout.shareables)
          loop.recordEvent(repo, {
            kind: "weekly.verify",
            runId: stamp,
            cadence: "weekly",
            member,
            project,
            at: endedAt,
            payload: {
              audience: s.audience,
              status: s.status,
              shippable: s.shippable,
              leakWithheld: s.leakWithheld,
              checkedClaims: s.result.checkedClaims,
              loopsUsed: s.result.loopsUsed,
              budget: s.result.budget,
            },
          });
      }
      // Re-derive leak truth from the bytes actually written — defense in depth over C5's sweep.
      // If a shipped digest still carries admin content, quarantine it (rename → .LEAKED.md, which
      // C6 can never promote), alarm, and fail. The one case C8 mutates a pipeline artifact.
      for (const s of closeout.shareables) {
        if (!s.shippable) continue;
        // Re-scan the bytes ACTUALLY WRITTEN to disk (not the in-memory string) — that is the
        // artifact C6 would promote/quarantine, so the defense-in-depth check must verify it.
        const shippedDigestPath = path.join(outDir, `digest-${s.audience}.md`);
        const tierLeak = loop.hasLeak(
          readFileSync(shippedDigestPath, "utf8"),
          loop.aboveAudienceStrings(manifest, s.audience)
        );
        if (telem)
          loop.recordEvent(repo, {
            kind: "weekly.shipped",
            runId: stamp,
            cadence: "weekly",
            member,
            project,
            at: endedAt,
            payload: { audience: s.audience, tierLeak },
          });
        if (tierLeak) {
          try {
            renameSync(shippedDigestPath, path.join(outDir, `digest-${s.audience}.LEAKED.md`));
          } catch {
            // best-effort quarantine; the alarm + non-zero exit still fire
          }
          console.error(
            c.red(
              `  ✗ TIER LEAK in shipped ${s.audience} digest — quarantined to digest-${s.audience}.LEAKED.md ` +
                `(unpromotable by writeback). This is a C5-sweep escape; investigate before shipping.`
            )
          );
          process.exitCode = 2;
        }
      }
    }
    return;
  }

  if (sub === "writeback") {
    // C6 — approval-gated writeback of a saved C5 closeout. Default-deny: no target flag = preview.
    // Each of --local / --sync / --pm opts into one target and they may be combined. C6 stages local
    // files only and NEVER performs network egress — the actual send stays the user's `aios push`.
    const stamp = args[1];
    if (!stamp || stamp.startsWith("--"))
      die(
        "usage: aios loop writeback <stamp> [--local] [--sync] [--pm] [--manifest <path>] [--json] [--dry-run]"
      );
    const wbFlags = new Set(args.slice(2));
    const approved = new Set(["local", "sync", "pm"].filter((t) => wbFlags.has(`--${t}`)));
    const asJson = wbFlags.has("--json");
    const dryRun = wbFlags.has("--dry-run");
    const manIdx = args.indexOf("--manifest");
    const manifestPathArg = manIdx >= 0 ? args[manIdx + 1] : null;

    // ── Read the closeout dir (must exist). ──
    const dir = path.join(repo, ".aios", "loop", "closeouts", stamp);
    if (!existsSync(dir))
      die(`no closeout at ${path.relative(repo, dir)} — run 'aios loop weekly' first`);
    const briefFile = path.join(dir, "brief.md");
    if (!existsSync(briefFile)) die(`closeout ${stamp} has no brief.md`);
    const briefMarkdown = readFileSync(briefFile, "utf8");

    let ownerNextWeekActions = [];
    const nwaFile = path.join(dir, "next-week-actions.json");
    if (existsSync(nwaFile)) {
      try {
        ownerNextWeekActions = JSON.parse(readFileSync(nwaFile, "utf8"));
      } catch {
        die(`closeout ${stamp}: next-week-actions.json is not valid JSON`);
      }
      if (!Array.isArray(ownerNextWeekActions))
        die(`closeout ${stamp}: next-week-actions.json is not an array`);
    }

    const shareables = [];
    for (const audience of ["team", "external"]) {
      const okPath = path.join(dir, `digest-${audience}.md`);
      const failedPath = path.join(dir, `digest-${audience}.FAILED.md`);
      const vFile = path.join(dir, `verifier-${audience}.json`);
      const shippable = existsSync(okPath);
      const hasFailedMarker = existsSync(failedPath);
      const hasVerifier = existsSync(vFile);
      // Skip only an audience that was never processed at all. If a verifier result exists but no
      // digest body (C5 withheld everything), we still surface it so the planner emits `missing-digest`
      // rather than silently dropping it.
      if (!shippable && !hasFailedMarker && !hasVerifier) continue;
      let verifierStatus = null;
      if (hasVerifier) {
        try {
          verifierStatus = JSON.parse(readFileSync(vFile, "utf8")).status ?? null;
        } catch {
          verifierStatus = null; // unparsable → planner treats as verifier-unavailable
        }
      }
      shareables.push({
        audience,
        shippable,
        hasFailedMarker,
        // A coexisting stale digest-<aud>.md must NOT be promoted alongside a FAILED marker — the
        // planner treats hasFailedMarker as authoritative, so don't even read the stale body.
        digestMarkdown: shippable && !hasFailedMarker ? readFileSync(okPath, "utf8") : null,
        verifierStatus,
      });
    }

    // ── Resolve spine folders + tasks.md + its (validated) tier. ──
    const spine = loop.resolveSpine(repo);
    const firstExisting = (names) => {
      for (const n of names) if (existsSync(path.join(repo, n))) return path.join(repo, n);
      return null;
    };
    const spinePaths = {
      work: spine.work ? path.join(repo, spine.work) : null,
      log: spine.log ? path.join(repo, spine.log) : null,
      shared: firstExisting(["4-shared", "04-client-surface"]),
    };
    if (!spinePaths.log)
      die(
        "no log spine folder (3-log/) — cannot place the owner brief; is this an AIOS workspace?"
      );
    const tasksPath = path.join(spinePaths.log, "tasks.md");
    const tasksExists = existsSync(tasksPath);
    let tasksFileTier = "team";
    if (tasksExists) {
      const { frontmatter } = parseFrontmatter(readFileSync(tasksPath, "utf8"));
      tasksFileTier = loop.resolveTierOrDefault(frontmatter?.access);
    }

    // ── Source the leak-backstop manifest: FAIL-CLOSED, no re-collect. ──
    // The corpus MUST be the exact manifest of this closeout. Both sources are shape-validated AND
    // stamp-matched: a malformed manifest yields an empty/wrong leak corpus (under-detection), and a
    // wrong-timestamp manifest carries the wrong vocabulary — both are refused.
    const stampOf = (m) => String(m?.generatedAt ?? "").replace(/[:.]/g, "-");
    let manifest = null;
    if (manifestPathArg) {
      // Explicit user input → fail LOUD (die) on missing/invalid/mismatched.
      if (!existsSync(manifestPathArg)) die(`--manifest not found: ${manifestPathArg}`);
      let m;
      try {
        m = JSON.parse(readFileSync(manifestPathArg, "utf8"));
      } catch {
        die(`--manifest is not valid JSON: ${manifestPathArg}`);
      }
      validateManifestShape(m); // dies on a malformed manifest (empty corpus / not a manifest)
      if (stampOf(m) !== stamp)
        die(
          `--manifest generatedAt (${m?.generatedAt}) does not map to closeout <stamp> ${stamp} — refusing (fail-closed)`
        );
      manifest = m;
    } else {
      // Persisted sidecar → fail SOFT (null → syncable withheld) on any corruption or stamp drift.
      const sidecar = path.join(dir, "manifest.json");
      if (existsSync(sidecar)) {
        try {
          const m = JSON.parse(readFileSync(sidecar, "utf8"));
          const ok =
            m &&
            typeof m === "object" &&
            !Array.isArray(m) &&
            Array.isArray(m.signals) &&
            m.window &&
            typeof m.window === "object";
          manifest = ok && stampOf(m) === stamp ? m : null;
        } catch {
          manifest = null; // corrupt sidecar → fail-closed on syncable writes
        }
      }
    }

    // ── Plan (pure, deterministic). ──
    const plan = loop.planWriteback({
      stamp,
      member,
      repoRel: (p) => path.relative(repo, p),
      briefMarkdown,
      ownerNextWeekActions,
      shareables,
      spinePaths,
      tasksPath: tasksExists ? tasksPath : null,
      tasksFileTier,
      manifest,
    });

    // Tier-safety exit signal, scoped to the approved targets only.
    const artifactTargets = { brief: ["local"], digest: ["local", "sync"], tasks: ["sync", "pm"] };
    const relevantTierSafety = plan.skips.some(
      (s) =>
        (s.code === "no-manifest" || s.code === "leak-detected") &&
        artifactTargets[s.artifact].some((t) => approved.has(t))
    );

    // ── Print the plan (repo-relative paths only; brief by path only, never its content). ──
    if (!asJson) {
      console.log(
        c.blue(`writeback — ${stamp}`) +
          (approved.size
            ? c.dim(`  targets: ${[...approved].join(",")}`)
            : c.dim("  (preview — no target flag)"))
      );
      for (const s of shareables) {
        const badge =
          s.verifierStatus === "pass"
            ? c.green("PASS")
            : s.verifierStatus === "corrected"
              ? c.yellow("CORRECTED")
              : c.red(s.verifierStatus ?? "no-verifier");
        console.log(
          c.dim(`  digest ${s.audience}: `) + badge + (s.shippable ? "" : c.red(" · not shippable"))
        );
      }
      for (const f of plan.fileWrites)
        console.log(
          `  ${c.green("write")} ${f.artifact} (${f.tier}) → ${f.destRel}` +
            (f.syncable ? c.dim(" [staged for aios push]") : c.dim(" [never syncs]"))
        );
      if (plan.taskWrite)
        console.log(
          `  ${c.green("write")} tasks (${plan.taskWrite.rows.length} tier-safe row(s)) → ${plan.taskWrite.tasksRel}` +
            c.dim(" [staged for aios push]")
        );
      for (const s of plan.skips)
        console.log(
          `  ${c.yellow("skip")} ${s.artifact}${s.audience ? ` ${s.audience}` : ""} [${s.code}]` +
            (s.count ? ` ×${s.count}` : "")
        );
    }

    // ── Default-deny: no target flag ⇒ preview only, write nothing. ──
    if (approved.size === 0) {
      if (asJson) console.log(jsonWriteback(plan, [...approved], manifest, loop));
      else console.log(c.dim("  preview only — pass --local / --sync / --pm to write."));
      return;
    }

    // ── Execute approved targets (idempotent; overlaps are safe). ──
    let wroteCount = 0;
    if (!dryRun) {
      for (const f of plan.fileWrites) {
        if (!f.targets.some((t) => approved.has(t))) continue;
        mkdirSync(path.dirname(f.destPath), { recursive: true });
        writeFileSync(f.destPath, f.content);
        wroteCount++;
      }
      if (plan.taskWrite && plan.taskWrite.targets.some((t) => approved.has(t))) {
        const cur = readFileSync(plan.taskWrite.tasksPath, "utf8");
        writeFileSync(plan.taskWrite.tasksPath, mergeTaskWriteback(cur, plan.taskWrite.rows));
        wroteCount++;
      }
    } else {
      wroteCount =
        plan.fileWrites.filter((f) => f.targets.some((t) => approved.has(t))).length +
        (plan.taskWrite && plan.taskWrite.targets.some((t) => approved.has(t)) ? 1 : 0);
    }

    if (asJson) {
      console.log(jsonWriteback(plan, [...approved], manifest, loop));
    } else {
      if (dryRun) console.log(c.dim("  (--dry-run: no files written)"));
      // Only nudge toward `aios push` when something syncable was actually staged.
      if (wroteCount > 0 && approved.has("sync"))
        console.log(
          c.yellow("  staged for the team brain — run `aios push` to sync (C6 sends nothing).")
        );
      if (wroteCount > 0 && approved.has("pm"))
        console.log(
          c.yellow(
            "  staged next-week task rows — run `aios push`; the brain projects them to Linear (AIO-72)."
          )
        );
    }

    // ── Exit codes: tier-safety withholding (fail-closed) → 2; nothing promotable → 1. ──
    if (relevantTierSafety) {
      if (!asJson)
        console.error(c.red("  tier-safety: syncable content withheld (see skips) — exit 2"));
      process.exitCode = 2;
    } else if (wroteCount === 0) {
      if (!asJson)
        console.error(c.yellow("  nothing promotable for the approved target(s) — exit 1"));
      process.exitCode = 1;
    }

    // ── C8 telemetry: a non-preview writeback is the approval event — it ends the wall-clock ritual
    //    and, if it wrote task rows (only under --sync/--pm), records accepted next-week actions.
    //    Preview (no target) already returned; --dry-run records nothing. ──
    if (!dryRun && approved.size > 0 && loop.telemetryEnabled()) {
      const taskRowsWritten =
        plan.taskWrite && plan.taskWrite.targets.some((t) => approved.has(t))
          ? plan.taskWrite.rows.map((r) => r.row_key)
          : [];
      loop.recordEvent(repo, {
        kind: "weekly.approve",
        runId: stamp,
        cadence: "weekly",
        member,
        project,
        payload: {
          targets: [...approved],
          wroteCount,
          taskRowsWritten,
          tierSafetyWithheld: relevantTierSafety,
          exitCode: process.exitCode ?? 0,
          nextWeekActionsProposed: ownerNextWeekActions.length,
        },
      });
    }
    return;
  }

  if (sub === "daily") {
    // Read-only daily orientation: changed / blocked / owed today. No verifier, no LLM, no sync,
    // no approval gate. The ONLY write is the local change-snapshot under .aios/loop/state/ and
    // ONLY on an owner run; --as / --manifest / --no-record are fully side-effect-free.
    const asIdx = args.indexOf("--as");
    const asArg = asIdx >= 0 ? args[asIdx + 1] : null;
    let audience = "owner";
    if (asArg) {
      if (!["team", "external"].includes(asArg)) die("daily --as must be team|external");
      audience = asArg;
    }
    const asJson = flags.has("--json");
    const manIdx = args.indexOf("--manifest");
    const hasManifest = manIdx >= 0;
    const manifestPath = hasManifest ? args[manIdx + 1] : null;
    if (hasManifest && (!manifestPath || manifestPath.startsWith("--")))
      die("daily --manifest requires a path");

    let orientation;
    if (hasManifest) {
      // Inspection path (deterministic; also how the CLI tests drive it). The saved manifest is
      // the current state; the prior baseline is read from the workspace (absent in a temp fixture
      // → first-run bootstrap). This path never records a snapshot.
      const manifest = validateManifestShape(parseJsonFile(manifestPath));
      if (manifest.window?.cadence !== "daily") die("daily --manifest requires a daily manifest");
      if (manifest.windowed !== false)
        die("daily --manifest requires an unwindowed full-state manifest (windowed:false)");
      const prior = loop.readSnapshot(repo, loop.DAILY_SCOPE);
      orientation = loop.buildDailyOrientation({ manifest, prior, audience }).orientation;
    } else {
      const dStart = Date.now();
      orientation = loop.runDaily({
        root: repo,
        member,
        audience,
        record: !flags.has("--no-record"),
      });
      // C8 telemetry: the daily-run habit signal. Only a real recording OWNER run counts — an `--as`
      // projection or `--no-record` run is side-effect-free by C4's contract, so it records nothing
      // (and the `--manifest` inspection path never reaches this branch).
      if (audience === "owner" && !flags.has("--no-record") && loop.telemetryEnabled()) {
        loop.recordEvent(repo, {
          kind: "daily.run",
          runId: orientation.generatedAt.replace(/[:.]/g, "-"),
          cadence: "daily",
          member,
          project,
          at: orientation.generatedAt,
          payload: {
            durationMs: Date.now() - dStart,
            signalCount:
              orientation.counts.changed +
              orientation.counts.blocked +
              orientation.counts.owedToday,
          },
        });
      }
    }

    if (asJson) {
      console.log(JSON.stringify(orientation, null, 2));
      return;
    }
    renderDaily(orientation);
    return;
  }

  if (sub === "telemetry") {
    // Local dogfood dashboard for the six V1 exit criteria. Owner-only: reads admin-tier
    // operational data from .aios/loop/telemetry/ and has NO audience-safe projection.
    const asJson = flags.has("--json");
    const all = flags.has("--all");
    const winIdx = args.indexOf("--window");
    let windowDays = 14;
    if (winIdx >= 0) {
      if (all) die("choose one of --window / --all, not both");
      const raw = args[winIdx + 1];
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n < 1) die("--window must be a positive integer (days)");
      windowDays = n;
    }
    const metrics = loop.computeMetrics(loop.readEvents(repo), {
      windowDays: all ? null : windowDays,
      dailySourceWired: true, // this CLI wires `aios loop daily` → daily.run
    });
    if (asJson) console.log(JSON.stringify(metrics, null, 2));
    else renderTelemetry(metrics);
    // A real shipped tier-leak on record is a CI-catchable alarm.
    if ((metrics.tierLeakCount.value ?? 0) > 0) process.exitCode = 2;
    return;
  }

  die(
    "usage: aios loop collect [--daily|--weekly] [--json]\n" +
      "       aios loop daily [--as team|external] [--manifest <path>] [--no-record] [--json]\n" +
      "       aios loop manifest --explain [--as team|external] [--daily]\n" +
      "       aios loop verify --manifest <path> --ledger <path> [--as owner|team|external] [--json]\n" +
      "       aios loop verify --smoke [--manifest <path>] [--as ...] [--json]\n" +
      "       aios loop weekly [--as team|external] [--all] [--remote] [--manifest <path>] [--json] [--dry-run]\n" +
      "       aios loop writeback <stamp> [--local] [--sync] [--pm] [--manifest <path>] [--json] [--dry-run]\n" +
      "       aios loop telemetry [--window <days>] [--all] [--json]"
  );
}

// ── aios time (AIO-139): native agent-session runtime capture ────────────────
// Offline + local-first. Reads ~/.claude session logs, scopes strictly by realpath allowlist
// (unknown repos never up-scoped), and writes an admin-tier `<spine.log>/time-log.md` that never
// syncs. `report` is read-only; `reconcile` targets rows by opaque id.
async function cmdTime(repo, cfg, args) {
  const sub = args[0];
  const flags = new Set(args.slice(1));
  const loop = await loadOperatorLoop();
  const argVal = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };

  if (sub === "capture") {
    const configPath = argVal("--config");
    const reposArg = argVal("--repos");
    const extraTeamRepos = reposArg
      ? reposArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const dryRun = flags.has("--dry-run");
    const projectsDir = argVal("--projects-dir"); // testing/override hook for ~/.claude/projects
    const nowArg = argVal("--now"); // testing/override hook for "now"
    const summary = loop.capture({
      root: repo,
      configPath,
      extraTeamRepos,
      dryRun,
      ...(projectsDir ? { projectsDir } : {}),
      ...(nowArg ? { now: new Date(nowArg) } : {}),
    });
    if (flags.has("--json")) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(c.blue("aios time capture") + c.dim(dryRun ? "  (dry-run — no write)" : ""));
    console.log(
      `  blocks: ${summary.totalBlocks}   captured: ${summary.captured}   excluded (unlisted): ${summary.excludedUnlisted}`
    );
    console.log(
      `  rows ${dryRun ? "would change" : "changed"}: ${summary.written}   store → ${summary.rel}`
    );
    if (summary.excludedUnlisted > 0)
      console.log(c.dim("  tip: allowlist repos in .aios/time-config.json to capture them"));
    return;
  }

  if (sub === "report") {
    const window = argVal("--window") === "daily" ? "daily" : "weekly";
    const days = window === "daily" ? 1 : 7;
    const asJson = flags.has("--json");
    const read = loop.readStore(repo);
    const nowArg = argVal("--now"); // testing/override hook
    const now = nowArg ? new Date(nowArg).getTime() : Date.now();
    const fromMs = now - days * 86_400_000;
    const inWin = read.rows.filter((r) => {
      const t = Date.parse(r.startIso);
      return Number.isFinite(t) && t >= fromMs && t <= now;
    });
    const totals = loop.runtimeByTag(inWin.map((r) => ({ tag: r.tag, durationMin: r.runtimeMin })));
    const totalMin = totals.reduce((a, t) => a + t.durationMin, 0);
    if (asJson) {
      console.log(JSON.stringify({ window, byTag: totals, totalMin, rows: inWin }, null, 2));
      return;
    }
    console.log(
      c.blue("aios time report") + c.dim(`  ${window} · ${loop.formatHours(totalMin)} total`)
    );
    for (const t of totals) console.log(`  ${t.tag.padEnd(14)} ${loop.formatHours(t.durationMin)}`);
    if (!totals.length)
      console.log(c.dim("  no runtime in window — run `aios time capture` first"));
    return;
  }

  if (sub === "reconcile") {
    const idArg = argVal("--id");
    const ids = idArg
      ? idArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (!ids.length) die("aios time reconcile requires --id <id,...>");
    const result = loop.reconcile({
      root: repo,
      ids,
      setTag: argVal("--set-tag") ?? undefined,
      setTier: argVal("--set-tier") ?? undefined,
      confirm: flags.has("--confirm"),
      dryRun: flags.has("--dry-run"),
    });
    if (flags.has("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      c.blue("aios time reconcile") + c.dim(flags.has("--dry-run") ? "  (dry-run — no write)" : "")
    );
    console.log(`  updated: ${result.updated.join(", ") || "(none)"}`);
    return;
  }

  die(
    "usage: aios time capture [--config <path>] [--repos <realpath,...>] [--dry-run] [--json]\n" +
      "       aios time report [--window daily|weekly] [--json]\n" +
      "       aios time reconcile --id <id,...> [--set-tag <tag>] [--set-tier <tier>] [--confirm] [--dry-run] [--json]"
  );
}

// ── aios asks (AIO-167): non-blocking escalation queue ───────────────────────
// Offline + local-first. An append-only NDJSON store folded to state (`.aios/loop/asks/`,
// admin-tier, never synced). Mirrors cmdTime: dist import, `--repo` respected, friendly die if
// the loop isn't built. Subcommands: list / show / resolve / drain / add / harvest.
async function cmdAsks(repo, cfg, args) {
  const sub = args[0];
  const rest = args.slice(1);
  const flags = new Set(rest);
  const asJson = flags.has("--json");
  const argVal = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const loop = await loadOperatorLoop();
  const warnNote = (warnings) => {
    if (warnings?.length && !asJson)
      console.error(c.dim(`  (${warnings.length} malformed line(s) skipped)`));
  };
  const resolveId = (asks, given) => {
    const exact = asks.find((a) => a.id === given);
    if (exact) return exact;
    const prefixed = asks.filter((a) => a.id.startsWith(given));
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1) die(`ambiguous id prefix: ${given}`);
    return null;
  };

  if (sub === "list") {
    const status = argVal("--status") ?? "open";
    const valid = ["open", "resolved", "orphaned", "all"];
    if (!valid.includes(status)) die(`--status must be one of ${valid.join("|")}`);
    const { asks, warnings } = loop.readAsks(repo);
    const filtered = (status === "all" ? asks : asks.filter((a) => a.status === status)).sort(
      (a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")
    );
    if (asJson) {
      console.log(JSON.stringify({ asks: filtered, warnings }, null, 2));
      return;
    }
    console.log(c.blue("aios asks") + c.dim(`  ${status} · ${filtered.length}`));
    for (const a of filtered)
      console.log(
        `  ${a.id.slice(0, 8)}  [${a.severity}] ${a.kind.padEnd(16)} ${a.title}` +
          (a.ref ? c.dim(`  ↳ ${a.ref}`) : "")
      );
    if (!filtered.length) console.log(c.dim("  (none)"));
    warnNote(warnings);
    return;
  }

  if (sub === "show") {
    const given = rest.find((a) => !a.startsWith("--"));
    if (!given) die("usage: aios asks show <id> [--json]");
    const { asks } = loop.readAsks(repo);
    const ask = resolveId(asks, given);
    if (!ask) die(`ask not found: ${given}`);
    if (asJson) {
      console.log(JSON.stringify(ask, null, 2));
      return;
    }
    console.log(c.blue(`aios asks show`) + c.dim(`  ${ask.id}`));
    console.log(`  status:    ${ask.status}`);
    console.log(`  severity:  ${ask.severity}`);
    console.log(`  kind:      ${ask.kind}`);
    console.log(`  title:     ${ask.title}`);
    if (ask.body) console.log(`  body:      ${ask.body}`);
    if (ask.ref) console.log(`  ref:       ${ask.ref}`);
    console.log(`  source:    ${ask.source}`);
    console.log(`  created:   ${ask.createdAt}`);
    if (ask.resolvedAt) console.log(`  closed:    ${ask.resolvedAt}`);
    return;
  }

  if (sub === "resolve") {
    const given = rest.filter((a) => !a.startsWith("--"));
    if (!given.length) die("usage: aios asks resolve <id...> [--json]");
    const { asks } = loop.readAsks(repo);
    // Validate ALL ids before any write — an unknown id dies before touching the store.
    const ids = given.map((g) => {
      const match = resolveId(asks, g);
      if (!match) die(`ask not found: ${g}`);
      return match.id;
    });
    const now = new Date().toISOString();
    for (const id of ids) loop.appendOp(repo, "resolve", id, now);
    if (asJson) {
      console.log(JSON.stringify({ resolved: ids }));
      return;
    }
    console.log(c.blue("aios asks resolve") + c.dim(`  ${ids.length} resolved`));
    return;
  }

  if (sub === "drain") {
    const keepOpen = flags.has("--keep-open");
    const nowArg = argVal("--now");
    const now = nowArg ? new Date(nowArg) : new Date();
    if (nowArg && Number.isNaN(now.getTime())) die(`--now is not a valid date: ${nowArg}`);
    const nowIso = now.toISOString();
    // (1) orphan-detect BEFORE resolve so orphaning is effective.
    const orphanIds = loop.detectOrphans(
      loop.readAsks(repo).asks.filter((a) => a.status === "open"),
      now
    );
    for (const id of orphanIds) loop.appendOp(repo, "orphan", id, nowIso);
    // (2) remaining open.
    const remaining = loop.readAsks(repo).asks.filter((a) => a.status === "open");
    // (3) auto-resolve (unless --keep-open).
    let drained = 0;
    if (!keepOpen)
      for (const a of remaining) {
        loop.appendOp(repo, "resolve", a.id, nowIso);
        drained++;
      }
    // (4) GC under the lock.
    const gc = loop.compact(repo, now);
    const summary = {
      drained,
      orphaned: orphanIds.length,
      gcRemoved: gc.removed,
      gcSkipped: Boolean(gc.skipped),
      remainingOpen: keepOpen ? remaining.length : 0,
    };
    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(c.blue("aios asks drain") + c.dim(keepOpen ? "  (--keep-open)" : ""));
    if (remaining.length) {
      console.log(c.dim(`  ${keepOpen ? "open" : "resolving"} (${remaining.length}):`));
      for (const a of remaining) console.log(`    ${a.id.slice(0, 8)}  [${a.severity}] ${a.title}`);
    }
    console.log(
      `  drained: ${drained}   orphaned: ${orphanIds.length}   gc-removed: ${gc.removed}` +
        (gc.skipped ? c.dim("   (gc skipped: lock contention — rerun drain)") : "")
    );
    return;
  }

  if (sub === "add") {
    const kind = argVal("--kind");
    const severity = argVal("--severity");
    const title = argVal("--title");
    if (!kind || !severity || !title)
      die(
        "usage: aios asks add --kind <k> --severity <blocker|decision|fyi> --title <t> [--body <b>] [--ref <r>] [--json]"
      );
    if (!["blocker", "decision", "fyi"].includes(severity))
      die("--severity must be one of blocker|decision|fyi");
    const openCount = loop.readAsks(repo).asks.filter((a) => a.status === "open").length;
    if (openCount >= loop.OPEN_SOFT_CAP && !asJson)
      console.error(
        c.dim(
          `  warning: ${openCount} open asks (soft cap ${loop.OPEN_SOFT_CAP}) — run \`aios asks drain\``
        )
      );
    const rec = loop.appendCreate(repo, {
      kind,
      severity,
      title,
      body: argVal("--body") ?? "",
      ref: argVal("--ref") ?? null,
      source: "cli",
    });
    if (asJson) {
      console.log(JSON.stringify({ id: rec.id }));
      return;
    }
    console.log(c.blue("aios asks add") + c.dim(`  ${rec.id}`));
    return;
  }

  if (sub === "harvest") {
    const cadence = argVal("--cadence") ?? "daily";
    if (!["daily", "weekly"].includes(cadence)) die("--cadence must be daily|weekly");
    const nowArg = argVal("--now");
    const now = nowArg ? new Date(nowArg) : null;
    if (now && Number.isNaN(now.getTime())) die(`--now is not a valid date: ${nowArg}`);
    const res = await loop.harvestAsks(repo, {
      cadence,
      ...(now ? { now } : {}),
    });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(c.blue("aios asks harvest") + c.dim(`  ${cadence}`));
    console.log(
      `  events: ${res.events}   delivered: ${res.delivered}   rejected: ${res.rejected}   noop: ${res.noop}   suppressed: ${res.suppressed}`
    );
    return;
  }

  die(
    "usage: aios asks list [--status open|resolved|orphaned|all] [--json]\n" +
      "       aios asks show <id> [--json]\n" +
      "       aios asks resolve <id...> [--json]\n" +
      "       aios asks drain [--keep-open] [--json]\n" +
      "       aios asks add --kind <k> --severity <blocker|decision|fyi> --title <t> [--body <b>] [--ref <r>] [--json]\n" +
      "       aios asks harvest [--cadence daily|weekly] [--json]"
  );
}

// ── main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

// `pr` owns its own `--repo` flag — a GitHub owner/repo slug, NOT the workspace path.
// Don't consume it here, or `cmdPr` never sees the target-repo override (its git ops
// run in the current worktree, resolved by the normal cwd walk-up below).
const repoFlagIdx = cmd === "pr" ? -1 : rest.indexOf("--repo");
let repoArg = null;
if (repoFlagIdx !== -1) {
  repoArg = rest[repoFlagIdx + 1];
  rest.splice(repoFlagIdx, 2);
}

const USAGE = `aios — AIOS Team Brain sync client (contract: docs/brain-api.md)

usage:
  aios status [--json|--porcelain]      what would sync (new/modified/blocked/clean)
  aios onboard                          guided first-run setup (Firecrawl, brain, tools)
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
  aios mcp                              run the Team Brain MCP server over stdio, for
                                        GUI-only agents (Claude Desktop/Cowork/Codex/Conductor)
                                        that can't shell out; env-first, no workspace needed
  aios analyze [--since 7d|billing] [--tool x]   agentic-maturity + cost from local session logs
    [--report] [--json] [--push]        --push also sends Cursor dashboard billing (W2.1)
    [--full]                            tools: claude|codex|cursor; billing = Cursor cycle
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
  aios export-okf [output-dir]          emit OKF bundle (no brain needed)
    [--tier external|team]              default: external (includes team + external)
  aios pull-bundle [--include-body]     pull OKF link graph from Team Brain → .aios/bundle.json
  aios graph [--from <file>]            traverse local OKF link graph (no brain needed)
    [--depth N] [--format text|json]
  aios skills export --runtime <name>   export skills to another agent runtime (BYOA)
    [--skill <name>] [--out <dir>]      runtimes: claude-code|hermes|openclaw|codex|opencode|claude-api
    [--install]                         for hermes: also run hermes skills install on each
  aios assess-codebase [path]           score a repo's AEM agent-readiness (offline, read-only)
    [--json]                            machine output; the Team Brain scanner records scores
  aios learn                            prescribe your next AEM patterns from MATURITY.md (offline)
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
  aios pr [--branch b] [--issue AIO-n]  push the branch + open a GitHub PR (idempotent; prints PR_NUMBER)
    [--title t] [--body-file p]         title default '<issue>: <branch>'; --repo/--dry-run supported
  aios review-bugbot [branch] [opts]     local Cursor Bugbot on worktree branch diff (offline)
    [--base ref] [--worktree path]      requires an existing build worktree for the branch
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
  "pr",
  "review-bugbot",
  "loop",
  "time",
  "asks",
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
  else if (cmd === "query") await cmdQuery(repo, cfg, rest);
  else if (cmd === "export-okf") await cmdExportOkf(repo, cfg, rest);
  else if (cmd === "pull-bundle") await cmdPullBundle(repo, cfg, rest);
  else if (cmd === "graph") cmdGraph(repo, cfg, rest);
  else if (cmd === "skills") cmdSkills(repo, rest);
  else if (cmd === "assess-codebase") await cmdAssessCodebase(repo, cfg, patterns, rest);
  else if (cmd === "learn") cmdLearn(repo, cfg, patterns, rest);
  else if (cmd === "analyze") await cmdAnalyze(repo, cfg, rest, { api, resolveMember, loadDotEnv });
  else if (cmd === "relay") await cmdRelay(repo, rest);
  else if (cmd === "build") await cmdBuild(repo, rest);
  else if (cmd === "pr") await cmdPr(repo, rest);
  else if (cmd === "review-bugbot") await cmdReviewBugbot(repo, rest);
  else if (cmd === "loop") await cmdLoop(repo, cfg, rest);
  else if (cmd === "time") await cmdTime(repo, cfg, rest);
  else if (cmd === "asks") await cmdAsks(repo, cfg, rest);
  else {
    console.log(USAGE);
    process.exit(1);
  }
} catch (e) {
  die(e.message);
}
