// workspace-markers.mjs — the ONE definition of "what makes a directory an AIOS workspace"
// (AIO-600 C5, run-gui marker contract).
//
// A directory is treated as a scaffolded workspace when at least one of these files exists at its
// root. Consumed by BOTH sides of the gui↔toolkit seam so the lists can never drift:
//   • scripts/run-gui.mjs (core launcher) — fail-fast before the client build
//   • gui/server/index.mjs (GUI server) — startup check
// Core imports it by RELATIVE path (bare-checkout safe, same convention as scripts/runtimes.mjs);
// the GUI imports the published bare specifier `@aiosbrain/foundation/workspace-markers`, which
// survives the repo cut as an npm dependency. See docs/gui-toolkit-contract.md.

export const WORKSPACE_MARKERS = ["aios.yaml", "workspace.yaml", "project.yaml", "engagement.yaml"];
