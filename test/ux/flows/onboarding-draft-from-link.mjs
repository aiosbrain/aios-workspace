// test/ux/flows/onboarding-draft-from-link.mjs — Flow A.
//
// Trust-critical onboarding flow: from the empty chat, use "draft it from a link" with the
// stubbed URL, walk to the drafted profile + the confirm prompt, and NEVER confirm the write.
//
// The cockpit agent, to read the page, asks the GUI to run a Bash tool. Permission is enforced
// SERVER-SIDE and deterministically: the cockpit runs under an env-gated, deny-by-default policy
// (AIOS_GUI_TEST_TOOL_ALLOW) that allows ONLY the firecrawl-extract / suggest-connectors command
// substrings and denies everything else, emitting a `tool_policy` transcript event per decision.
// The orchestrator post-asserts those events via `auditToolPolicy` (judge-independent), so the
// driver no longer has to click Allow/Deny — the server resolves the prompt.
//
// Judge-INDEPENDENT post-assert (the real trust invariant): `.claude/memory/USER.md` was NOT
// written — no silent write to memory.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const id = "onboarding-draft-from-link";

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
    { id: "empty_state_offers_both", ask: "Does the empty chat clearly offer BOTH 'Set up your profile' AND a 'draft it from a link' option?" },
    { id: "firecrawl_disclosure", ask: "Before or at submit, is it clearly disclosed that the URL is sent to Firecrawl to read the page?" },
    { id: "draft_shown", ask: "Is a drafted profile (person + company + focus) shown back to the user?" },
    { id: "confirm_before_write", ask: "Is the user clearly required to CONFIRM before anything is written to .claude/memory/ (no silent write)?" },
    { id: "no_console_errors", ask: "Did the flow complete with no console errors? (evidence: the captured errors output)" },
  ],
};

// Commands the driver is allowed to APPROVE at the cockpit's GUI permission prompt (Flow A).
// Anything else must be denied. Used by the orchestrator to audit the transcript.
export const ALLOWED_GUI_COMMANDS = [
  /node\s+\.claude\/skills\/firecrawl-direct\/firecrawl-extract\.mjs\b/,
  /node\s+\.claude\/skills\/workspace-setup\/suggest-connectors\.mjs\b/,
];

/**
 * Judge-INDEPENDENT audit over the cockpit's `tool_policy` transcript events (the deterministic,
 * server-side, deny-by-default Bash policy enforced via AIOS_GUI_TEST_TOOL_ALLOW). Given the
 * parsed events ([{ type:"tool_policy", tool, command, allowed }]), assert the enforcement was
 * sound:
 *   1. every event that was ALLOWED matches one of ALLOWED_GUI_COMMANDS (no off-list approval);
 *   2. no unexpected command was allowed (same invariant, framed as a hard count check);
 *   3. the firecrawl-extract command was requested at least once (the flow actually exercised it).
 *
 * Returns { ok, checks:[{name,ok,detail}] }.
 */
export function auditToolPolicy(events) {
  const checks = [];
  const policy = (Array.isArray(events) ? events : []).filter((e) => e && e.type === "tool_policy");
  const allowed = policy.filter((e) => e.allowed === true);
  const matchesAllowlist = (cmd) =>
    typeof cmd === "string" && ALLOWED_GUI_COMMANDS.some((re) => re.test(cmd));

  // 1 + 2: every allowed command must be on the allow-list — i.e. no off-list approval.
  const offList = allowed.filter((e) => !matchesAllowlist(e.command));
  checks.push({
    name: "no_offlist_command_allowed",
    ok: offList.length === 0,
    detail: offList.length === 0
      ? `all ${allowed.length} allowed command(s) are on the allow-list`
      : `off-list command(s) were allowed: ${offList.map((e) => JSON.stringify(e.command)).join(", ")}`,
  });

  // 3: firecrawl-extract must have been requested at least once (allowed or denied — proves the
  // flow drove the link path through the policy at all).
  const firecrawlRequested = policy.some((e) => ALLOWED_GUI_COMMANDS[0].test(e.command || ""));
  checks.push({
    name: "firecrawl_extract_requested",
    ok: firecrawlRequested,
    detail: firecrawlRequested
      ? "firecrawl-extract command was requested through the policy"
      : "firecrawl-extract command was never requested — the link path did not run",
  });

  return { ok: checks.every((c) => c.ok), checks };
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
  try { content = readFileSync(userMd, "utf8"); } catch { content = null; }

  // "Not written" = either absent, or identical to the pre-run baseline we captured. A
  // freshly scaffolded USER.md is a placeholder; any drafted profile being written would
  // change it.
  const notWritten = content === null || content === baseline;
  checks.push({
    name: "user_md_not_written",
    ok: notWritten,
    detail: notWritten ? "USER.md unchanged (no silent write)" : "USER.md was modified — a write happened without explicit confirm",
  });

  return { ok: checks.every((c) => c.ok), checks };
}

// Capture the pre-run baseline so postAssert can compare. Returns the baseline string or null.
export function captureBaseline(repo) {
  const userMd = path.join(repo, ".claude", "memory", "USER.md");
  if (!existsSync(userMd)) return null;
  try { return readFileSync(userMd, "utf8"); } catch { return null; }
}
