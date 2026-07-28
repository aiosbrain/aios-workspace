// Agent-config route logic (AIO-536): per-runtime model catalogs, the model /
// runtime writes, and the capability payload.
//
// This lives OUTSIDE index.mjs on purpose. index.mjs boots an HTTP server at import
// time, so nothing in it can be unit-tested in-process; these handlers are the part
// that decides **which models and runtimes can be selected and what may be written
// to aios.yaml**, so they get direct tests rather than only end-to-end coverage.
//
// Handlers are transport-free: they take plain inputs and return
// `{ status, body }`. index.mjs owns the token check, body reading, and res.writeHead.

import {
  GUI_RUNTIMES,
  runtimeCapabilities,
  modelCatalog,
  isModelAllowed,
  modelRejectionMessage,
} from "../../scripts/runtimes.mjs";
import { cachedProviderCatalog, resolveProviderCatalog } from "./runtime-adapters/opencode.mjs";

// Cold `opencode serve` boot + provider fetch is ~5s; past this we serve the seeded
// catalog and let the background resolve populate the cache for the next read.
export const CATALOG_WAIT_MS = 8000;

/**
 * Build the catalog resolvers bound to one workspace.
 *
 * `catalogNow` never blocks (used by the WebSocket hello, which must not wait on a
 * server boot); `catalogFor` waits briefly for a live resolve. Only the opencode
 * runtime has a dynamic catalog — every other runtime resolves synchronously to its
 * static registry entry, which is what keeps the claude-code path unchanged.
 */
export function createCatalogResolver(repo, { waitMs = CATALOG_WAIT_MS, resolve, cached } = {}) {
  const readCached = cached ?? cachedProviderCatalog;
  const doResolve = resolve ?? resolveProviderCatalog;

  const catalogNow = (runtime) => {
    if (runtime !== "opencode") return modelCatalog(runtime);
    const hit = readCached(repo);
    if (!hit) doResolve(repo).catch(() => {}); // warm it for the next read
    return modelCatalog(runtime, hit);
  };

  const catalogFor = async (runtime) => {
    if (runtime !== "opencode") return modelCatalog(runtime);
    const hit = readCached(repo);
    if (hit) return modelCatalog(runtime, hit);
    const models = await Promise.race([
      doResolve(repo).catch(() => []),
      new Promise((r) => setTimeout(() => r(null), waitMs).unref?.()),
    ]);
    return modelCatalog(runtime, models);
  };

  return { catalogNow, catalogFor };
}

/**
 * GET /api/config → the ACTIVE runtime's catalog.
 *
 * The body shape is deliberately unchanged from before AIO-536 (no new keys), so a
 * claude-code workspace sees a byte-identical response. Runtime *choices* are served
 * by GET /api/config/runtime instead.
 */
export async function getConfig({ cfg, catalogFor }) {
  const catalog = await catalogFor(cfg.runtime);
  return {
    status: 200,
    body: {
      model: cfg.model,
      personality: cfg.personality,
      runtime: cfg.runtime,
      memoryReview: cfg.memoryReview,
      models: catalog.models.map((m) => m.id),
      capabilities: runtimeCapabilities(cfg.runtime, catalog.models),
    },
  };
}

/**
 * POST /api/config/model → persist `agent_model`, validated against the active
 * runtime's catalog. claude-code is a closed list; opencode additionally accepts any
 * well-formed `provider/model` id because ITS auth store — not this allow-list —
 * decides what actually resolves. The 400 names the runtime.
 *
 * "Active" means the runtime in aios.yaml, NOT a live session's pinned runtime: this
 * route only PERSISTS the default. The real mid-session switch travels on the
 * WebSocket (`user_message.model`) and is never gated here — so after a runtime
 * switch, persisting the old runtime's model is correctly refused (it would leave
 * aios.yaml self-inconsistent) while the live session keeps switching freely.
 */
export async function postModel({ model, runtime, catalogFor, setKey }) {
  const catalog = await catalogFor(runtime);
  if (!isModelAllowed(catalog, model)) {
    return { status: 400, body: { ok: false, error: modelRejectionMessage(catalog) } };
  }
  try {
    setKey("agent_model", model);
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
  return { status: 200, body: { ok: true, model } };
}

/** GET /api/config/runtime → the configured runtime + the GUI-drivable choices. */
export function getRuntime({ runtime }) {
  return {
    status: 200,
    body: {
      runtime,
      // Only GUI-drivable runtimes are offered. `claude-api` is deliberately absent
      // (gui: null in the registry — a bare API loop with no tool harness).
      runtimes: Object.keys(GUI_RUNTIMES).map((id) => ({ id, driver: GUI_RUNTIMES[id].driver })),
    },
  };
}

/**
 * POST /api/config/runtime → persist `agent_runtime`, enumerated against the
 * registry so this can never become a free-form aios.yaml write. A switch applies to
 * the NEXT chat: a live session pinned its runtime at hello.
 */
export function postRuntime({ runtime, setKey }) {
  if (!Object.prototype.hasOwnProperty.call(GUI_RUNTIMES, runtime)) {
    return {
      status: 400,
      body: { ok: false, error: `runtime must be one of: ${Object.keys(GUI_RUNTIMES).join(", ")}` },
    };
  }
  try {
    setKey("agent_runtime", runtime);
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
  return { status: 200, body: { ok: true, runtime, appliesTo: "next-chat" } };
}
