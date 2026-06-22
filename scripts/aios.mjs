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
  ensureGitignore,
} from "./connector.mjs";
import { parseFlatYaml, stripQuotes } from "./flat-yaml.mjs";
import { EXPORT_RUNTIMES } from "./runtimes.mjs";
import { loadRubric, scoreRepo } from "../validation/agent-readiness-lib.mjs";
import { cmdAnalyze } from "./analyze/index.mjs";
import { cmdRelay } from "./relay.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_VERSION = "v1";
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

// ── frontmatter ─────────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  if (!content.startsWith("---")) return { frontmatter: null, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: content };
  const fmText = content.slice(content.indexOf("\n") + 1, end);
  const body = content.slice(content.indexOf("\n", end + 1) + 1);
  return { frontmatter: parseFlatYaml(fmText), body };
}

function normalizeTier(tier) {
  // Friendly labels → canonical engine values. `private` never syncs (= admin);
  // outward tiers `client` (consultant) and `company` (employee) → external.
  if (tier === "private") return "admin";
  if (tier === "client" || tier === "company") return "external";
  return tier;
}

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
  const dotenv = loadDotEnv(repo);
  const keyEnv = "AIOS_API_KEY";
  return {
    project: projCfg.slug || slugify(path.basename(repo)),
    project_members: projCfg.members || [],
    sync_tiers: ["team", "external"],
    sync_include: [],
    sync_exclude: [],
    brain_url: process.env.AIOS_BRAIN_URL || dotenv.AIOS_BRAIN_URL || "",
    api_key: process.env[keyEnv] || dotenv[keyEnv] || "",
    api_key_env: keyEnv,
    team_id: process.env.AIOS_TEAM || dotenv.AIOS_TEAM || "",
  };
}

function loadDotEnv(repo) {
  const envPath = path.join(repo, ".env");
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const val = stripQuotes(m[2].trim());
    // Skip dotenvx ciphertext + its public key — these are decrypted into
    // process.env at runtime by `dotenvx run` (see package.json scripts), which
    // every caller checks first. Returning ciphertext here would be wrong.
    if (m[1] === "DOTENV_PUBLIC_KEY" || val.startsWith("encrypted:")) continue;
    out[m[1]] = val;
  }
  return out;
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

  const dotenv = loadDotEnv(repo);
  cfg.brain_url = process.env.AIOS_BRAIN_URL || dotenv.AIOS_BRAIN_URL || cfg.brain_url || "";
  const keyEnv = cfg.api_key_env || "AIOS_API_KEY";
  cfg.api_key = process.env[keyEnv] || dotenv[keyEnv] || "";

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
  const candidate =
    process.env.AIOS_MEMBER ||
    dotenv.AIOS_MEMBER ||
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

function classifyKind(rel, frontmatter) {
  // Spine-agnostic: match by filename/role so new (3-log, 2-work) and legacy
  // (03-status, 02-deliverables) spines both classify correctly.
  const base = rel.split("/").pop();
  if (base === "decision-log.md") return "decision";
  if (base === "tasks.md") return "task";
  if (frontmatter?.type === "transcript" || rel.includes("/transcripts/")) return "transcript";
  if (/^(2-work|02-deliverables)[/\\]/.test(rel)) return "deliverable";
  return "artifact";
}

// ── markdown table row parsers ──────────────────────────────────────────────

function parseTableRows(body) {
  const rows = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t
      .split("|")
      .slice(1, -1)
      .map((x) => x.trim());
    if (!cells.length) continue;
    if (cells.every((x) => /^[-: ]*$/.test(x))) continue; // separator row
    rows.push(cells);
  }
  return rows;
}

function parseTaskRows(body) {
  // | ID | Task | Assignee | Status | Sprint | Due | PM | PM URL |
  const rows = parseTableRows(body);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  if (!header.includes("id") || !header.includes("task")) return [];
  const idx = (name) => header.indexOf(name);
  return rows
    .slice(1)
    .map((cells) => {
      const rowKey = cells[idx("id")] || "";
      const pm = idx("pm") >= 0 ? parsePmCell(cells[idx("pm")] || "", rowKey) : {};
      return {
        row_key: rowKey,
        title: cells[idx("task")] || "",
        assignee: idx("assignee") >= 0 ? cells[idx("assignee")] || "" : "",
        status: idx("status") >= 0 ? cells[idx("status")] || "" : "",
        sprint: idx("sprint") >= 0 ? cells[idx("sprint")] || "" : "",
        due: idx("due") >= 0 ? cells[idx("due")] || null : null,
        ...pm,
        pm_url: idx("pm url") >= 0 ? cells[idx("pm url")] || null : null,
      };
    })
    .filter((r) => r.row_key);
}

function parsePmCell(raw, rowKey) {
  const value = raw.trim();
  if (!value) return {};
  const m = value.match(/^(plane|linear)(?::|\s+)?(.+)?$/i);
  if (!m) return {};
  return {
    pm_provider: m[1].toLowerCase(),
    pm_external_id: (m[2] || rowKey).trim(),
  };
}

function parseDecisionRows(body) {
  // | # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
  const rows = parseTableRows(body);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  if (!header.includes("decision")) return [];
  const idx = (name) => header.findIndex((h) => h.startsWith(name));
  return rows
    .slice(1)
    .map((cells) => ({
      row_key: cells[idx("#")] ?? cells[0] ?? "",
      decided_at: idx("date") >= 0 ? cells[idx("date")] || null : null,
      title: cells[idx("decision")] || "",
      rationale: idx("rationale") >= 0 ? cells[idx("rationale")] || "" : "",
      decided_by: idx("decided") >= 0 ? cells[idx("decided")] || "" : "",
      impact: idx("impact") >= 0 ? cells[idx("impact")] || "" : "",
      tier: idx("type") >= 0 ? parseInt(cells[idx("type")], 10) || null : null,
      audience: idx("audience") >= 0 ? normalizeTier(cells[idx("audience")] || "team") : "team",
    }))
    .filter((r) => r.row_key);
}

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

async function api(cfg, method, route, body = null) {
  const url = `${cfg.brain_url.replace(/\/$/, "")}/api/${API_VERSION}${route}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.api_key}`,
      "X-AIOS-Team": cfg.team_id || "",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 200);
    throw new Error(`${res.status} ${json?.error?.code || ""}: ${msg}`);
  }
  return json;
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

// Connect one already-resolved descriptor: print guidance → collect secrets → validate
// live → store. Returns true on success, false on a skipped/failed attempt (callers decide
// how to signal that). Pass `ask` to share one readline across several connects (onboard);
// omit it and connectFlow opens+closes its own for a single standalone connect.
async function connectFlow(repo, d, { sets = {}, tokenFlag = null, ask } = {}) {
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
  if (existsSync(tasksPath) && (tasksRes.tasks || []).length) {
    let content = readFileSync(tasksPath, "utf8");
    for (const group of tasksRes.tasks) {
      if (group.project !== cfg.project) continue;
      for (const row of group.rows || []) {
        const line = `| ${row.row_key} | ${row.title} | ${row.assignee || ""} | ${row.status} | ${row.sprint || ""} | ${row.due || ""} |`;
        const re = new RegExp(
          `^\\|\\s*${row.row_key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|.*$`,
          "m"
        );
        if (re.test(content)) content = content.replace(re, line);
        else content = content.trimEnd() + "\n" + line + "\n";
        merged++;
      }
    }
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

  const url = `${cfg.brain_url.replace(/\/$/, "")}/api/${API_VERSION}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.api_key}`,
      "X-AIOS-Team": cfg.team_id || "",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const text = await res.text();
    die(`query failed: ${res.status} ${text.slice(0, 200)}`);
  }

  // SSE stream: delta / sources / done
  const decoder = new TextDecoder();
  let buffer = "";
  let sources = [];
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = (block.match(/^event:\s*(.*)$/m) || [])[1] || "message";
      const dataLine = (block.match(/^data:\s*(.*)$/m) || [])[1];
      if (!dataLine) continue;
      let data;
      try {
        data = JSON.parse(dataLine);
      } catch {
        continue;
      }
      if (event === "delta") process.stdout.write(data.text || "");
      else if (event === "sources") sources = data.sources || [];
      else if (event === "done") {
        process.stdout.write("\n");
        if (typeof data.cost_usd === "number")
          console.log(
            c.dim(
              `(${data.input_tokens} in / ${data.output_tokens} out · $${data.cost_usd.toFixed(4)})`
            )
          );
      }
    }
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

// ── main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

const repoFlagIdx = rest.indexOf("--repo");
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
  aios analyze [--since 7d] [--tool x]   agentic-maturity (AEM) report from local session logs
    [--report] [--json] [--push]        tools: claude|codex|cursor (default: all); --report = deep
    [--full]                            dive on your weakest axis; --push needs brain config
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
  aios relay "task" [branch] [opts]     Opus 4.8 ↔ Cursor plan/review loop
    [--rounds N] [--skill /name]        rounds default 3; skill default /review-plan
    [--merge] [--log <file>]            --merge auto-merges branch on approval (off by default)
    [--cursor-timeout N] [--dry-run]    cursor-timeout default 300s; --dry-run skips git ops
options:
  --repo <path>               team-ops repo (default: walk up from cwd)`;

if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(USAGE);
  process.exit(0);
}

// export-okf, graph, install-skill, connect, skills, assess-codebase, learn, analyze, relay
// are offline-capable: no aios.yaml required (analyze reads local ~/.<tool> logs;
// --push uses env/.env or aios.yaml brain config).
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
  else {
    console.log(USAGE);
    process.exit(1);
  }
} catch (e) {
  die(e.message);
}
