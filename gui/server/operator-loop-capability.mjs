// operator-loop-capability.mjs — the compiled operator loop as an OPTIONAL, reported capability
// (AIO-600 C5; grew out of index.mjs's I-03/I-07 + AIO-427 lazy loadCoordinator).
//
// The coordinator-side broker (brokerDecision / notifyDeepLink) and the durable-journal bridge
// (createDurableCapabilityJournal) live in the toolkit's COMPILED operator loop
// (<toolkit>/dist/operator-loop/index.js). The GUI server must start even when that dist has never
// been built (`npm run gui` before `npm run build:loop`), so absence degrades to an inline
// envelope broker with NO journalling — but absence is REPORTED, never silent: one log line at
// load + a `capabilities.operatorLoop` field on /api/info so the GUI can show
// "operator-loop capability unavailable". The AUTHORITY that matters (validate + durable consume)
// is the runtime capability store, statically imported by index.mjs; the durable I-02 journal is
// additive and only wired when the compiled loop is present.
//
// Resolution of the dist entry goes through the toolkit-location contract (toolkit-locate.mjs) —
// see docs/gui-toolkit-contract.md.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { getToolkit } from "./toolkit-locate.mjs";

// Inline fallback broker: the coordinator never authorizes — it only echoes the digest the human
// saw into the envelope. Journalling is a no-op until the compiled loop is present.
const FALLBACK = {
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
  // No compiled journal writer available → no durable journal sink (uniform call sites).
  createDurableCapabilityJournal: () => undefined,
};

/** Status surfaced on /api/info: "unknown" until the first load attempt settles. */
export const operatorLoopStatus = { status: "unknown", reason: null };

let _coordinatorPromise;
/**
 * Load the compiled coordinator once; resolve the FALLBACK (and mark the capability
 * unavailable, loudly) when the toolkit's dist/operator-loop is absent or unloadable.
 */
export function loadCoordinator() {
  if (!_coordinatorPromise) {
    const entry = path.join(getToolkit().dir, "dist", "operator-loop", "index.js");
    _coordinatorPromise = import(pathToFileURL(entry).href).then(
      (mod) => {
        operatorLoopStatus.status = "available";
        operatorLoopStatus.reason = null;
        return mod;
      },
      (e) => {
        operatorLoopStatus.status = "unavailable";
        operatorLoopStatus.reason = `compiled operator loop not loadable at ${entry} (${e.code || e.message}) — run \`npm run build:loop\` in the toolkit`;
        console.error(
          `[capability] operator-loop UNAVAILABLE: ${operatorLoopStatus.reason}. ` +
            `Degrading to the inline envelope broker (no durable capability journal).`
        );
        return FALLBACK;
      }
    );
  }
  return _coordinatorPromise;
}
