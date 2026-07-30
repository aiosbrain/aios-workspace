// adapter-contract.mjs — the GUI adapter-registry contract, core-owned (AIO-600 C5).
//
// Inverts the last toolkit→GUI code dependency: validation/check-runtime-adapters.mjs (OGR07) used
// to import gui/server/runtime-adapters/{index,guard}.mjs directly and assert against them inline.
// The assertions now live HERE as pure contract checks over an INJECTED registry/guard, so:
//   • core (OGR07) runs them against gui/server while the tree still contains it
//     (skip-when-absent during the transition), and
//   • gui/server runs the SAME checks in its own co-located test
//     (gui/server/runtime-adapters/adapter-contract.test.mjs), which travels with the repo cut.
// Post-cut the GUI consumes this module via the published `@aios-alpha/monorepo/adapter-contract`
// subpath; core keeps validating its own runtimes data. See docs/gui-toolkit-contract.md.
//
// Every check returns an ARRAY OF VIOLATION STRINGS (empty = contract satisfied) — callers decide
// how to report (OGR07 prints ✗ lines; the gui test asserts deepEqual([])).

import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/** Expectations about the claude-code adapter's model surface (contract data, not code). */
export const CLAUDE_CODE_EXPECTATIONS = {
  driver: "claude-sdk",
  defaultModel: "claude-sonnet-4-6",
  mustAllowModel: "claude-opus-4-8",
};

/**
 * Validate a GUI adapter registry (the module shape of gui/server/runtime-adapters/index.mjs:
 * `createAdapter(runtime)` + `readAgentConfig(repo)`) against the canonical runtimes data.
 *
 * Contract:
 *   • `createAdapter` resolves claude-code to an adapter with a callable `run()` and the pinned
 *     model defaults (CLAUDE_CODE_EXPECTATIONS).
 *   • every `gui: null` runtime in RUNTIMES throws "not GUI-drivable" — never a silent fallback.
 *   • an unknown runtime throws "unknown agent_runtime".
 *   • `readAgentConfig` defaults to runtime "claude-code" / personality "aios" without aios.yaml,
 *     and reads agent_runtime / agent_personality from a flat aios.yaml.
 *
 * @param {{createAdapter: Function, readAgentConfig: Function}} reg
 * @param {{RUNTIMES: object, GUI_RUNTIMES: object}} data canonical registry (…/runtimes)
 * @returns {string[]} violations (empty = pass)
 */
export function checkAdapterRegistry(reg, { RUNTIMES, GUI_RUNTIMES }) {
  const v = [];
  const expectThrow = (rt, needle) => {
    try {
      reg.createAdapter(rt);
      v.push(`createAdapter('${rt}') should have thrown (${needle})`);
    } catch (e) {
      if (!String(e.message).includes(needle))
        v.push(`createAdapter('${rt}') wrong error: ${e.message}`);
    }
  };

  try {
    const cc = reg.createAdapter("claude-code");
    if (typeof cc.run !== "function") v.push("claude-code adapter missing run()");
    if (cc.DEFAULT_MODEL !== CLAUDE_CODE_EXPECTATIONS.defaultModel)
      v.push(`claude-code DEFAULT_MODEL should be ${CLAUDE_CODE_EXPECTATIONS.defaultModel}`);
    if (!cc.ALLOWED_MODELS?.has(CLAUDE_CODE_EXPECTATIONS.mustAllowModel))
      v.push(
        `claude-code ALLOWED_MODELS should include ${CLAUDE_CODE_EXPECTATIONS.mustAllowModel}`
      );
  } catch (e) {
    v.push(`createAdapter('claude-code') threw: ${e.message}`);
  }

  // Data-driven: every non-GUI-drivable runtime in the canonical registry must throw, typed.
  for (const name of Object.keys(RUNTIMES)) {
    if (!RUNTIMES[name].gui) expectThrow(name, "not GUI-drivable");
    else if (!(name in GUI_RUNTIMES))
      v.push(`${name} is gui-drivable but missing from GUI_RUNTIMES`);
  }
  expectThrow("bogus", "unknown agent_runtime");

  // Config resolution: defaults without aios.yaml, reads with one.
  const tmp = mkdtempSync(path.join(tmpdir(), "adapter-contract-"));
  try {
    const dflt = reg.readAgentConfig(tmp);
    if (dflt.runtime !== "claude-code") v.push("readAgentConfig default should be claude-code");
    if (dflt.personality !== "aios") v.push("readAgentConfig default personality should be 'aios'");
    writeFileSync(
      path.join(tmp, "aios.yaml"),
      "agent_runtime: codex\nagent_personality: operator\n"
    );
    const cfg = reg.readAgentConfig(tmp);
    if (cfg.runtime !== "codex") v.push("readAgentConfig did not read agent_runtime");
    if (cfg.personality !== "operator") v.push("readAgentConfig did not read agent_personality");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return v;
}

/**
 * Host-side write-guard contract scenarios: the guard reuses hooks/team-ops-guard.sh as the single
 * governance source, so `repoRoot` must be a checkout that carries it (the toolkit). Callers skip —
 * they do not fail — when guardWrite throws (jq/bash/hook absent): same posture OGR07 always had.
 */
export const GUARD_SCENARIOS = [
  {
    label: "clean deliverable allowed",
    args: { path: "2-work/x.md", content: "---\nstatus: draft\nowner: me\n---\nhi" },
    wantOk: true,
  },
  {
    // Split so this fixture value itself doesn't trip OGR03's secret scan in CI.
    label: "secret blocked",
    args: { path: "notes.md", content: "token=AKIA" + "IOSFODNN7EXAMPLE" },
    wantOk: false,
  },
  {
    // Explicitly tagged admin-tier content: the `access:` tag alone must block the
    // write into an outward dir, independent of any content-pattern heuristics.
    label: "explicit access: admin in outward dir blocked",
    args: {
      path: "4-shared/notes.md",
      content: "---\naccess: admin\nstatus: draft\nowner: me\n---\nplain meeting notes",
    },
    wantOk: false,
  },
  {
    // Admin-tier content PATTERN without an admin tag: the heuristics still catch it.
    label: "admin-tier content pattern in outward dir blocked",
    args: {
      path: "4-shared/deal.md",
      content: "---\nstatus: draft\n---\nour day rate is confidential",
    },
    wantOk: false,
  },
  {
    // Default-deny is a hard invariant: content with no resolvable access frontmatter
    // must not reach an outward dir either.
    label: "missing access frontmatter in outward dir blocked (default-deny)",
    args: { path: "4-shared/untagged.md", content: "no frontmatter at all" },
    wantOk: false,
  },
  {
    label: "path escape blocked",
    args: { path: "../../../../etc/passwd", content: "x" },
    wantOk: false,
  },
];

/**
 * @param {(args: object) => {ok: boolean, reason?: string}} guardWrite
 * @param {string} repoRoot a checkout containing hooks/team-ops-guard.sh
 * @returns {string[]} violations (empty = pass); throws only if guardWrite itself throws
 */
export function checkGuardWrite(guardWrite, repoRoot) {
  const v = [];
  for (const { label, args, wantOk } of GUARD_SCENARIOS) {
    const r = guardWrite({ repo: repoRoot, ...args });
    if (r.ok !== wantOk)
      v.push(`guardWrite ${label}: expected ok=${wantOk}, got ok=${r.ok} (${r.reason || ""})`);
  }
  return v;
}
