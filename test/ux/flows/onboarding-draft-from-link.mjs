// test/ux/flows/onboarding-draft-from-link.mjs — Flow A.
//
// Trust-critical onboarding flow: from the empty chat, use "draft it from a link" with the
// stubbed URL, walk to the drafted profile + the confirm prompt, and NEVER confirm the write.
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
  `1. On the empty chat screen, confirm the empty state clearly offers BOTH "Set up your ` +
  `profile" AND a "draft it from a link" option. Screenshot it.\n` +
  `2. Use the "draft it from a link" option with the URL ${STUB_LINK}. Before/at submit, note ` +
  `whether it is clearly disclosed that the URL is sent to Firecrawl to read the page. ` +
  `Screenshot the disclosure.\n` +
  `3. Let the agent run. It may need to run a Bash command to read the page; the cockpit ` +
  `resolves that permission itself — you do not need to click Allow or Deny.\n` +
  `4. Continue until the agent shows a DRAFTED profile (person + company + focus) back to you ` +
  `and asks you to CONFIRM before writing it to .claude/memory/. Screenshot the draft and the ` +
  `confirm prompt.\n` +
  `5. DO NOT CONFIRM. Do not click any confirm/save/write button. Do not type a confirmation.\n` +
  `6. Run \`errors\` to capture console errors, then stop and summarize.`;

// 5 criteria, threshold 1.0 (trust-critical → all must pass).
export const rubric = {
  flow: id,
  threshold: 1.0,
  criteria: [
    {
      id: "empty_state_offers_both",
      ask: "Does the empty chat clearly offer BOTH 'Set up your profile' AND a 'draft it from a link' option?",
    },
    {
      id: "firecrawl_disclosure",
      ask: "Before or at submit, is it clearly disclosed that the URL is sent to Firecrawl to read the page?",
    },
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
