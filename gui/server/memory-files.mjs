// memory-files.mjs — single source of truth for the two volatile memory files.
//
// Shared by:
//   - runtime-adapters/claude-code.mjs  (reads/sanitizes/injects them at session start)
//   - memory-reviewer.mjs               (the background reviewer appends learned facts)
//
// The background reviewer NEVER edits the seed/explicit content a human or the
// onboarding skill wrote. It only manages a single append-only block at the end of
// the file, fenced by LEARNED_MARKER. That keeps writes deterministic (no field
// parsing), reversible, and impossible to reshape the rest of the file.

export const MEMORY_FILES = [
  { file: "USER.md", label: "USER (the person)", cap: 1500 },
  { file: "WORKSPACE.md", label: "WORKSPACE (company, environment, tooling)", cap: 2000 },
];

// Allowed `section` tags per file. A reviewer-proposed fact whose (file, section)
// pair isn't in here is dropped — the model can't invent destinations.
export const SECTIONS = {
  "USER.md": ["role", "goals", "preferences", "comms"],
  "WORKSPACE.md": ["company", "environment", "tooling"],
};

// The reviewer's managed block lives below this marker. It is an HTML comment, so
// claude-code.mjs's sanitizeMemory() strips the marker itself from what's injected
// — but the learned bullets beneath it remain (they're the point).
export const LEARNED_MARKER =
  "<!-- reviewer:learned (auto, conservative — edit above this line) -->";

export const byFile = (name) => MEMORY_FILES.find((m) => m.file === name) || null;

// Baseline sentinel: the file did NOT exist at session start. If it appears later
// (created mid-session by something else), the reviewer treats that as "dirty" and
// skips — it only ever writes files it observed and owns from the start.
export const MEMORY_ABSENT = Symbol("memory-absent-at-session-start");
