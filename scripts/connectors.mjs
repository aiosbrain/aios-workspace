/**
 * connectors.mjs — the top-level barrel for the built-in provider adapters (AIO-1067).
 *
 * The R1 boundary rule (scripts/check-boundaries.mjs) allows scripts/connectors/** to be
 * reached only through this barrel. Every export is a LAZY thunk on purpose: importing the
 * barrel must never import an adapter, so a broken adapter stays quarantined to its own
 * command surface (`aios help`/`version`/`doctor`/`provenance` and the Slack surface never
 * touch it — test/linear-adapter-quarantine.test.mjs proves it).
 */
export const loadLinearAdapter = () => import("./connectors/linear/index.mjs");
export const loadLinearSetup = () => import("./connectors/linear/setup.mjs");
export const loadLinearCredentials = () => import("./connectors/linear/credentials.mjs");
export const loadSlackAdapter = () => import("./connectors/slack/index.mjs");
