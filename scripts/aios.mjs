#!/usr/bin/env node
/**
 * aios.mjs — AIOS Team Brain sync client for agentic-team-ops repos.
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
 *
 * Options: --repo <path> (default: walk up from cwd to find aios.yaml)
 */

import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_VERSION = "v1";
const VALID_KINDS = ["deliverable", "transcript", "decision", "task", "artifact"];
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
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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

function parseFlatYaml(text) {
  const out = {};
  let currentList = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentList) {
      out[currentList].push(stripQuotes(listItem[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      if (value === "" || value.startsWith("#")) {
        out[key] = [];
        currentList = key;
      } else {
        out[key] = stripQuotes(value.replace(/\s+#.*$/, "").trim());
        currentList = null;
      }
    }
  }
  return out;
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

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
  if (tier === "client") return "external"; // legacy alias
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

function loadDotEnv(repo) {
  const envPath = path.join(repo, ".env");
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = stripQuotes(m[2].trim());
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
  cfg.brain_url =
    process.env.AIOS_BRAIN_URL || dotenv.AIOS_BRAIN_URL || cfg.brain_url || "";
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
  const isExcluded = (rel) =>
    excludes.some((e) => rel === e || rel.startsWith(e + "/"));

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
  if (rel.endsWith("03-status/decision-log.md") || rel === "03-status/decision-log.md")
    return "decision";
  if (rel.endsWith("03-status/tasks.md") || rel === "03-status/tasks.md") return "task";
  if (frontmatter?.type === "transcript" || rel.includes("/transcripts/"))
    return "transcript";
  if (rel.startsWith("02-deliverables/")) return "deliverable";
  return "artifact";
}

// ── markdown table row parsers ──────────────────────────────────────────────

function parseTableRows(body) {
  const rows = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.split("|").slice(1, -1).map((x) => x.trim());
    if (!cells.length) continue;
    if (cells.every((x) => /^[-: ]*$/.test(x))) continue; // separator row
    rows.push(cells);
  }
  return rows;
}

function parseTaskRows(body) {
  // | ID | Task | Assignee | Status | Sprint | Due |
  const rows = parseTableRows(body);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  if (!header.includes("id") || !header.includes("task")) return [];
  const idx = (name) => header.indexOf(name);
  return rows.slice(1).map((cells) => ({
    row_key: cells[idx("id")] || "",
    title: cells[idx("task")] || "",
    assignee: idx("assignee") >= 0 ? cells[idx("assignee")] || "" : "",
    status: idx("status") >= 0 ? cells[idx("status")] || "" : "",
    sprint: idx("sprint") >= 0 ? cells[idx("sprint")] || "" : "",
    due: idx("due") >= 0 ? cells[idx("due")] || null : null,
  })).filter((r) => r.row_key);
}

function parseDecisionRows(body) {
  // | # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
  const rows = parseTableRows(body);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  if (!header.includes("decision")) return [];
  const idx = (name) => header.findIndex((h) => h.startsWith(name));
  return rows.slice(1).map((cells) => ({
    row_key: cells[idx("#")] ?? cells[0] ?? "",
    decided_at: idx("date") >= 0 ? cells[idx("date")] || null : null,
    title: cells[idx("decision")] || "",
    rationale: idx("rationale") >= 0 ? cells[idx("rationale")] || "" : "",
    decided_by: idx("decided") >= 0 ? cells[idx("decided")] || "" : "",
    impact: idx("impact") >= 0 ? cells[idx("impact")] || "" : "",
    tier: idx("type") >= 0 ? parseInt(cells[idx("type")], 10) || null : null,
    audience:
      idx("audience") >= 0 ? normalizeTier(cells[idx("audience")] || "team") : "team",
  })).filter((r) => r.row_key);
}

// ── state ───────────────────────────────────────────────────────────────────

function loadState(repo) {
  const p = path.join(repo, ".aios", "state.json");
  if (!existsSync(p)) return { items: {}, last_pull: null, last_tasks_pull: null };
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
      rel, kind, hash, tier, frontmatter, body, rows,
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

// ── commands ────────────────────────────────────────────────────────────────

function cmdStatus(repo, cfg, patterns, args = []) {
  const { plan } = buildPlan(repo, cfg, patterns);
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
  section(c.green(`new (${newItems.length}):`), newItems,
    (i) => `${i.rel} ${c.dim(`[${i.kind}, ${i.tier}]`)}`);
  section(c.yellow(`modified (${modified.length}):`), modified,
    (i) => `${i.rel} ${c.dim(`[${i.kind}, ${i.tier}]`)}`);
  section(c.red(`blocked (${plan.blocked.length}):`), plan.blocked,
    (i) => `${i.rel} — ${i.reason}`);
  console.log(c.dim(`clean (already synced): ${plan.clean.length}`));

  if (plan.blocked.length) {
    console.log("");
    console.log(c.dim(
      "blocked files never leave this machine. To sync one: add `access: team` " +
      "(or `external`) frontmatter — promotion is deliberate."
    ));
  }
}

async function cmdPush(repo, cfg, patterns, args) {
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
      console.log(`  ${item.rel} [${item.kind}, ${item.tier}]${rowInfo} sha=${item.hash.slice(0, 12)}`);
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

async function cmdPull(repo, cfg) {
  requireOnline(cfg);
  const state = loadState(repo);
  const since = state.last_pull || "1970-01-01T00:00:00Z";
  const destRoot = path.join(repo, "01-intake", "from-brain");
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
      console.log(`  ${c.green("✓")} 01-intake/from-brain/${flat}`);
    }
    cursor = res.next_cursor || null;
  } while (cursor);

  // Task writeback: UI-created/modified rows → merge into 03-status/tasks.md
  const tasksRes = await api(
    cfg, "GET",
    `/tasks?${new URLSearchParams({ since: state.last_tasks_pull || "1970-01-01T00:00:00Z" })}`
  );
  let merged = 0;
  const tasksPath = path.join(repo, "03-status", "tasks.md");
  if (existsSync(tasksPath) && (tasksRes.tasks || []).length) {
    let content = readFileSync(tasksPath, "utf8");
    for (const group of tasksRes.tasks) {
      if (group.project !== cfg.project) continue;
      for (const row of group.rows || []) {
        const line = `| ${row.row_key} | ${row.title} | ${row.assignee || ""} | ${row.status} | ${row.sprint || ""} | ${row.due || ""} |`;
        const re = new RegExp(`^\\|\\s*${row.row_key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|.*$`, "m");
        if (re.test(content)) content = content.replace(re, line);
        else content = content.trimEnd() + "\n" + line + "\n";
        merged++;
      }
    }
    writeFileSync(tasksPath, content);
  }

  state.last_pull = new Date().toISOString();
  state.last_tasks_pull = state.last_pull;
  saveState(repo, state);
  console.log("");
  console.log(c.green(`pulled ${fetched} item(s); merged ${merged} task row(s).`));
}

async function cmdQuery(repo, cfg, args) {
  const question = args.filter((a) => !a.startsWith("--")).join(" ").trim();
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
      try { data = JSON.parse(dataLine); } catch { continue; }
      if (event === "delta") process.stdout.write(data.text || "");
      else if (event === "sources") sources = data.sources || [];
      else if (event === "done") {
        process.stdout.write("\n");
        if (typeof data.cost_usd === "number")
          console.log(c.dim(`(${data.input_tokens} in / ${data.output_tokens} out · $${data.cost_usd.toFixed(4)})`));
      }
    }
  }
  if (sources.length) {
    console.log("");
    console.log(c.blue("sources:"));
    for (const s of sources) console.log(`  [${s.id}] ${s.project}/${s.path} ${c.dim(`(${s.kind})`)}`);
  }
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
  aios status                 what would sync (new/modified/blocked/clean)
  aios push [--dry-run] [paths…]
  aios pull                   fetch team updates → 01-intake/from-brain/
  aios query "question"       ask the Team Brain
options:
  --repo <path>               team-ops repo (default: walk up from cwd)`;

if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(USAGE);
  process.exit(0);
}

const repo = repoArg ? path.resolve(repoArg) : findRepoRoot(process.cwd());
if (!repo) die("no aios.yaml found walking up from cwd — pass --repo <path>");
const cfg = loadConfig(repo);
const patterns = loadSecretPatterns();

try {
  if (cmd === "status") cmdStatus(repo, cfg, patterns, rest);
  else if (cmd === "push") await cmdPush(repo, cfg, patterns, rest);
  else if (cmd === "pull") await cmdPull(repo, cfg);
  else if (cmd === "query") await cmdQuery(repo, cfg, rest);
  else {
    console.log(USAGE);
    process.exit(1);
  }
} catch (e) {
  die(e.message);
}
