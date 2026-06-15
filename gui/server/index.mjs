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
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import { createAdapter, readAgentConfig } from "./runtime-adapters/index.mjs";
import { readSkills, readIntegrations, firstSentence } from "../../scripts/gen-catalog.mjs";
import { listConnectors, getDescriptor, validateConnector, storeConnector, unwireConnector, readBlueprint } from "../../scripts/connector.mjs";
import { writeFileSync as fsWriteFileSync, mkdirSync as fsMkdirSync } from "node:fs";

// Tools that run without a permission prompt (read-only + workspace edits — the
// PreToolUse guard hook still vets every Write/Edit for secrets and tier leaks).
// Bash and network/MCP tools fall through to an explicit prompt.
const AUTO_ALLOW = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "Task", "ExitPlanMode",
  "WebFetch", "WebSearch", "Write", "Edit", "MultiEdit", "NotebookEdit",
]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(SCRIPT_DIR, "..", "client", "dist");
const SESSIONS_DIR = path.join(SCRIPT_DIR, "..", ".sessions");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : dflt;
}
const repo = path.resolve(flag("--repo", process.cwd()));
const port = parseInt(flag("--port", "8790"), 10);

if (!existsSync(path.join(repo, "aios.yaml")) &&
    !existsSync(path.join(repo, "workspace.yaml")) &&
    !existsSync(path.join(repo, "project.yaml")) &&
    !existsSync(path.join(repo, "engagement.yaml"))) {
  console.error(`error: ${repo} does not look like an AIOS workspace (no aios.yaml/workspace.yaml)`);
  process.exit(1);
}

// The desktop shell (Tauri) can pre-set the session token so it doesn't have to
// parse it back out of stdout; otherwise we mint a random one (the dev/CLI path).
const TOKEN = process.env.AIOS_GUI_TOKEN || randomBytes(16).toString("hex");
mkdirSync(SESSIONS_DIR, { recursive: true });

// ── static client ───────────────────────────────────────────────────────────
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/api/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ repo, sessions: listSessions() }));
  }
  if (url.pathname === "/api/catalog") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(readCatalog(repo)));
  }
  // ── review-and-push panel (token-gated; mutating) ──
  if (url.pathname === "/api/review") {
    if (url.searchParams.get("token") !== TOKEN) { res.writeHead(401); return res.end("unauthorized"); }
    runAios(["status", "--json"], (err, out) => {
      res.writeHead(err ? 500 : 200, { "Content-Type": "application/json" });
      res.end(err ? JSON.stringify({ error: err.message }) : out);
    });
    return;
  }
  if (url.pathname === "/api/push" && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) { res.writeHead(401); return res.end("unauthorized"); }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let paths = [], dryRun = false;
      try { const j = JSON.parse(body || "{}"); paths = Array.isArray(j.paths) ? j.paths : []; dryRun = !!j.dryRun; } catch { /* bad body */ }
      if (!paths.length) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "no paths selected" })); }
      runAios(["push", ...paths, ...(dryRun ? ["--dry-run"] : [])], (err, out, stderr) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: !err, dryRun, output: stripAnsi((out || "") + (stderr || "")), error: err?.message || null }));
      });
    });
    return;
  }
  // ── connector engine (token-gated) ──
  if (url.pathname === "/api/connectors") {
    if (url.searchParams.get("token") !== TOKEN) { res.writeHead(401); return res.end("unauthorized"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ connectors: listConnectors(repo) }));
  }
  // ── team blueprint (token-gated) ──
  if (url.pathname === "/api/blueprint" && req.method === "GET") {
    if (url.searchParams.get("token") !== TOKEN) { res.writeHead(401); return res.end("unauthorized"); }
    // refresh from the brain, then return the (now team-aware) connectors
    runAios(["pull", "blueprint"], (err, out, stderr) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: !err,
        blueprint: readBlueprint(repo), connectors: listConnectors(repo),
        note: err ? stripAnsi((stderr || "") + (out || "")) : null,
      }));
    });
    return;
  }
  if (url.pathname === "/api/blueprint/publish" && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) { res.writeHead(401); return res.end("unauthorized"); }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => {
      let connectors = {};
      try { connectors = JSON.parse(body || "{}").connectors || {}; } catch { /* */ }
      try {
        fsMkdirSync(path.join(repo, ".aios"), { recursive: true });
        fsWriteFileSync(path.join(repo, ".aios", "team-blueprint.json"), JSON.stringify({ connectors }, null, 2));
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
  const conn = url.pathname.match(/^\/api\/connectors\/([a-z0-9-]+)\/(validate|store|unwire)$/);
  if (conn && req.method === "POST") {
    if (url.searchParams.get("token") !== TOKEN) { res.writeHead(401); return res.end("unauthorized"); }
    const [, id, action] = conn;
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => {
      // Secrets arrive here in the POST body and are held in memory only — never logged,
      // never written to .sessions; only persisted (encrypted) by storeConnector.
      let secrets = {};
      try { secrets = JSON.parse(body || "{}").secrets || {}; } catch { /* bad body */ }
      (async () => {
        try {
          const d = getDescriptor(repo, id);
          if (action === "unwire") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(unwireConnector(repo, d)));
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
          res.end(JSON.stringify({ ok: true, ...stored, identity: result.identity, instance: result.instance }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
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
  execFile(process.execPath, [AIOS_CLI, ...args, "--repo", repo], { cwd: repo, maxBuffer: 10 * 1024 * 1024 },
    (err, stdout, stderr) => cb(err, stdout, stderr));
}
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function listSessions() {
  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort()
      .reverse()
      .slice(0, 20);
  } catch {
    return [];
  }
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

wss.on("connection", (ws) => {
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  const transcript = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  const send = (obj) => {
    try { ws.send(JSON.stringify(obj)); } catch { /* closed */ }
    try { appendFileSync(transcript, JSON.stringify(obj) + "\n"); } catch { /* best-effort */ }
  };

  // Streaming-input generator fed by a queue: user turns arrive over WS.
  // Adapters consume { type:"user", text } turns (runtime-neutral).
  const queue = [];
  let wake = null;
  const pushUser = (text) => {
    queue.push({ type: "user", text });
    if (wake) { wake(); wake = null; }
  };
  async function* input() {
    for (;;) {
      while (queue.length) yield queue.shift();
      await new Promise((r) => (wake = r));
    }
  }

  // Pending interactive tool approvals: id → resolver
  const pending = new Map();
  let nextPermId = 1;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "user_message" && typeof msg.text === "string") {
      send({ type: "echo_user", text: msg.text });
      pushUser(msg.text);
    } else if (msg.type === "permission_response" && pending.has(msg.id)) {
      pending.get(msg.id)(!!msg.allow);
      pending.delete(msg.id);
    }
  });

  // Claude-style tool permission, server-owned so the WS prompt machinery is
  // shared across adapters: AUTO_ALLOW runs silently (the PreToolUse guard hook
  // still vets writes); other tools prompt. Returns the SDK { behavior } shape.
  const confirmClaudeTool = async (toolName, toolInput) => {
    if (AUTO_ALLOW.has(toolName)) return { behavior: "allow", updatedInput: toolInput };
    if (toolName === "AskUserQuestion") {
      return { behavior: "deny", message: "This chat can't render multiple-choice questions. Ask the user ONE short question at a time as a normal message and wait for their typed reply." };
    }
    const id = nextPermId++;
    send({ type: "permission_request", id, tool: toolName, input: toolInput });
    const allow = await new Promise((resolve) => {
      pending.set(id, resolve);
      // auto-deny after 5 minutes so a closed tab can't wedge the run
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve(false); }
      }, 5 * 60 * 1000).unref?.();
    });
    return allow
      ? { behavior: "allow", updatedInput: toolInput }
      : { behavior: "deny", message: "Denied in the GUI" };
  };

  // One adapter drives this session, selected by agent_runtime in aios.yaml
  // (default claude-code ⇒ unchanged). createAdapter fails loudly on an
  // unknown / non-GUI / not-yet-implemented runtime — never silent fallback.
  const { runtime, model, baseUrl } = readAgentConfig(repo);
  const ac = new AbortController();
  send({ type: "hello", repo, sessionId, runtime });

  (async () => {
    try {
      const adapter = createAdapter(runtime);
      await adapter.run({ repo, model, baseUrl, input: input(), emit: send, confirmClaudeTool, signal: ac.signal });
    } catch (e) {
      send({ type: "error", message: String(e?.message || e) });
    }
  })();

  ws.on("close", () => {
    ac.abort();
    // resolve any pending approvals as denied so the adapter loop can finish
    for (const resolve of pending.values()) resolve(false);
    pending.clear();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log("");
  console.log("  aios-workspace GUI");
  console.log(`  repo:  ${repo}`);
  console.log(`  open:  http://127.0.0.1:${port}/?token=${TOKEN}`);
  console.log("");
  console.log("  (localhost only — do not expose this port)");
});
