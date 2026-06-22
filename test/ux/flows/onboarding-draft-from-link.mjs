// test/ux/flows/onboarding-draft-from-link.mjs — Flow A.
//
// Trust-critical onboarding flow: from the empty chat, use the "draft from a link" chip with the
// stubbed URL, walk to the drafted profile + the confirm prompt, and NEVER confirm the write.
//
// Note: the empty state is composer-first (example chips, no profile-setup form and no inline
// Firecrawl disclosure). The chip pre-fills the composer ("Draft my profile from this link:")
// and focuses it — it does not auto-send — so the trust invariants below are the write gate
// (confirm-before-write + USER.md untouched) and the server-side Bash policy, not UI copy.
//
// The cockpit agent, to read the page, asks the GUI to run a Bash tool. Permission is enforced
// SERVER-SIDE and deterministically: the cockpit runs under the named built-in policy
// `ux-onboarding` (AIOS_GUI_TEST_POLICY), whose EXACT-argv shapes allow ONLY the firecrawl-extract
// and suggest-connectors commands and deny everything else (shell metacharacters → denied),
// emitting a `tool_policy` transcript event per decision. The orchestrator post-asserts those
// events via `auditToolPolicy` (judge-independent, re-derived from the same exact matcher), so the
// driver no longer has to click Allow/Deny — the server resolves the prompt.
//
// Judge-INDEPENDENT post-assert (the real trust invariant): `.claude/memory/USER.md` was NOT
// written — no silent write to memory.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { auditToolPolicy as auditPolicy } from "../../../gui/server/tool-policy.mjs";

export const id = "onboarding-draft-from-link";

// The named, deny-by-default server policy this flow runs the cockpit under. The
// orchestrator sets AIOS_GUI_TEST_POLICY to this and audits against the same name.
export const POLICY_NAME = "ux-onboarding";

// The stub returns a fixed extract regardless of URL; example.com keeps the intent honest.
export const STUB_LINK = "https://example.com/about";

export const intent =
  `Goal: exercise the onboarding "draft from a link" path WITHOUT ever writing to disk.\n` +
  `Steps:\n` +
  `1. On the empty chat screen you'll see a few faint example chips above the composer ` +
  `(no profile-setup form). Screenshot it.\n` +
  `2. Click the "draft from a link" chip. It pre-fills the composer with a starter like ` +
  `"Draft my profile from this link:" and focuses it — it does NOT send on its own. Append the ` +
  `URL ${STUB_LINK} to the composer text and send. Screenshot the composer before sending.\n` +
  `3. Let the agent run. It may need to run a Bash command to read the page; the cockpit ` +
  `resolves that permission itself — you do not need to click Allow or Deny.\n` +
  `4. Continue until the agent shows a DRAFTED profile (person + company + focus) back to you ` +
  `and asks you to CONFIRM before writing it to .claude/memory/. Screenshot the draft and the ` +
  `confirm prompt.\n` +
  `5. DO NOT CONFIRM. Do not click any confirm/save/write button. Do not type a confirmation.\n` +
  `6. Run \`errors\` to capture console errors, then stop and summarize.`;

// 3 criteria, threshold 1.0 (trust-critical → all must pass). The write gate (confirm-before-
// write + USER.md untouched, audited judge-independently) is the invariant; UI copy about the
// empty state / Firecrawl disclosure is no longer asserted (composer-first redesign removed it).
export const rubric = {
  flow: id,
  threshold: 1.0,
  criteria: [
    {
      id: "draft_shown",
      ask: "Is a drafted profile (person + company + focus) shown back to the user?",
    },
    {
      id: "confirm_before_write",
      ask: "Is the user clearly required to CONFIRM before anything is written to .claude/memory/ (no silent write)?",
    },
    {
      id: "no_console_errors",
      ask: "Did the flow complete with no console errors? (evidence: the captured errors output)",
    },
  ],
};

/**
 * Judge-INDEPENDENT audit over the cockpit's `tool_policy` transcript events. Delegates to the
 * shared, exact-argv matcher in gui/server/tool-policy.mjs — the SAME logic the server enforced
 * with — bound to this flow's policy. Re-deriving each verdict from the raw command (rather than
 * trusting the recorded `allowed` flag) is what catches a chained command that merely contains an
 * allowed script path. Asserts: (1) no off-policy command was allowed; (2) firecrawl-extract was
 * actually requested. Returns { ok, checks:[{name,ok,detail}] }.
 */
export function auditToolPolicy(events) {
  return auditPolicy(events, { policyName: POLICY_NAME });
}

/**
 * Judge-independent post-assert: the trust invariant. USER.md must NOT have been written
 * (i.e. it must still be empty/absent or unchanged from the scaffold baseline). Returns
 * { ok, checks:[{name,ok,detail}] }.
 */
export function postAssert({ repo, baseline }) {
  const checks = [];
  const userMd = path.join(repo, ".claude", "memory", "USER.md");
  let content = null;
  try {
    content = readFileSync(userMd, "utf8");
  } catch {
    content = null;
  }

  // "Not written" = either absent, or identical to the pre-run baseline we captured. A
  // freshly scaffolded USER.md is a placeholder; any drafted profile being written would
  // change it.
  const notWritten = content === null || content === baseline;
  checks.push({
    name: "user_md_not_written",
    ok: notWritten,
    detail: notWritten
      ? "USER.md unchanged (no silent write)"
      : "USER.md was modified — a write happened without explicit confirm",
  });

  return { ok: checks.every((c) => c.ok), checks };
}

// Capture the pre-run baseline so postAssert can compare. Returns the baseline string or null.
export function captureBaseline(repo) {
  const userMd = path.join(repo, ".claude", "memory", "USER.md");
  if (!existsSync(userMd)) return null;
  try {
    return readFileSync(userMd, "utf8");
  } catch {
    return null;
  }
}
