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
import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import { createAdapter, readAgentConfig } from "./runtime-adapters/index.mjs";
import {
  getSessionInfo as sdkGetSessionInfo,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
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
import { ALLOWED_MODELS, MODEL_OPTIONS } from "./runtime-adapters/claude-code.mjs";
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
import { GUI_RUNTIMES, runtimeCapabilities } from "../../scripts/runtimes.mjs";
import {
  readSkills,
  readIntegrations,
  firstSentence,
  frontmatter,
} from "../../scripts/gen-catalog.mjs";
import {
  listConnectors,
  getDescriptor,
  validateConnector,
  storeConnector,
  storeExistingConnector,
  unwireConnector,
  readBlueprint,
  startOAuth,
  checkOAuthStatus,
  storeOAuthConnector,
} from "../../scripts/connector.mjs";
import { resolveBrainConfig } from "../../scripts/brain-config.mjs";
import { listLibrary, installSkill, uninstallSkill, scanSkillById } from "./skill-library.mjs";
import { evaluateToolPolicy } from "./tool-policy.mjs";
import { readSessionIndex, upsertSession, visibleSessionIndex } from "./session-index.mjs";
import { buildMaturityPayload } from "./maturity.mjs";
import { buildCostsPayload } from "./costs.mjs";
import { createAnalysisCache } from "./analysis-cache.mjs";
import { readCostConfig, editableCostConfig, updateCostConfig } from "./cost-config.mjs";
import {
  validateCadence,
  validateWindow,
  runLoopCli,
  buildWeeklyCloseoutPayload,
  loopResponse,
} from "./loop.mjs";
import {
  resolveTasksFile,
  readTasks,
  derivePushState,
  applyTaskEdit,
  TaskEditError,
} from "./tasks.mjs";
import { searchSessions } from "./sessions-search.mjs";
// Unified Inbox comms section (I-14 / AIO-395): the local read-model queue + the scoped-confirm broker.
import {
  archiveInboxAsk,
  decideInbox,
  getInboxDetail,
  getInboxView,
  replyInboxAsk,
} from "./inbox-api.mjs";
import { createInboxRefresher, installInboxRefreshShutdown } from "./inbox-refresh.mjs";
import { writeFileSync as fsWriteFileSync, mkdirSync as fsMkdirSync } from "node:fs";

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

// I-03/I-07 + AIO-427: lazily load the coordinator-side broker (brokerDecision / notifyDeepLink) and
// the durable-journal composition bridge (createDurableCapabilityJournal) from the compiled
// operator-loop. Guarded so a missing/unbuilt dist degrades to an inline envelope broker with NO
// journalling — the server must start even before `npm run build:loop`. The AUTHORITY that matters
// (validate + durable consume) is the runtime store, which is already statically imported above; the
// durable I-02 journal is additive and only wired when the compiled loop is present.
let _coordinatorPromise;
function loadCoordinator() {
  if (!_coordinatorPromise) {
    _coordinatorPromise = import("../../dist/operator-loop/index.js").catch(() => ({
      // Inline fallback broker: the coordinator never authorizes — it only echoes the digest the
      // human saw into the envelope. Journalling is a no-op until the compiled loop (+ I-02) is present.
      brokerDecision: (projection, decision) => ({
        handle: projection.handle,
        decision,
        digest: projection.digest,
        brokeredAt: new Date().toISOString(),
      }),
      notifyDeepLink: (ask) => ({
        handle: ask.handle,
        deepLink: ask.deepLink,
        at: new Date().toISOString(),
        lane: "notify-deep-link",
      }),
      // No compiled journal writer available → no durable journal sink (uniform call sites below).
      createDurableCapabilityJournal: () => undefined,
    }));
  }
  return _coordinatorPromise;
}

if (
  !existsSync(path.join(repo, "aios.yaml")) &&
  !existsSync(path.join(repo, "workspace.yaml")) &&
  !existsSync(path.join(repo, "project.yaml")) &&
  !existsSync(path.join(repo, "engagement.yaml"))
) {
  console.error(
    `error: ${repo} does not look like an AIOS workspace (no aios.yaml/workspace.yaml)`
  );
  process.exit(1);
}

// The desktop shell (Tauri) can pre-set the session token so it doesn't have to
// parse it back out of stdout; otherwise we mint a random one (the dev/CLI path).
const TOKEN = process.env.AIOS_GUI_TOKEN || randomBytes(16).toString("hex");

// The consuming session's capability audience/epoch for scoped-confirm decisions (I-14). SERVER-supplied
// (never from the client body), so I-03's audience/session binding + key/session rotation are enforced at
// consume time. Unset by default → a null-audience/null-epoch handle (today's issuance) consumes normally,
// while an audience/epoch-bound handle requires the coordinator to present the matching value.
const CAP_SESSION = {
  audience: (process.env.AIOS_GUI_CAP_AUDIENCE || "").trim() || undefined,
  epoch: (process.env.AIOS_GUI_CAP_EPOCH || "").trim() || undefined,
};

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/api/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ repo }));
  }
  if (url.pathname === "/api/catalog") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(readCatalog(repo)));
  }
  // ── agent config: model (+ personality, Phase 4) — token-gated ──
  if (url.pathname === "/api/config" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    const cfg = readAgentConfig(repo);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        model: cfg.model,
        personality: cfg.personality,
        runtime: cfg.runtime,
        memoryReview: cfg.memoryReview,
        models: [...ALLOWED_MODELS],
        // Additive: same capability descriptor the `hello` event carries, so the
        // cockpit can drive capability-gated chrome from config BEFORE the first
        // WebSocket hello — closing the pre-connect flash on non-Claude runtimes.
        capabilities: runtimeCapabilities(cfg.runtime, MODEL_OPTIONS),
      })
    );
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
    req.on("end", () => {
      let model = "";
      try {
        model = String(JSON.parse(body || "{}").model || "");
      } catch {
        /* bad body */
      }
      if (!ALLOWED_MODELS.has(model)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            ok: false,
            error: `model must be one of: ${[...ALLOWED_MODELS].join(", ")}`,
          })
        );
      }
      try {
        setAiosKey(repo, "agent_model", model);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, model }));
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
  // Reshapes the shared 30-day analyze snapshot (analysis-cache.mjs — AIO-453:
  // 60s fresh window, stale-while-revalidate, single-flight). CE stays SHADOW.
  if (url.pathname === "/api/maturity") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    analysisCache
      .get()
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
  // Reshapes the SAME shared 30-day analyze snapshot's per-provider cost blocks
  // for the cockpit, resolving each provider to ACTUAL spend only (owner config >
  // billing API > detected subscription > unknown — never a token estimate).
  // Owner overrides come from <repo>/.aios/cost-config.json.
  if (url.pathname === "/api/costs") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    analysisCache
      .get()
      .then(({ raw, ...meta }) => {
        const payload = { ...buildCostsPayload(raw, { config: readCostConfig(repo) }), ...meta };
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
      req.on("data", (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on("end", () => {
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
  // ── unified inbox comms section (token-gated) — I-14 / AIO-395 ──
  // GET /api/inbox → the I-09 ranked queue plus honest GUI ingestion freshness. Occurrence-based
  // read-model staleness is intentionally not published as ingestion freshness. `?raw=1` keeps raw order.
  // Admin-tier local state — nothing here syncs to the Team Brain.
  if (url.pathname === "/api/inbox" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    const raw = /^(1|true|raw)$/i.test(url.searchParams.get("raw") || "");
    getInboxView(repo, { raw, refresh: inboxRefresher.snapshot() })
      .then((view) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(view));
      })
      .catch((e) => {
        res.writeHead(e.statusCode || 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }
  // POST /api/inbox/:id/decision → the ONLY mutating call: scoped-confirmation over an I-03 capability
  // handle. Body carries ONLY { handle, digest, decision }; the owning runtime validates + consumes.
  // Matched BEFORE the generic detail route ([^/]+ can't span the trailing "/decision").
  const inboxDecision = url.pathname.match(/^\/api\/inbox\/([^/]+)\/decision$/);
  if (inboxDecision && req.method === "POST") {
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
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        /* bad body → decideInbox returns a 400 */
      }
      decideInbox(repo, decodeURIComponent(inboxDecision[1]), payload, CAP_SESSION)
        .then(({ status, ...rest }) => {
          res.writeHead(status || 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rest));
        })
        .catch((e) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        });
    });
    return;
  }
  const inboxAskAction = url.pathname.match(/^\/api\/inbox\/([^/]+)\/(reply|archive)$/);
  if (inboxAskAction && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 20_000) req.destroy();
    });
    req.on("end", () => {
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        /* action returns its own 400 */
      }
      const [, encodedId, action] = inboxAskAction;
      const operation =
        action === "reply"
          ? replyInboxAsk(repo, decodeURIComponent(encodedId), payload, {
              query: sdkQuery,
              getSessionInfo: sdkGetSessionInfo,
            })
          : archiveInboxAsk(repo, decodeURIComponent(encodedId));
      operation
        .then((result) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch((e) => {
          res.writeHead(e.statusCode || 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message, code: e.errorCode }));
        });
    });
    return;
  }
  // GET /api/inbox/:id → one item's detail + any pending capability approvals to scoped-confirm from it.
  const inboxDetail = url.pathname.match(/^\/api\/inbox\/([^/]+)$/);
  if (inboxDetail && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    getInboxDetail(repo, decodeURIComponent(inboxDetail[1]))
      .then((detail) => {
        res.writeHead(detail.item ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(detail));
      })
      .catch((e) => {
        res.writeHead(e.statusCode || 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
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
        patch = {};
      try {
        const j = JSON.parse(body || "{}");
        rowKey = typeof j.row_key === "string" ? j.row_key : "";
        patch = j.patch && typeof j.patch === "object" ? j.patch : {};
      } catch {
        /* bad body */
      }
      if (!rowKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "row_key is required" }));
      }
      const file = resolveTasksFile(repo);
      if (!file) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "no tasks.md in this workspace" }));
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
  // ── connector engine (token-gated) ──
  if (url.pathname === "/api/connectors") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ connectors: listConnectors(repo) }));
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
    // refresh from the brain, then return the (now team-aware) connectors
    runAios(["pull", "blueprint"], (err, out, stderr) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: !err,
          blueprint: readBlueprint(repo),
          connectors: listConnectors(repo),
          note: err ? stripAnsi((stderr || "") + (out || "")) : null,
        })
      );
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
    (async () => {
      try {
        const d = getDescriptor(repo, id);
        const cfg = resolveBrainConfig(repo);
        if (!cfg.brain_url || !cfg.api_key) {
          res.writeHead(503, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "no_brain_connection" }));
        }
        const result =
          action === "start" ? await startOAuth(d, cfg) : await checkOAuthStatus(d, cfg);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
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
      // Secrets arrive here in the POST body and are held in memory only — never logged,
      // never written to .sessions; only persisted (encrypted) by storeConnector.
      let secrets = {};
      try {
        secrets = JSON.parse(body || "{}").secrets || {};
      } catch {
        /* bad body */
      }
      (async () => {
        try {
          const d = getDescriptor(repo, id);
          if (action === "unwire") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(unwireConnector(repo, d)));
          }
          if (action === "store-existing") {
            const existing = await storeExistingConnector(repo, d);
            res.writeHead(existing.ok ? 200 : 422, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(existing));
          }
          if (action === "store" && d.auth_mode === "oauth") {
            const cfg = resolveBrainConfig(repo);
            if (!cfg.brain_url || !cfg.api_key) {
              res.writeHead(503, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: false, error: "no_brain_connection" }));
            }
            try {
              const stored = await storeOAuthConnector(repo, d, cfg);
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: true, ...stored }));
            } catch (e) {
              if (e.code === "oauth_not_connected") {
                res.writeHead(422, { "Content-Type": "application/json" });
                return res.end(
                  JSON.stringify({ ok: false, error: "oauth_not_connected", message: e.message })
                );
              }
              throw e;
            }
          }
          const result = await validateConnector(d, secrets);
          if (action === "validate") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(result)); // checks/identity/instance — no secrets
          }
          // store: only persist on a passing validation
          if (!result.ok) {
            res.writeHead(422, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, validation: result }));
          }
          const stored = storeConnector(repo, d, { ...secrets, ...(result.captured || {}) });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              ...stored,
              identity: result.identity,
              instance: result.instance,
            })
          );
        } catch (e) {
          res.writeHead(e.code === "credential_missing" ? 422 : 500, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      })();
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
const AIOS_CLI = path.join(SCRIPT_DIR, "..", "..", "scripts", "aios.mjs");
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

// Shared 30-day analysis cache behind /api/maturity + /api/costs (AIO-453).
// One `aios analyze --json --since 30d` snapshot serves both routes; the last-good
// snapshot persists under .aios/gui/ (admin-tier, local-only — never synced).
const analysisCache = createAnalysisCache({
  exec: (signal) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [AIOS_CLI, "analyze", "--json", "--since", "30d", "--repo", repo],
        { cwd: repo, maxBuffer: 10 * 1024 * 1024, signal }, // abort kills the child
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
    }),
  snapshotFile: path.join(repo, ".aios", "gui", "analysis-snapshot.json"),
  log: (msg) => console.error(msg),
});

// Keys the GUI is allowed to write into aios.yaml. Callers validate the VALUE
// (model ∈ ALLOWED_MODELS; personality ∈ scanned dir) before calling.
const AIOS_WRITABLE_KEYS = new Set(["agent_model", "agent_personality", "memory_review"]);

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

// Scan .claude/personalities/ → [{ id, name, description }]. id is the filename
// stem (already constrained to safe chars by the scan); used by the picker + to
// validate a personality write.
function listPersonalities(repoDir) {
  const dir = path.join(repoDir, ".claude", "personalities");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const id = f.replace(/\.md$/, "");
    if (!/^[a-z0-9-]+$/.test(id)) continue;
    let fm = {};
    try {
      fm = frontmatter(readFileSync(path.join(dir, f), "utf8"));
    } catch {
      /* skip */
    }
    out.push({ id, name: fm.name || id, description: firstSentence(fm.description || "") });
  }
  return out;
}

// Surface the workspace's skills + integrations to the GUI. Reuses the same robust
// parser gen-catalog.mjs uses, so the GUI is accurate without a separate build step.
function readCatalog(repoDir) {
  const skills = readSkills(repoDir).map((s) => ({
    name: s.name,
    kind: s.kind,
    description: firstSentence(s.description),
  }));
  return { skills, integrations: readIntegrations(repoDir) };
}

// ── websocket: one connection = one SDK session ─────────────────────────────
const wss = new WebSocketServer({ noServer: true });

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
  const resumeId =
    UUID_RE.test(wanted) && existsSync(path.join(SESSIONS_DIR, `${wanted}.jsonl`)) ? wanted : null;
  const sessionId = resumeId || randomUUID();
  const transcript = path.join(SESSIONS_DIR, `${sessionId}.jsonl`); // append; resume continues the same file
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
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* closed */
    }
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
    });
    const allow = await new Promise((resolve) => {
      pending.set(id, resolve);
      // auto-deny after 5 minutes so a closed tab can't wedge the run
      setTimeout(
        () => {
          if (pending.has(id)) {
            pending.delete(id);
            resolve(false);
          }
        },
        5 * 60 * 1000
      ).unref?.();
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
    send({ type: "permission_request", id, tool: title, input: content, options });
    return new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(
        () => {
          if (pending.has(id)) {
            pending.delete(id);
            resolve(null);
          }
        },
        5 * 60 * 1000
      ).unref?.();
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
  const capabilities = runtimeCapabilities(runtime, MODEL_OPTIONS);
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

  ws.on("close", () => {
    ac.abort();
    if (wake) {
      wake();
      wake = null;
    } // unpark the input iterator so it returns
    // resolve any pending approvals as denied so the adapter loop can finish
    for (const resolve of pending.values()) resolve(false);
    pending.clear();
  });
});

const inboxRefresher = createInboxRefresher({ repo });
installInboxRefreshShutdown({ refresher: inboxRefresher, server, webSocketServer: wss });

server.listen(port, "127.0.0.1", () => {
  inboxRefresher.start();
  console.log("");
  console.log("  aios-workspace GUI");
  console.log(`  repo:  ${repo}`);
  console.log(`  open:  http://127.0.0.1:${port}/?token=${TOKEN}`);
  console.log("");
  console.log("  (localhost only — do not expose this port)");
});
