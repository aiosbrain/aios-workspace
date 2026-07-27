// OpenCode adapter — drives the session against a spawned `opencode serve` (a
// headless HTTP server with a global Server-Sent-Events stream). One server per
// workspace process, scoped to the repo (cwd) and reaped on exit.
//
// NATIVE-runtime governance tier (same as Codex): OpenCode executes its own file
// writes in-process, so the host can't pre-gate them. Mitigation is the shared
// POST-TURN SWEEP over files the turn changed (violations/truncation → blocking
// error, and they taint the turn result). The hello.safetyNote banner discloses
// the post-hoc tier.
//
// Wire protocol notes:
//   - The SSE stream at GET /event is GLOBAL (all sessions interleaved), so we
//     filter every event by our sessionID.
//   - Node has no `EventSource`, so we parse SSE frames from a raw fetch stream.
//   - A turn is sent with POST /session/{id}/message (synchronous: resolves when
//     the turn completes); deltas/tool-calls/permissions arrive over the SSE.
//
// Adapter contract: export `meta` + `run(host)`. See runtime-adapters/index.mjs.

import { spawn } from "node:child_process";
import { postTurnSweep, SWEEP_MAX_FILES } from "./sweep.mjs";

export const meta = { driver: "opencode" };

// ── pure event mapping (opencode SSE event → WS event shapes) ─────────────────
// Exported for the contract test. Only events for `sessionId` produce output
// (the stream is global). Tool lifecycle: tool_use on "running", tool_result on
// "completed"/"error". Turn-end (session.idle) + permissions are owned by run().

function partSessionId(ev) {
  return ev?.properties?.part?.sessionID ?? ev?.properties?.sessionID;
}

/** Map one opencode SSE event to zero or more WS events. Pure + side-effect free. */
export function mapOpencodeEvent(event, sessionId) {
  if (!event || typeof event !== "object") return [];
  if (sessionId && partSessionId(event) && partSessionId(event) !== sessionId) return []; // other session

  switch (event.type) {
    case "message.part.updated": {
      const part = event.properties?.part;
      if (!part) return [];
      if (part.type === "text") {
        // `delta` is the incremental text; ignore full-text re-sends to avoid dupes.
        const d = event.properties.delta;
        return d ? [{ type: "delta", text: d }] : [];
      }
      if (part.type === "tool") {
        const st = part.state || {};
        if (st.status === "running") {
          return [
            { type: "tool_use", name: part.tool || "tool", input: st.input ?? {}, id: part.callID },
          ];
        }
        if (st.status === "completed") {
          return [
            {
              type: "tool_result",
              id: part.callID,
              text: String(st.output ?? "").slice(0, 4000),
              is_error: false,
            },
          ];
        }
        if (st.status === "error") {
          return [
            {
              type: "tool_result",
              id: part.callID,
              text: String(st.error ?? "").slice(0, 4000),
              is_error: true,
            },
          ];
        }
      }
      return [];
    }
    case "session.error": {
      const e = event.properties?.error;
      const msg = e?.data?.message || e?.name || (typeof e === "string" ? e : "opencode error");
      return [{ type: "error", message: msg }];
    }
    // session.idle (turn end) + permission.updated are handled by run().
    default:
      return [];
  }
}

// `opencode serve` uses HTTP Basic auth (username "opencode") when
// OPENCODE_SERVER_PASSWORD is set — Bearer is rejected with 401. Returns {} when
// no password is configured. Exported for the auth-header unit test.
export function authHeader(password) {
  if (!password) return {};
  return { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

// ── model catalog (AIO-536) ──────────────────────────────────────────────────
//
// OpenCode brokers whatever providers the owner authenticated in ITS OWN auth store
// (OpenRouter, OpenAI, Anthropic, …). The server exposes them at GET /config/providers.
//
// SECURITY: that payload embeds each provider's plaintext API `key`. We project ONLY
// {id, label, group} out of it — the raw response never leaves this function, is never
// logged, and is never written to aios.yaml.

/** `providerID` + `modelID` → the flat `provider/model` id used everywhere else. */
function catalogModelId(providerId, modelId) {
  return `${providerId}/${modelId}`;
}

/**
 * Project GET /config/providers → [{id,label,group}], grouped (sorted) by provider.
 * Pure + defensive: any unexpected shape yields [] so the caller falls back to the
 * seeded catalog rather than rendering a broken picker.
 */
export function mapProviderCatalog(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  const out = [];
  for (const p of providers) {
    const providerId = typeof p?.id === "string" ? p.id : null;
    if (!providerId) continue;
    const providerLabel = typeof p?.name === "string" && p.name ? p.name : providerId;
    // `models` is a map of modelID → model descriptor (arrays tolerated too).
    const models = Array.isArray(p?.models) ? p.models : Object.values(p?.models ?? {});
    for (const m of models) {
      const modelId = typeof m?.id === "string" ? m.id : null;
      if (!modelId) continue;
      if (m?.status === "deprecated") continue;
      out.push({
        id: catalogModelId(providerId, modelId),
        label: typeof m?.name === "string" && m.name ? m.name : modelId,
        group: providerLabel,
      });
    }
  }
  out.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  return out;
}

/**
 * Boot a short-lived `opencode serve`, hand its base URL to `fn`, and always reap it.
 * Used for one-shot reads (the model catalog) outside a chat session. Resolves to
 * `fallback` on any failure — a missing / broken OpenCode install must degrade the
 * picker, never throw into the config route.
 */
async function withOpencodeServer(fn, { cwd, timeoutMs = 15000, fallback = null } = {}) {
  let child;
  try {
    child = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return fallback;
  }
  child.on("error", () => {
    /* ENOENT — the boot promise resolves null below */
  });
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* */
    }
  }, timeoutMs);
  timer.unref?.();
  try {
    const baseUrl = await new Promise((resolve) => {
      let buf = "";
      const onData = (d) => {
        buf += d;
        const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) {
          child.stdout.off("data", onData);
          resolve(m[0]);
        }
      };
      child.stdout?.on("data", onData);
      child.on("close", () => resolve(null));
      child.on("error", () => resolve(null));
    });
    if (!baseUrl) return fallback;
    return await fn(baseUrl);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    try {
      child.kill("SIGTERM");
    } catch {
      /* */
    }
  }
}

/**
 * Read the live provider/model catalog from a running OpenCode server.
 * Returns [] (never throws) when the endpoint is missing or unparseable, which the
 * caller reads as "use the seeded fallback".
 */
export async function fetchProviderCatalog(baseUrl, { fetchImpl = fetch, headers = {} } = {}) {
  try {
    const res = await fetchImpl(`${baseUrl}/config/providers`, { headers });
    if (!res?.ok) return [];
    return mapProviderCatalog(await res.json());
  } catch {
    return [];
  }
}

// Catalog cache: booting a server per /api/config call would make the settings page
// crawl. One resolve is shared by all in-flight callers and reused for CATALOG_TTL_MS.
const CATALOG_TTL_MS = 5 * 60 * 1000;
const catalogCache = new Map(); // repo → { at, models }
const catalogInflight = new Map(); // repo → Promise

/** Cached models for `repo`, or null when nothing has resolved yet (→ seeded fallback). */
export function cachedProviderCatalog(repo) {
  const hit = catalogCache.get(repo);
  if (!hit || Date.now() - hit.at > CATALOG_TTL_MS) return null;
  return hit.models;
}

/**
 * Resolve the live catalog for `repo`, caching the result. Concurrent callers share
 * one server boot. `[]` means "unavailable" — callers fall back to the seeded list.
 */
export function resolveProviderCatalog(repo, { fetchImpl = fetch } = {}) {
  const fresh = cachedProviderCatalog(repo);
  if (fresh) return Promise.resolve(fresh);
  const running = catalogInflight.get(repo);
  if (running) return running;
  const headers = authHeader(process.env.OPENCODE_SERVER_PASSWORD);
  const p = withOpencodeServer((baseUrl) => fetchProviderCatalog(baseUrl, { fetchImpl, headers }), {
    cwd: repo,
    fallback: [],
  })
    .then((models) => {
      // Only cache a real answer; a failed probe should be retried on the next call.
      if (models.length) catalogCache.set(repo, { at: Date.now(), models });
      return models;
    })
    .catch(() => [])
    .finally(() => catalogInflight.delete(repo));
  catalogInflight.set(repo, p);
  return p;
}

/** Test seam: drop cached catalogs so a test can re-resolve. */
export function _resetCatalogCache() {
  catalogCache.clear();
  catalogInflight.clear();
}

/**
 * Read the session's AUTHORITATIVE cumulative cost from the OpenCode server
 * (GET /session/{id} → `cost`, a number). Returns null on any failure or a
 * non-finite value — we never estimate a cost.
 */
export async function readSessionCost(
  baseUrl,
  sessionId,
  { fetchImpl = fetch, headers = {} } = {}
) {
  try {
    const res = await fetchImpl(`${baseUrl}/session/${sessionId}`, { headers });
    if (!res?.ok) return null;
    const cost = (await res.json())?.cost;
    return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
  } catch {
    return null;
  }
}

/**
 * `provider/model` → the `{providerID, modelID}` body opencode expects, split at the
 * FIRST slash so a nested model id survives (`openrouter/qwen/qwen3.7-plus` →
 * `{providerID:"openrouter", modelID:"qwen/qwen3.7-plus"}`). Returns undefined for an
 * empty/malformed id, which means "let opencode use its own default".
 */
export function splitModel(id) {
  if (typeof id !== "string") return undefined;
  const i = id.indexOf("/");
  if (i <= 0 || i >= id.length - 1) return undefined;
  return { providerID: id.slice(0, i), modelID: id.slice(i + 1) };
}

// Parse the chosen permission optionId → opencode's response vocabulary.
function toPermissionResponse(choice) {
  if (choice === "once" || choice === "always" || choice === "reject") return choice;
  return "reject"; // non-string (cancelled / tab closed / timeout) → deny
}

const PERMISSION_OPTIONS = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

/**
 * @param {object} host  see runtime-adapters/index.mjs — repo, input, emit,
 *   requestPermission, guardWrite, signal, model ("providerID/modelID").
 */
export async function run(host) {
  const { repo, input, emit, requestPermission, guardWrite, signal, model } = host;

  // 1. Spawn a headless opencode server scoped to the repo (random free port).
  const child = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrTail = "";
  let spawnError = null;
  child.stderr?.on("data", (d) => {
    stderrTail = (stderrTail + d).slice(-2000);
  });
  child.on("error", (e) => {
    spawnError = e;
  });

  const ac = new AbortController(); // aborts SSE + in-flight fetches
  let baseUrl = null;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try {
      ac.abort();
    } catch {
      /* */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* */
    }
  };
  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener?.("abort", onAbort, { once: true });

  // Wait for "listening on http://127.0.0.1:PORT".
  baseUrl = await new Promise((resolve) => {
    let buf = "";
    const onData = (d) => {
      buf += d;
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        child.stdout.off("data", onData);
        resolve(m[0]);
      }
    };
    child.stdout.on("data", onData);
    child.on("close", () => resolve(null));
    setTimeout(() => resolve(baseUrl), 20000).unref?.(); // give up after 20s
  });
  if (!baseUrl) {
    if (aborted) return;
    const enoent = spawnError?.code === "ENOENT";
    emit({
      type: "error",
      message: enoent
        ? "agent_runtime 'opencode' selected but 'opencode' is not on PATH. Install OpenCode, then retry."
        : `failed to start 'opencode serve'${stderrTail ? `: ${stderrTail.trim().slice(-400)}` : ""}`,
    });
    try {
      child.kill("SIGKILL");
    } catch {
      /* */
    }
    return;
  }

  const authHeaders = authHeader(process.env.OPENCODE_SERVER_PASSWORD);
  const json = (extra) => ({ "Content-Type": "application/json", ...authHeaders, ...extra });

  // 2. Create a session.
  let sessionId;
  try {
    const res = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: json(),
      body: "{}",
      signal: ac.signal,
    });
    sessionId = (await res.json())?.id;
    if (!sessionId) throw new Error("no session id");
  } catch (e) {
    if (aborted) return;
    emit({
      type: "error",
      message: `opencode: failed to create session (${String(e?.message || e)})`,
    });
    try {
      child.kill("SIGKILL");
    } catch {
      /* */
    }
    return;
  }

  // 3. Consume the GLOBAL SSE stream (raw fetch — no EventSource in Node). Each
  //    frame is `data: <json>\n\n`. Filter to our session; drive permissions.
  //    `session.idle` is the authoritative turn-end; `session.error` taints it.
  const handledPerms = new Set();
  let turnErrored = false; // set by any session.error for our session this turn
  let onIdle = null; // resolves the current turn's idle wait
  const forUs = (ev) => {
    const s = ev.properties?.sessionID;
    return !s || s === sessionId;
  };
  async function handleEvent(ev) {
    if (ev.type === "session.idle" && ev.properties?.sessionID === sessionId) {
      onIdle?.();
      return;
    }
    if (ev.type === "session.error" && forUs(ev)) turnErrored = true; // fall through to emit it too
    if (ev.type === "permission.updated") {
      const p = ev.properties;
      if (!p || p.sessionID !== sessionId || handledPerms.has(p.id)) return;
      handledPerms.add(p.id);
      const choice = await requestPermission({
        title: p.title || p.type || "permission",
        content: p.metadata ?? {},
        options: PERMISSION_OPTIONS,
      });
      try {
        await fetch(`${baseUrl}/session/${sessionId}/permissions/${p.id}`, {
          method: "POST",
          headers: json(),
          body: JSON.stringify({ response: toPermissionResponse(choice) }),
          signal: ac.signal,
        });
      } catch {
        /* server gone / aborted */
      }
      return;
    }
    for (const wsEvent of mapOpencodeEvent(ev, sessionId)) emit(wsEvent);
  }

  (async () => {
    let res;
    try {
      res = await fetch(`${baseUrl}/event`, { headers: authHeaders, signal: ac.signal });
    } catch {
      return;
    }
    const reader = res.body?.getReader?.();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          handleEvent(ev);
        }
      }
    } catch {
      /* aborted / stream ended */
    }
  })();

  // The model in force right now. Seeded from aios.yaml's agent_model and updated
  // per turn when the cockpit picker sends a different one (AIO-536) — opencode
  // takes the model per message, so a switch needs no reconnect.
  let activeModel = typeof model === "string" ? model : "";

  // 4. Turn loop: POST a message per user turn (synchronous — resolves at turn end).
  // `lastCost` tracks the session's cumulative cost as of the previous result, so each
  // turn reports its own delta. Both numbers come from the server; nothing is estimated.
  let lastCost = 0;
  try {
    for await (const turn of input) {
      if (aborted || signal?.aborted) break;
      const turnStart = Date.now();
      if (typeof turn.model === "string" && turn.model && turn.model !== activeModel) {
        activeModel = turn.model;
        emit({ type: "model", model: activeModel });
      }
      const modelBody = splitModel(activeModel);
      turnErrored = false;
      let failed = false;
      // Resolve when the session goes idle (true turn-end), with a fallback so a
      // missing idle event can't wedge the turn.
      const idle = new Promise((r) => {
        onIdle = r;
      });
      try {
        const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
          method: "POST",
          headers: json(),
          body: JSON.stringify({
            parts: [{ type: "text", text: turn.text }],
            ...(modelBody ? { model: modelBody } : {}),
          }),
          signal: ac.signal,
        });
        if (!res.ok) {
          failed = true;
          emit({ type: "error", message: `opencode: message failed (HTTP ${res.status})` });
        }
        // Drain trailing events (a provider error often arrives as session.error
        // just after the POST resolves) before deciding the result.
        await Promise.race([idle, new Promise((r) => setTimeout(r, 4000).unref?.())]);
        emit({ type: "assistant_done" });
      } catch (e) {
        if (aborted || signal?.aborted) break;
        failed = true;
        emit({ type: "error", message: `opencode: prompt failed (${String(e?.message || e)})` });
      } finally {
        onIdle = null;
      }
      if (turnErrored) failed = true; // an SSE session.error during the turn taints it

      // Post-turn governance sweep (opencode writes files in-process).
      try {
        const { violations, truncated } = await postTurnSweep(repo, guardWrite, turnStart);
        for (const v of violations)
          emit({ type: "error", message: `post-turn guard: ${v.path} — ${v.reason}` });
        if (violations.length) failed = true;
        if (truncated) {
          emit({
            type: "error",
            message: `post-turn guard: workspace exceeds the ${SWEEP_MAX_FILES}-file sweep cap — some changes this turn were NOT validated. Review changes manually or run validation/validate-all.sh.`,
          });
          failed = true;
        }
      } catch (e) {
        emit({
          type: "error",
          message: `post-turn guard: sweep failed to run (${String(e?.message || e)}) — changes this turn were NOT validated.`,
        });
        failed = true;
      }

      // Authoritative per-turn cost: the server's cumulative session cost minus the
      // previous turn's. `null` on ANY read failure — never an estimate (AIO-536).
      let costUsd = null;
      const total = await readSessionCost(baseUrl, sessionId, { headers: authHeaders });
      if (total !== null) {
        costUsd = Math.max(0, total - lastCost);
        lastCost = total;
      }
      emit({ type: "result", subtype: failed ? "error" : "success", cost_usd: costUsd });
    }
  } finally {
    try {
      if (!aborted)
        await fetch(`${baseUrl}/session/${sessionId}/abort`, {
          method: "POST",
          headers: json(),
          body: "{}",
        });
    } catch {
      /* */
    }
    try {
      ac.abort();
    } catch {
      /* */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* */
    }
  }
}
