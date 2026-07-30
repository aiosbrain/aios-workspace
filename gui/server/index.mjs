#!/usr/bin/env node
/**
 * gui/server — local web GUI for an aios-workspace repo.
 *
 * A thin gateway: one WebSocket session = one Claude Agent SDK `query()` with
 * cwd set to the target repo, so .claude/CLAUDE.md, rules, skills, and the
 * PreToolUse guard hook all fire exactly as they do in Claude Code
 * (settingSources defaults to user+project).
 *
 * Security posture: binds 127.0.0.1 ONLY; a random session token is printed at
 * startup and required on the WebSocket upgrade. This is a local cockpit, not
 * a multi-user server — do not reverse-proxy it to a network.
 *
 * Usage: node gui/server/index.mjs --repo <team-ops repo> [--port 8790]
 *        (or from the toolkit root: npm run gui -- --repo <path>)
 */

import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import { createAdapter, readAgentConfig } from "./runtime-adapters/index.mjs";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { MEMORY_FILES, MEMORY_ABSENT } from "./memory-files.mjs";
import {
  reviewTurn,
  applyMemoryUpdates,
  undoMemoryWrite,
  callModel,
  loadSecretPatterns,
  isTrivialAck,
  containsSecret,
  redactSecrets,
} from "./memory-reviewer.mjs";
// I-03 (AIO-384): runtime-issued capability handle. The owning-runtime durable store is plain ESM
// (no dist dependency, safe to load at server start); the coordinator-side broker/fallback lives in
// the compiled operator-loop and is loaded lazily + guarded so `npm run gui` never hard-depends on a
// built dist. Admin-tier local state — never synced.
import {
  issueHandle,
  consumeAndExecute,
  capabilityTargets,
} from "./runtime-adapters/capability-store.mjs";
import { guardWrite as runGuardWrite } from "./runtime-adapters/guard.mjs";
import { GUI_RUNTIMES, runtimeCapabilities } from "@aiosbrain/foundation/runtimes";
import {
  createCatalogResolver,
  getConfig,
  postModel,
  getRuntime,
  postRuntime,
} from "./config-routes.mjs";
// AIO-600: catalog + connector data now crosses the CLI seam (`aios catalog --json`,
// `aios connector …` via aiosJson below) instead of deep-importing scripts/**.
import { listPersonalities, mapCatalog, blueprintResponse } from "./catalog.mjs";
import { createAiosJson } from "./aios-json.mjs";
import { listLibrary, installSkill, uninstallSkill, scanSkillById } from "./skill-library.mjs";
import { evaluateToolPolicy } from "./tool-policy.mjs";
import { readSessionIndex, upsertSession, visibleSessionIndex } from "./session-index.mjs";
import { buildMaturityPayload } from "./maturity.mjs";
import { buildCostsPayload } from "./costs.mjs";
import { createAnalysisCache } from "./analysis-cache.mjs";
import { readCostConfig, editableCostConfig, updateCostConfig } from "./cost-config.mjs";
import { collectProviderActuals } from "./provider-costs.mjs";
import {
  validateCadence,
  validateWindow,
  validateAskId,
  runLoopCli,
  runAsksCli,
  buildWeeklyCloseoutPayload,
  loopResponse,
} from "./loop.mjs";
import { parseAskIds, resolveAsksResponse, askDetailResponse } from "./asks.mjs";
import {
  resolveTasksFile,
  resolveTaskFileByRel,
  readTasks,
  derivePushState,
  applyTaskEdit,
  TaskEditError,
} from "./tasks.mjs";
import { searchSessions } from "./sessions-search.mjs";
import { writeFileSync as fsWriteFileSync, mkdirSync as fsMkdirSync } from "node:fs";
import { getToolkit, toolkitCli } from "./toolkit-locate.mjs";
import { loadCoordinator, operatorLoopStatus } from "./operator-loop-capability.mjs";
// Single-source workspace-marker list shared with scripts/run-gui.mjs (AIO-600 C5). Relative
// path in-tree (worktrees symlink node_modules from the primary, so a just-added package subpath
// would not resolve); becomes the published `@aiosbrain/foundation/workspace-markers` at cut time.
import { WORKSPACE_MARKERS } from "../../packages/foundation/src/workspace-markers.mjs";

// Tools that run without a permission prompt (read-only + workspace edits — the
// PreToolUse guard hook still vets every Write/Edit for secrets and tier leaks).
// Bash and network/MCP tools fall through to an explicit prompt.
const AUTO_ALLOW = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "Task",
  "ExitPlanMode",
  "WebFetch",
  "WebSearch",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

// Deterministic, env-gated, deny-by-default Bash policy used ONLY by the agentic
// UX-testing harness to make Flow-A permission enforcement reproducible. Inert
// unless AIOS_GUI_TEST_POLICY names a built-in policy (default off → production
// unchanged). The env var selects a NAMED policy whose exact-argv command shapes
// live in ./tool-policy.mjs — a test can pick one but cannot widen it, and
// matching rejects shell metacharacters so chained commands can't slip through.
const TEST_POLICY_NAME = (process.env.AIOS_GUI_TEST_POLICY || "").trim();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(SCRIPT_DIR, "..", "client", "dist");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : dflt;
}
const repo = path.resolve(flag("--repo", process.cwd()));
const port = parseInt(flag("--port", "8790"), 10);

// Toolkit resolution (AIO-600 C5): every toolkit path resolves through the toolkit-location
// contract (toolkit-locate.mjs: --toolkit-dir > AIOS_TOOLKIT_DIR > adjacent checkout > fail) —
// never a hard-coded ../../. See docs/gui-toolkit-contract.md.
let TOOLKIT;
try {
  TOOLKIT = getToolkit();
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}

// Probe the OPTIONAL operator-loop capability now, so absence is reported at startup (one log
// line + /api/info's capabilities field), never silently on first use (AIO-600 C5). The lazy
// I-03/I-07 + AIO-427 coordinator loader + inline fallback broker live in
// operator-loop-capability.mjs.
loadCoordinator();

if (!WORKSPACE_MARKERS.some((f) => existsSync(path.join(repo, f)))) {
  console.error(
    `error: ${repo} does not look like an AIOS workspace (no ${WORKSPACE_MARKERS.join("/")})`
  );
  process.exit(1);
}

// The desktop shell (Tauri) can pre-set the session token so it doesn't have to
// parse it back out of stdout; otherwise we mint a random one (the dev/CLI path).
const TOKEN = process.env.AIOS_GUI_TOKEN || randomBytes(16).toString("hex");

// Chat transcripts + index live INSIDE the workspace (.aios/ is gitignored by the
// scaffold), so they're inherently scoped to this repo and never leak across
// workspaces. They are local + private + token-gated: a transcript can contain
// tool inputs/results and assistant text, so the endpoints that serve them
// require the session token, same as every other mutating/sensitive route.
const SESSIONS_DIR = path.join(repo, ".aios", "sessions");
const SESSIONS_INDEX = path.join(SESSIONS_DIR, "index.json");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
mkdirSync(SESSIONS_DIR, { recursive: true });

// ── static client ───────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Per-runtime model catalogs (AIO-536). The logic lives in config-routes.mjs so it
// is unit-testable in-process; this only binds it to the workspace.
const { catalogNow, catalogFor } = createCatalogResolver(repo);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/api/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    // capabilities.operatorLoop: the GUI shows "operator-loop capability unavailable" instead of
    // silently losing durable journalling (AIO-600 C5; see operator-loop-capability.mjs).
    return res.end(
      JSON.stringify({
        repo,
        toolkit: { dir: TOOLKIT.dir, source: TOOLKIT.source },
        capabilities: { operatorLoop: operatorLoopStatus },
      })
    );
  }
  if (url.pathname === "/api/catalog") {
    aiosJson(["catalog", "--json"], { raw: true }).then(({ status, body }) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status === 200 ? mapCatalog(body) : body));
    });
    return;
  }
  // ── agent config: model (+ personality, Phase 4) — token-gated ──
  if (url.pathname === "/api/config" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    const cfg = readAgentConfig(repo);
    getConfig({ cfg, catalogFor }).then(({ status, body }) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    return;
  }
  if (url.pathname === "/api/config/memory-review" && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e4) req.destroy();
    });
    req.on("end", () => {
      let enabled;
      try {
        enabled = !!JSON.parse(body || "{}").enabled;
      } catch {
        enabled = true;
      }
      try {
        setAiosKey(repo, "memory_review", enabled ? "on" : "off");
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, memoryReview: enabled }));
    });
    return;
  }
  if (url.pathname === "/api/config/model" && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e4) req.destroy();
    });
    req.on("end", async () => {
      let model = "";
      try {
        model = String(JSON.parse(body || "{}").model || "");
      } catch {
        /* bad body */
      }
      const { runtime } = readAgentConfig(repo);
      const { status, body: out } = await postModel({
        model,
        runtime,
        catalogFor,
        setKey: (k, v) => setAiosKey(repo, k, v),
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
    return;
  }
  // ── agent runtime (AIO-536) — list the GUI-drivable runtimes / switch to one ──
  // A switch applies to the NEXT chat: a live session pinned its runtime at hello.
  if (url.pathname === "/api/config/runtime") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    if (req.method === "GET") {
      const { status, body } = getRuntime({ runtime: readAgentConfig(repo).runtime });
      res.writeHead(status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(body));
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end("method not allowed");
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e4) req.destroy();
    });
    req.on("end", () => {
      let runtime = "";
      try {
        runtime = String(JSON.parse(body || "{}").runtime || "");
      } catch {
        /* bad body */
      }
      const { status, body: out } = postRuntime({
        runtime,
        setKey: (k, v) => setAiosKey(repo, k, v),
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
    return;
  }
  // ── personalities (token-gated) ──
  if (url.pathname === "/api/personalities" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        personalities: listPersonalities(repo),
        current: readAgentConfig(repo).personality,
      })
    );
  }
  if (url.pathname === "/api/config/personality" && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e4) req.destroy();
    });
    req.on("end", () => {
      let id = "";
      try {
        id = String(JSON.parse(body || "{}").personality || "");
      } catch {
        /* bad body */
      }
      const valid = listPersonalities(repo).some((p) => p.id === id);
      if (!valid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "unknown personality" }));
      }
      try {
        setAiosKey(repo, "agent_personality", id);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, personality: id }));
    });
    return;
  }
  // ── skills library (token-gated). Official = one-click; community = scan + consent. ──
  if (url.pathname === "/api/skills" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(listLibrary(repo)));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  // Advisory static scan of a single skill (id-sanitized) — drives the Review & install UI.
  const skillScan = url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/scan$/);
  if (skillScan && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(scanSkillById(skillScan[1])));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  const skillAct = url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/(install|uninstall)$/);
  if (skillAct && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    const [, id, action] = skillAct;
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e4) req.destroy();
    });
    req.on("end", () => {
      let consent = {};
      try {
        consent = JSON.parse(body || "{}").consent || {};
      } catch {
        /* bad body → no consent */
      }
      try {
        const out =
          action === "install" ? installSkill(repo, id, consent) : uninstallSkill(repo, id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...out }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message, scan: e.scan || null }));
      }
    });
    return;
  }
  // ── chat sessions (token-gated; transcripts are sensitive local content) ──
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    const idx = visibleSessionIndex(SESSIONS_DIR, readSessionIndex(SESSIONS_INDEX));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(idx));
  }
  // Full-content chat search. MUST precede the /api/sessions/:id route below, or "search"
  // would be parsed as a (non-UUID) session id and 400. Token-gated + bounded (see
  // sessions-search.mjs); a trimmed/empty q returns no results.
  if (url.pathname === "/api/sessions/search" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    // Bail before the O(all sessions) visibility walk when there's nothing to search.
    // The palette debounces a request per keystroke, so blank/whitespace queries are the
    // common case; searchSessions would return [] for them anyway.
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ results: [] }));
    }
    const { sessions } = visibleSessionIndex(SESSIONS_DIR, readSessionIndex(SESSIONS_INDEX));
    const out = searchSessions(SESSIONS_DIR, sessions, q);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out));
  }
  const sessMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessMatch && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    const id = sessMatch[1];
    if (!UUID_RE.test(id)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "bad session id" }));
    }
    const file = path.join(SESSIONS_DIR, `${id}.jsonl`); // id is a validated UUID — no traversal
    if (!existsSync(file)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    const events = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* skip a torn line */
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ id, events }));
  }
  // ── review-and-push panel (token-gated; mutating) ──
  if (url.pathname === "/api/review") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    runAios(["status", "--json"], (err, out) => {
      res.writeHead(err ? 500 : 200, { "Content-Type": "application/json" });
      res.end(err ? JSON.stringify({ error: err.message }) : out);
    });
    return;
  }
  // ── maturity panel (token-gated; read-only) ──
  // Reshapes the shared analyze snapshot (analysis-cache.mjs — AIO-453:
  // 60s fresh window, stale-while-revalidate, single-flight). CE stays SHADOW.
  // `?force=1` = the explicit Refresh button: kick a refresh even during the
  // failure backoff / fresh window (the backoff only gates automatic revalidation).
  if (url.pathname === "/api/maturity") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    analysisCache
      .get({ force: /^(1|true)$/i.test(url.searchParams.get("force") || "") })
      .then(({ raw, ...meta }) => {
        const payload = { ...buildMaturityPayload(raw), ...meta };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }
  // ── cost panel (token-gated; read-only) ──
  // Reshapes the SAME shared analyze snapshot's per-provider cost blocks for the
  // cockpit, resolving each provider to ACTUAL spend only (owner config > billing
  // API > detected subscription > unknown — never a token estimate). Owner
  // overrides come from <repo>/.aios/cost-config.json. The shared cache window
  // (see createAnalysisCache below) spans 35d so it covers the whole calendar
  // month even on the 31st; the builder month-filters the days and flags
  // config_status.window_covers_month when billing data starts mid-month.
  // `?force=1` = the explicit Refresh button (see /api/maturity above).
  if (url.pathname === "/api/costs") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    Promise.all([
      analysisCache.get({ force: /^(1|true)$/i.test(url.searchParams.get("force") || "") }),
      collectProviderActuals(),
    ])
      .then(([{ raw, ...meta }, providerActuals]) => {
        const payload = {
          ...buildCostsPayload(raw, { config: readCostConfig(repo), providerActuals }),
          ...meta,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }
  // ── cost settings (token-gated) — owner-entered actuals (AIO-457) ──
  // GET reads / POST merge-writes <repo>/.aios/cost-config.json: flat subscriptions
  // (claude/cursor/codex) + exact metered spend by provider and month. Admin-tier
  // local state, gitignored, never synced, no secrets. POST validates every field.
  if (url.pathname === "/api/costs/config") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, ...editableCostConfig(readCostConfig(repo)) }));
    }
    if (req.method === "POST") {
      let body = "";
      let tooLarge = false;
      req.on("data", (c) => {
        if (tooLarge) return;
        body += c;
        if (body.length > 1e6) {
          // Answer BEFORE tearing down the socket so the Settings form gets a real
          // error instead of a dead connection.
          tooLarge = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "request body too large" }));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooLarge) return;
        let patch = null;
        try {
          patch = JSON.parse(body || "{}");
        } catch {
          /* fall through to validation error */
        }
        try {
          const result = patch
            ? updateCostConfig(repo, patch)
            : { ok: false, errors: ["body must be valid JSON"] };
          if (!result.ok) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, errors: result.errors }));
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...editableCostConfig(result.config) }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405);
    return res.end("method not allowed");
  }
  // ── operator loop panel (token-gated) — AIO-318 ──
  // Thin wiring only; cadence/window validation, the lenient subprocess wrapper, the exit-code
  // policy, and the weekly reshape all live in ./loop.mjs. Pass-through routes (daily/collect/
  // telemetry) emit the CLI's --json verbatim; weekly is reshaped (CLI emits paths only).
  if (url.pathname === "/api/loop/daily" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    // --no-record: a panel load must not write a C4/C8 owner telemetry event (idempotent read).
    runLoopCli(repo, ["daily", "--json", "--no-record"]).then((cli) => {
      const { status, json } = loopResponse(cli);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
    return;
  }
  if (url.pathname === "/api/loop/collect" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let cadence;
    try {
      cadence = validateCadence(url.searchParams.get("cadence") ?? "weekly");
    } catch (e) {
      res.writeHead(e.statusCode ?? 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
    runLoopCli(repo, ["collect", `--${cadence}`, "--json"]).then((cli) => {
      const { status, json } = loopResponse(cli);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
    return;
  }
  if (url.pathname === "/api/loop/telemetry" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let windowDays;
    try {
      windowDays = validateWindow(url.searchParams.get("window"));
    } catch (e) {
      res.writeHead(e.statusCode ?? 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
    const args = ["telemetry", "--json"];
    if (windowDays != null) args.push("--window", String(windowDays));
    runLoopCli(repo, args).then((cli) => {
      const { status, json } = loopResponse(cli);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
    return;
  }
  // POST: runs the offline weekly drafter + writes local admin-tier closeout artifacts. NEVER
  // passes --remote — LLM/egress drafting stays a CLI-only consent action.
  if (url.pathname === "/api/loop/weekly" && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    runLoopCli(repo, ["weekly", "--json"]).then((cli) => {
      const { status, json } = loopResponse(cli, (stdout) =>
        buildWeeklyCloseoutPayload(stdout, repo)
      );
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
    return;
  }
  // GET: full detail for ONE ask, so the Today console can show what an item actually asks for
  // (title + body + severity + age) inline, instead of making the operator open the raw
  // .aios/loop/asks/asks.ndjson evidence path or spend an LLM turn asking what a row means.
  if (url.pathname === "/api/asks/show" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let id;
    try {
      id = validateAskId(url.searchParams.get("id"));
    } catch (e) {
      res.writeHead(e.statusCode ?? 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
    runAsksCli(repo, ["show", id, "--json"]).then((cli) => {
      const { status, json } = askDetailResponse(cli);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
    return;
  }
  // POST: resolve an ask from the Today console. Delegates to the SAME `aios asks resolve` the
  // terminal uses, so the append-only store, its writer lock, and the audit trail are identical
  // whichever surface acted. Local-only: closing an ask never touches the network.
  if (url.pathname === "/api/asks/resolve" && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      let ids;
      try {
        ids = parseAskIds(body);
      } catch (e) {
        res.writeHead(e.statusCode ?? 400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      runAsksCli(repo, ["resolve", ...ids, "--json"]).then((cli) => {
        const { status, json } = resolveAsksResponse(cli, ids);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    return;
  }
  // ── tasks panel (token-gated) ──
  // GET: parsed rows + FILE-LEVEL tier + a local push-state badge (new|modified|blocked|clean)
  // sourced from `aios status --json`. A missing task file is a graceful empty, not a 500.
  if (url.pathname === "/api/tasks" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    const file = resolveTasksFile(repo);
    if (!file) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ rel: null, tier: null, rows: [], pushState: null }));
    }
    let base;
    try {
      base = readTasks(file);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
    // pushState is best-effort: if `aios status` fails (e.g. offline), still return the rows.
    runAios(["status", "--json"], (err, out) => {
      let pushState = null;
      if (!err) {
        try {
          pushState = derivePushState(JSON.parse(out), base.rel);
        } catch {
          /* unparseable status → no badge */
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...base, pushState }));
    });
    return;
  }
  // POST: apply a single-row field patch and write it back to tasks.md — LOCAL ONLY, no network
  // call. The brain write is the separate, explicit `POST /api/push`.
  if (url.pathname === "/api/tasks/edit" && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      let rowKey = "",
        patch = {},
        rel = null;
      try {
        const j = JSON.parse(body || "{}");
        rowKey = typeof j.row_key === "string" ? j.row_key : "";
        patch = j.patch && typeof j.patch === "object" ? j.patch : {};
        // Optional: the file the row actually lives in. The Tasks panel omits it (it renders one
        // resolved file); the Operator Loop sends it, because a workspace with the tier split
        // holds rows in BOTH tasks.md and tasks-team.md and the row must be patched where it is.
        rel = typeof j.path === "string" ? j.path : null;
      } catch {
        /* bad body */
      }
      if (!rowKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "row_key is required" }));
      }
      const file = rel ? resolveTaskFileByRel(repo, rel) : resolveTasksFile(repo);
      if (!file) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            ok: false,
            error: rel
              ? `not a task file in this workspace: ${rel}`
              : "no tasks.md in this workspace",
          })
        );
      }
      try {
        const content = readFileSync(file.abs, "utf8");
        const { content: next, row, unchanged } = applyTaskEdit(content, rowKey, patch);
        if (!unchanged) fsWriteFileSync(file.abs, next);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, rel: file.rel, row }));
      } catch (e) {
        const status = e instanceof TaskEditError ? e.status : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/push" && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      let paths = [],
        dryRun = false;
      try {
        const j = JSON.parse(body || "{}");
        paths = Array.isArray(j.paths) ? j.paths : [];
        dryRun = !!j.dryRun;
      } catch {
        /* bad body */
      }
      if (!paths.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "no paths selected" }));
      }
      runAios(["push", ...paths, ...(dryRun ? ["--dry-run"] : [])], (err, out, stderr) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: !err,
            dryRun,
            output: stripAnsi((out || "") + (stderr || "")),
            error: err?.message || null,
          })
        );
      });
    });
    return;
  }
  // ── connector engine (token-gated) — every action crosses the `aios connector` seam ──
  if (url.pathname === "/api/connectors") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    aiosJson(["connector", "list"]).then(({ status, body }) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    return;
  }
  // ── who am I (token-gated) — role drives UI (only leads see the Team surface) ──
  if (url.pathname === "/api/me" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    runAios(["whoami"], (err, out) => {
      let me = null;
      if (!err) {
        try {
          me = JSON.parse((out || "").trim().split("\n").pop());
        } catch {
          /* not wired */
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: !!me, me }));
    });
    return;
  }
  // ── team blueprint (token-gated) ──
  if (url.pathname === "/api/blueprint" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    // refresh from the brain, then return the (now team-aware) connectors; a failed
    // connector-seam spawn forwards its error status instead of reading as "no connectors"
    runAios(["pull", "blueprint"], (err, out, stderr) => {
      aiosJson(["connector", "blueprint"]).then((envelope) => {
        const note = stripAnsi((stderr || "") + (out || ""));
        const { status, body } = blueprintResponse(!!err, note, envelope);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    return;
  }
  if (url.pathname === "/api/blueprint/publish" && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      let connectors = {};
      try {
        connectors = JSON.parse(body || "{}").connectors || {};
      } catch {
        /* */
      }
      try {
        fsMkdirSync(path.join(repo, ".aios"), { recursive: true });
        fsWriteFileSync(
          path.join(repo, ".aios", "team-blueprint.json"),
          JSON.stringify({ connectors }, null, 2)
        );
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      runAios(["push", "blueprint"], (err, out, stderr) => {
        res.writeHead(err ? 200 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: !err, output: stripAnsi((out || "") + (stderr || "")) }));
      });
    });
    return;
  }
  // OAuth one-click proxies: the GUI server relays start/status to the brain using the
  // workspace's member key. The token itself flows browser → brain directly and never
  // transits the GUI (no secret is read from or written to this request).
  const oauth = url.pathname.match(/^\/api\/connectors\/([a-z0-9-]+)\/(start|status)$/);
  if (oauth) {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    const [, id, action] = oauth;
    if (action === "start" && req.method !== "POST") {
      res.writeHead(405);
      return res.end("method not allowed");
    }
    if (action === "status" && req.method !== "GET") {
      res.writeHead(405);
      return res.end("method not allowed");
    }
    // The 503 (no brain) / 502 (relay error) mapping lives in the CLI seam now.
    aiosJson(["connector", action === "start" ? "oauth-start" : "oauth-status", id]).then(
      ({ status, body }) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      }
    );
    return;
  }
  const conn = url.pathname.match(
    /^\/api\/connectors\/([a-z0-9-]+)\/(validate|store|store-existing|unwire)$/
  );
  if (conn && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    const [, id, action] = conn;
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      // Secrets arrive here in the POST body and are relayed to the connector CLI over
      // STDIN only (never argv — that's `ps`-visible), never logged, never written to
      // .sessions; the CLI persists them encrypted. The 422/503/500 mapping (validation,
      // credential_missing, no brain, oauth_not_connected) lives in the seam.
      const needsSecrets = action === "validate" || action === "store";
      aiosJson(["connector", action, id, ...(needsSecrets ? ["--secrets-stdin"] : [])], {
        stdin: needsSecrets ? body || "{}" : undefined,
      }).then(({ status, body: result }) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      });
    });
    return;
  }

  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  const abs = path.join(CLIENT_DIST, path.normalize(file));
  if (!abs.startsWith(CLIENT_DIST) || !existsSync(abs)) {
    res.writeHead(404);
    return res.end("not found — build the client first: npm run build --workspace gui/client");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] || "application/octet-stream" });
  res.end(readFileSync(abs));
});

// Run the aios CLI against the target repo; reuses the CLI's exact plan/push logic.
// Resolved via the toolkit-location contract (AIO-600 C5), not gui/server-relative.
const AIOS_CLI = toolkitCli();
function runAios(args, cb) {
  execFile(
    process.execPath,
    [AIOS_CLI, ...args, "--repo", repo],
    { cwd: repo, maxBuffer: 10 * 1024 * 1024 },
    (err, stdout, stderr) => cb(err, stdout, stderr)
  );
}
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}
// JSON machine-surface runner for the connector/catalog seams — same CLI, same repo pinning.
const aiosJson = createAiosJson({ cliPath: AIOS_CLI, repo });

// Shared analysis cache behind /api/maturity + /api/costs (AIO-453).
// One `aios analyze --json --since 35d` snapshot serves both routes; the last-good
// snapshot persists under .aios/gui/ (admin-tier, local-only — never synced).
// The window is 35d (not 30d) so the cost model's month view always covers the
// whole current calendar month even on the 31st (AIO-457); the extra days are
// harmless for the maturity rollup.
const analysisCache = createAnalysisCache({
  exec: (signal) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [AIOS_CLI, "analyze", "--json", "--since", "35d", "--repo", repo],
        { cwd: repo, maxBuffer: 10 * 1024 * 1024, signal }, // abort kills the child
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
    }),
  snapshotFile: path.join(repo, ".aios", "gui", "analysis-snapshot.json"),
  log: (msg) => console.error(msg),
});

// Keys the GUI is allowed to write into aios.yaml. Callers validate the VALUE
// (model ∈ the active runtime's catalog; runtime ∈ GUI_RUNTIMES; personality ∈
// scanned dir) before calling. Grows only by an enumerated, registry-validated key.
const AIOS_WRITABLE_KEYS = new Set([
  "agent_model",
  "agent_personality",
  "agent_runtime",
  "memory_review",
]);

// Set a single flat key in aios.yaml, preserving the rest. Replaces an existing
// non-comment `key:` line (anchored at column 0, so a commented "# key:" is left
// alone) or appends one. Output stays within OGR04's flat-YAML subset.
function setAiosKey(repoDir, key, value) {
  if (!AIOS_WRITABLE_KEYS.has(key))
    throw new Error(`refusing to write unknown aios.yaml key '${key}'`);
  const p = path.join(repoDir, "aios.yaml");
  const line = `${key}: "${value}"`;
  const re = new RegExp(`^${key}:.*$`, "m");
  let text = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (!text) text = line + "\n";
  else if (re.test(text)) text = text.replace(re, line);
  else text = text.replace(/\n*$/, "\n") + line + "\n";
  fsWriteFileSync(p, text);
}

// ── websocket: one connection = one SDK session ─────────────────────────────
const wss = new WebSocketServer({ noServer: true });
// One live connection per session id (see the latest-wins guard in the connection
// handler). 4001 is our app-level close code for "superseded by a newer connection".
const WS_CLOSE_SUPERSEDED = 4001;
const liveSessionConns = new Map(); // sessionId -> { ws, supersede }
// Interactive tool approvals auto-deny after this long so a closed tab can't wedge
// the run. Advertised to the client in each permission_request (countdown UI).
const PERM_TIMEOUT_MS = 5 * 60 * 1000;

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname !== "/ws" || url.searchParams.get("token") !== TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  // Resume an existing chat when the client passes a valid ?session=<uuid> that
  // we already have a transcript for; otherwise mint a fresh UUID and pin it as
  // the SDK session id so the transcript file and the resumable session share one id.
  const wsUrl = new URL(req.url, `http://127.0.0.1:${port}`);
  const wanted = wsUrl.searchParams.get("session") || "";
  // Resumable = has a stored transcript OR is currently live (a draft session that
  // hasn't earned its file yet — see transcriptLive — must still supersede, not fork).
  const resumeId =
    UUID_RE.test(wanted) &&
    (existsSync(path.join(SESSIONS_DIR, `${wanted}.jsonl`)) || liveSessionConns.has(wanted))
      ? wanted
      : null;
  const sessionId = resumeId || randomUUID();
  // Latest-wins single-writer guard: a session has at most one live connection, so
  // two adapter runs can never interleave one transcript (a reconnect after sleep
  // must supersede its half-dead predecessor). Close code 4001 tells the old client
  // this was a takeover, not a network drop — it must NOT auto-reconnect.
  //
  // supersede() must NOT depend on the 'close' event: a graceful close() against a
  // dead peer stalls on ws's ~30s close handshake timeout, which would leave the old
  // adapter run writing the shared transcript the whole time. So takeover (a) flags
  // the old connection to stop writing immediately, (b) aborts its run directly, and
  // only then (c) starts the close handshake for whoever is still listening.
  let superseded = false; // once set, this connection may not write transcript or socket
  const teardownTasks = []; // registered below once ac/pending exist; runs at most once
  let tornDown = false;
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    for (const t of teardownTasks) {
      try {
        t();
      } catch {
        /* teardown is best-effort */
      }
    }
  };
  const conn = {
    ws,
    supersede: () => {
      superseded = true;
      teardown();
      try {
        ws.close(WS_CLOSE_SUPERSEDED, "session opened by a newer connection");
      } catch {
        /* already dying */
      }
    },
  };
  liveSessionConns.get(sessionId)?.supersede();
  liveSessionConns.set(sessionId, conn);
  // Registered first so the map entry can't be orphaned by a later setup failure.
  ws.on("close", () => {
    if (liveSessionConns.get(sessionId) === conn) liveSessionConns.delete(sessionId);
    teardown();
  });
  const transcript = path.join(SESSIONS_DIR, `${sessionId}.jsonl`); // append; resume continues the same file
  // Lazy transcript: a page load that never sends a message must not leave an orphan
  // file behind (every open used to mint one). Writes start at the first user turn;
  // sessions with an existing file (real resumes) keep appending from the hello on.
  let transcriptLive = existsSync(transcript);
  const existingSession = readSessionIndex(SESSIONS_INDEX).sessions.find((s) => s.id === sessionId);
  let sessionRegistered = !!existingSession;
  let titleSet = !!existingSession?.title;

  // ── background memory reviewer state (claude-code only; opt-out read LIVE) ──
  let reviewerRuntimeOk = false; // runtime gate (set at config read); enablement re-read each turn
  const secretPatterns = loadSecretPatterns(repo);
  const memBaselines = {}; // file -> content at session start (MEMORY_ABSENT if it didn't exist)
  for (const m of MEMORY_FILES) {
    try {
      memBaselines[m.file] = readFileSync(path.join(repo, ".claude", "memory", m.file), "utf8");
    } catch {
      memBaselines[m.file] = MEMORY_ABSENT;
    } // appears later ⇒ treated as dirty, never written
  }
  const memoryUndos = new Map(); // undo_id -> { id, file, path, prevContent, writtenHash }
  let curTurn = { user: "", assistant: "" }; // the in-flight turn, captured for the reviewer
  let reviewing = false; // a review is in flight
  let pendingReview = false; // a turn completed mid-review → drain once more (coalesce to latest)
  let reviewsThisSession = 0;
  const REVIEW_CAP = 40; // per-session review-COUNT backstop (bounds cost)

  // Schedule a review for the just-completed turn. Serializes rather than drops: if a
  // review is running, mark pending and the drain loop picks up the latest turn next.
  function runMemoryReview() {
    if (reviewing) {
      pendingReview = true;
      return;
    }
    drainReviews();
  }
  async function drainReviews() {
    reviewing = true;
    try {
      do {
        pendingReview = false;
        await reviewOnce({ user: curTurn.user, assistant: curTurn.assistant });
      } while (pendingReview && ws.readyState === ws.OPEN);
    } finally {
      reviewing = false;
    }
  }
  // One conservative review. Async, never blocks the turn; failures swallowed. The
  // trust boundary lives in memory-reviewer.mjs; here we gate + scrub inputs.
  async function reviewOnce(turn) {
    // LIVE opt-out: re-read config so a Settings toggle takes effect on this chat now.
    if (!reviewerRuntimeOk || !readAgentConfig(repo).memoryReview) return;
    if (ws.readyState !== ws.OPEN) return; // no write the user can't see/undo
    if (reviewsThisSession >= REVIEW_CAP) return;
    if (isTrivialAck(turn.user)) return; // cheap pre-gate
    if (containsSecret(`${turn.user}\n${turn.assistant}`, secretPatterns)) return; // don't ship a secret-y turn
    reviewsThisSession++;
    try {
      const fileContents = {};
      for (const m of MEMORY_FILES) {
        let body = "";
        try {
          body = readFileSync(path.join(repo, ".claude", "memory", m.file), "utf8");
        } catch {
          body = "";
        }
        fileContents[m.file] = redactSecrets(body, secretPatterns); // scrub EXISTING files before the call
      }
      const facts = await reviewTurn({
        turn,
        fileContents,
        callModel: (p) => callModel(p, { query: sdkQuery }),
      });
      if (!facts.length) return;
      const { events, undos } = applyMemoryUpdates({
        repo,
        facts,
        baselines: memBaselines,
        socketOpen: ws.readyState === ws.OPEN,
        guardWrite: (args) => runGuardWrite({ repo, ...args }),
        secretPatterns,
      });
      for (const u of undos) memoryUndos.set(u.id, u);
      for (const ev of events) emit(ev); // 💾 memory_updated → client notice
    } catch (e) {
      console.error("memory review:", e?.message || e);
    }
  }

  const send = (obj) => {
    if (superseded) return; // a superseded run may not write the transcript (single-writer)
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* closed */
    }
    if (!transcriptLive) return; // no file until the first user turn (no orphan transcripts)
    try {
      appendFileSync(transcript, JSON.stringify(obj) + "\n");
    } catch {
      /* best-effort */
    }
  };
  // Adapter event sink: same as send(), plus keep the session index fresh.
  const emit = (obj) => {
    send(obj);
    if (obj.type === "delta" && typeof obj.text === "string") curTurn.assistant += obj.text; // capture for the reviewer
    if ((obj.type === "session" || obj.type === "model") && obj.model && sessionRegistered)
      upsertSession(SESSIONS_INDEX, sessionId, { model: obj.model });
    else if (obj.type === "result") {
      if (sessionRegistered) upsertSession(SESSIONS_INDEX, sessionId, {});
      runMemoryReview();
    } // bump updatedAt + learn (async)
  };

  // Streaming-input generator fed by a queue: user turns arrive over WS.
  // Adapters consume { type:"user", text } turns (runtime-neutral).
  const queue = [];
  let wake = null;
  const ac = new AbortController(); // fired on ws close → wakes the iterator + signals the adapter
  const pushUser = (text, model, approvalMode) => {
    queue.push({ type: "user", text, model, approvalMode });
    if (wake) {
      wake();
      wake = null;
    }
  };
  async function* input() {
    for (;;) {
      while (queue.length) yield queue.shift();
      if (ac.signal.aborted) return;
      await new Promise((r) => (wake = r));
      if (ac.signal.aborted) return; // woken by ws close → terminate the iterator
    }
  }

  // Pending interactive tool approvals: id → resolver
  const pending = new Map();
  let nextPermId = 1;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "user_message" && typeof msg.text === "string") {
      const userText = msg.text.trim();
      if (!userText) return;
      transcriptLive = true; // first real turn — the session now earns its file
      send({ type: "echo_user", text: userText });
      if (!titleSet) {
        upsertSession(SESSIONS_INDEX, sessionId, {
          title: userText.replace(/\s+/g, " ").slice(0, 80),
          ...(typeof msg.model === "string" ? { model: msg.model } : {}),
        });
        sessionRegistered = true;
        titleSet = true;
      }
      curTurn = { user: userText, assistant: "" }; // start a fresh turn for the reviewer
      // Session-scoped, never persisted. The adapter authoritatively validates the mode
      // against the driver's advertised (env-gated) approvalModes and ignores anything else.
      pushUser(
        userText,
        typeof msg.model === "string" ? msg.model : undefined,
        typeof msg.approvalMode === "string" ? msg.approvalMode : undefined
      );
    } else if (msg.type === "permission_response" && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      // Option-based runtimes (ACP) reply with an optionId; Claude replies allow/deny.
      resolve(typeof msg.optionId === "string" ? msg.optionId : !!msg.allow);
    } else if (
      msg.type === "memory_undo" &&
      typeof msg.id === "string" &&
      memoryUndos.has(msg.id)
    ) {
      const u = memoryUndos.get(msg.id);
      const ok = undoMemoryWrite(u); // compare-and-swap: only if the file is still what we wrote
      if (ok) {
        memoryUndos.delete(msg.id);
        memBaselines[u.file] = u.prevContent;
      }
      emit({ type: "memory_undone", id: msg.id, ok });
    }
  });

  // Claude-style tool permission, server-owned so the WS prompt machinery is
  // shared across adapters: AUTO_ALLOW runs silently (the PreToolUse guard hook
  // still vets writes); other tools prompt. Returns the SDK { behavior } shape.
  const confirmClaudeTool = async (toolName, toolInput) => {
    if (AUTO_ALLOW.has(toolName)) return { behavior: "allow", updatedInput: toolInput };
    // Env-gated deterministic test policy (deny-by-default, exact-argv). Inert in
    // production: only active when AIOS_GUI_TEST_POLICY names a built-in policy.
    // Emits a tool_policy event so the UX harness can post-assert enforcement
    // from the transcript (and re-derive each verdict independently).
    if (TEST_POLICY_NAME) {
      const cmd = (toolInput && toolInput.command) || "";
      const verdict = evaluateToolPolicy(TEST_POLICY_NAME, toolName, toolInput);
      // Record the structured input too (e.g. Skill `{skill,args}`) so the harness
      // audit can re-derive each verdict, not just Bash command strings.
      send({
        type: "tool_policy",
        tool: toolName,
        command: cmd,
        input: toolInput,
        allowed: verdict.allowed,
        reason: verdict.reason,
      });
      return verdict.allowed
        ? { behavior: "allow", updatedInput: toolInput }
        : {
            behavior: "deny",
            message: `denied by AIOS_GUI_TEST_POLICY=${TEST_POLICY_NAME}: ${verdict.reason}`,
          };
    }
    if (toolName === "AskUserQuestion") {
      return {
        behavior: "deny",
        message:
          "This chat can't render multiple-choice questions. Ask the user ONE short question at a time as a normal message and wait for their typed reply.",
      };
    }
    const id = nextPermId++;
    // I-03 (AIO-384): the OWNING RUNTIME issues a durable, opaque capability handle for this approval
    // and persists its authoritative pending record BEFORE prompting. The coordinator (this gateway)
    // brokers the human decision, then the runtime validates its own record and atomically consumes
    // it — a durable tombstone that blocks any replay of the same approval (even across a restart).
    // Best-effort + additive: any store error falls through to the pre-existing allow/deny behavior,
    // so the prompt UX and the 5-min auto-deny are never weakened.
    let cap = null;
    try {
      cap = issueHandle(repo, {
        operation: toolName,
        normalizedArgs: toolInput,
        targetResources: capabilityTargets(toolName, toolInput),
        repoWorktreeIdentity: repo,
      });
    } catch {
      cap = null;
    }
    // Fallback lane (KILL-path, content-free): notify + deep-link to the runtime's own prompt instead
    // of the brokered round-trip. Opt-in via env; the primary design is the default.
    if (
      cap &&
      /^(1|true|on)$/i.test(String(process.env.AIOS_INBOX_APPROVAL_FALLBACK || "").trim())
    ) {
      try {
        const { notifyDeepLink, createDurableCapabilityJournal } = await loadCoordinator();
        const journal = createDurableCapabilityJournal?.(repo);
        const note = notifyDeepLink(
          { handle: cap.handle, deepLink: `aios://approve/${cap.handle}` },
          journal ? { appendInboxEvent: journal } : {}
        );
        send({
          type: "notify_deeplink",
          handle: note.handle,
          deepLink: note.deepLink,
          lane: note.lane,
        });
      } catch {
        /* fallback notification is best-effort */
      }
    }
    send({
      type: "permission_request",
      id,
      tool: toolName,
      input: toolInput,
      ...(cap ? { handle: cap.handle } : {}),
      timeoutMs: PERM_TIMEOUT_MS,
    });
    const allow = await new Promise((resolve) => {
      pending.set(id, resolve);
      // auto-deny after 5 minutes so a closed tab can't wedge the run
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(false);
        }
      }, PERM_TIMEOUT_MS).unref?.();
    });
    // Broker + durable consume. On the happy path this is the audit + one-time tombstone; if the
    // runtime rejects (a replayed/tampered handle), deny for safety. Guarded so a store/broker
    // failure never blocks a legitimate decision — it just falls back to the raw allow/deny.
    if (cap) {
      try {
        const { brokerDecision, createDurableCapabilityJournal } = await loadCoordinator();
        // Durable I-02 journal sink (AIO-427): the composition point binds it to this repo root; both
        // the coordinator (user-intent / pdp-decision) and the owning runtime (capability-consumption /
        // outcome / native-receipt) emit their content-free lifecycle events through it. Undefined when
        // the compiled loop is absent — every append is then a guarded no-op.
        const journal = createDurableCapabilityJournal?.(repo);
        const brokered = brokerDecision(
          cap.displayProjection,
          allow ? "approve" : "deny",
          journal ? { appendInboxEvent: journal } : {}
        );
        const result = consumeAndExecute(repo, cap.handle, brokered, {
          identity: repo,
          execute: () => true,
          appendEvent: journal,
        });
        if (result.kind === "rejected" && result.reason !== "denied") {
          send({ type: "capability_rejected", handle: cap.handle, reason: result.reason });
          return { behavior: "deny", message: `Approval rejected: ${result.reason}` };
        }
      } catch {
        /* best-effort: fall through to the raw decision below */
      }
    }
    return allow
      ? { behavior: "allow", updatedInput: toolInput }
      : { behavior: "deny", message: "Denied in the GUI" };
  };

  // Option-based permission (ACP / OpenCode): the adapter passes the runtime's
  // own options; the client renders a button per option and replies with an
  // optionId. Returns the chosen optionId (string), or null if the tab closed /
  // it timed out (the adapter maps a non-string to a "cancelled" outcome).
  const requestPermission = async ({ title, content, options }) => {
    const id = nextPermId++;
    send({
      type: "permission_request",
      id,
      tool: title,
      input: content,
      options,
      timeoutMs: PERM_TIMEOUT_MS,
    });
    return new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(null);
        }
      }, PERM_TIMEOUT_MS).unref?.();
    });
  };

  // One adapter drives this session, selected by agent_runtime in aios.yaml
  // (default claude-code ⇒ unchanged). createAdapter fails loudly on an
  // unknown / non-GUI / not-yet-implemented runtime — never silent fallback.
  const { runtime, model, baseUrl, personality } = readAgentConfig(repo);
  // Background memory reviewer: ONLY for the claude-code runtime (it reuses the Agent
  // SDK's ambient auth). Other runtimes (codex, opencode, ACP, local) must never
  // trigger a silent Anthropic call — BYOA. The runtime can't change mid-session, so
  // capture it here; the enable/disable flag is re-read live each turn (reviewOnce).
  reviewerRuntimeOk = runtime === "claude-code";
  // claude-code's PreToolUse hook pre-gates every write natively. Other drivers
  // can mutate files via in-process shell tools that bypass the host write-gate,
  // so they're validated by a post-turn sweep — say so in the UI (honest tier).
  const driver = GUI_RUNTIMES[runtime]?.driver;
  const safetyNote =
    driver && driver !== "claude-sdk"
      ? "Shell-driven file changes are validated after each turn, not pre-gated."
      : null;
  // BYOA: additive capability descriptor so the cockpit UI adapts to the active
  // runtime without branching on its name. Older clients ignore the extra field.
  // Catalog for THIS session's runtime (AIO-536). Non-blocking: hello must not wait on
  // an OpenCode server boot, so it uses the cached catalog and warms it for next time —
  // the seeded fallback is a correct list either way.
  const capabilities = runtimeCapabilities(runtime, catalogNow(runtime).models);
  send({ type: "hello", repo, sessionId, runtime, safetyNote, capabilities, resumed: !!resumeId });

  (async () => {
    try {
      const adapter = createAdapter(runtime);
      await adapter.run({
        repo,
        runtime,
        model,
        baseUrl,
        personality,
        ...(resumeId ? { resume: resumeId } : { sessionId }), // claude SDK: continue vs. pin a new session
        input: input(),
        emit,
        confirmClaudeTool,
        requestPermission,
        signal: ac.signal,
        // host-side governance for runtimes whose writes are host-mediated (ACP fs/write)
        guardWrite: (args) => runGuardWrite({ repo, ...args }),
      });
    } catch (e) {
      send({ type: "error", message: String(e?.message || e) });
    }
  })();

  // Teardown (runs once, from supersede() OR the 'close' listener registered at the
  // top of this handler — whichever fires first): stop the adapter run and unwedge
  // everything waiting on this connection.
  teardownTasks.push(
    () => ac.abort(),
    () => {
      if (wake) {
        wake();
        wake = null;
      } // unpark the input iterator so it returns
    },
    () => {
      // resolve any pending approvals as denied so the adapter loop can finish
      for (const resolve of pending.values()) resolve(false);
      pending.clear();
    }
  );
});

// Graceful shutdown on a signal: terminate websocket clients and close the server so a
// SIGTERM/SIGINT doesn't strand open connections. (Previously provided by the unified-inbox
// refresher's shutdown installer, removed with the inbox GUI.)
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    // release the advisory workspace lock only if it's ours
    const cur = JSON.parse(readFileSync(GUI_LOCK, "utf8"));
    if (cur?.pid === process.pid) unlinkSync(GUI_LOCK);
  } catch {
    /* advisory only */
  }
  for (const client of wss?.clients ?? []) client.terminate?.();
  wss?.close?.();
  server.close();
  server.closeAllConnections?.();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

// Advisory per-workspace lock: the single-writer session guard is per-process, so a
// second server on the SAME workspace (different port) would manage the same
// .aios/sessions unprotected. Warn loudly; don't hard-fail (CLI + desktop shell may
// deliberately coexist during development).
const GUI_LOCK = path.join(repo, ".aios", "gui-server.lock");
let foreignLockAlive = false; // a live sibling server holds the lock — never clobber it
try {
  const prev = JSON.parse(readFileSync(GUI_LOCK, "utf8"));
  let prevAlive = false;
  try {
    process.kill(prev.pid, 0);
    prevAlive = true;
  } catch {
    /* stale lock */
  }
  if (prevAlive && prev.pid !== process.pid) {
    foreignLockAlive = true;
    console.error(
      `warning: another GUI server for this workspace appears to be running (pid ${prev.pid}, port ${prev.port}).`
    );
    console.error(
      `  Two servers share the same .aios/sessions — prefer reusing the existing one at 127.0.0.1:${prev.port}.`
    );
  }
} catch {
  /* no lock */
}
server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(`error: port ${port} is already in use (another GUI server?).`);
    console.error(
      `  if it's a GUI for this same workspace, reuse its link instead of starting a second server;`
    );
    console.error(`  otherwise pick another port:  npm run gui -- --port ${Number(port) + 1}`);
    console.error(`  find the holder:              lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    process.exit(1);
  }
  throw err;
});
server.listen(port, "127.0.0.1", () => {
  // First-claim semantics: never clobber a LIVE sibling's lock — otherwise our own
  // clean exit would delete it and silently disarm the warning for the next server.
  if (!foreignLockAlive) {
    try {
      fsWriteFileSync(GUI_LOCK, JSON.stringify({ pid: process.pid, port }));
    } catch {
      /* advisory only */
    }
  }
  console.log("");
  console.log("  aios-workspace GUI");
  console.log(`  repo:  ${repo}`);
  console.log(`  open:  http://127.0.0.1:${port}/?token=${TOKEN}`);
  console.log("");
  console.log("  (localhost only — do not expose this port)");
});
