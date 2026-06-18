// gui/server/tool-policy.mjs — named, built-in, deny-by-default Bash tool policies.
//
// Used ONLY by the agentic UX-testing harness to make the cockpit's permission
// enforcement reproducible without a human clicking Allow/Deny. The cockpit
// server activates a policy by NAME via the AIOS_GUI_TEST_POLICY env var; when
// that var is unset the server never calls in here, so production is unchanged.
//
// Naming a built-in (rather than passing arbitrary command substrings) is the
// safety property: a test can only ever select one of the exact-argv shapes
// declared here — it cannot widen the policy. Matching is EXACT-argv and rejects
// any shell metacharacter, so a chained command like
//   `node .claude/.../firecrawl-extract.mjs <url> ; rm -rf .`
// is DENIED even though it contains an allowed script path.
//
// This module is pure and dependency-free so the offline CI test can import it.

// Shell metacharacters that enable chaining / substitution / redirection. Same
// set the driver's agent-browser allowlist uses (test/ux/allowlist.mjs) — any of
// these anywhere in the command → reject outright (we never try to parse them).
export const SHELL_METACHARS = /[;|&$`><(){}\n\r]/;

/**
 * Tokenize a Bash command into an argv array, or return null if it is not a
 * single, plainly-quoted, metacharacter-free command. Conservative by design:
 * any ambiguity (quotes, escapes, env-assignment prefix, empty tokens) → null,
 * which the caller treats as "deny".
 */
export function tokenizeCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) return null;
  if (SHELL_METACHARS.test(command)) return null;
  if (/['"\\]/.test(command)) return null; // no quoting/escaping → argv stays unambiguous
  const argv = command.trim().split(/\s+/);
  if (argv.some((t) => t.length === 0)) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) return null; // reject leading VAR=val env assignment
  return argv;
}

// A matcher asserts an exact argv shape. `node <scriptPath> [args…]` with the
// script path matched EXACTLY (not as a substring) and a minimum trailing-arg count.
function nodeScript(scriptPath, { minArgs = 0 } = {}) {
  return (argv) =>
    Array.isArray(argv) &&
    argv.length >= 2 + minArgs &&
    argv[0] === "node" &&
    argv[1] === scriptPath;
}

// The named built-in policies. Each value is a list of exact-argv matchers; a
// command is allowed iff it parses to a metacharacter-free argv that matches one.
export const TEST_POLICIES = {
  // Flow A — onboarding draft-from-link: the cockpit agent may run ONLY the
  // Firecrawl extract script (needs a URL arg) and the connector-suggest script.
  "ux-onboarding": [
    nodeScript(".claude/skills/firecrawl-direct/firecrawl-extract.mjs", { minArgs: 1 }),
    nodeScript(".claude/skills/workspace-setup/suggest-connectors.mjs"),
  ],
};

/**
 * Evaluate a tool call against a named policy.
 * Returns { active, allowed, reason }:
 *   - active=false  → no policy is in force (empty name); caller falls through to
 *     its normal permission handling.
 *   - active=true   → the named policy decided; allowed reflects exact-argv match.
 * An unknown (non-empty) policy name is active + denied: a misconfigured test
 * fails closed rather than silently falling back to interactive prompts.
 * Only the Bash tool is ever allowable; every other tool is denied under a policy.
 */
export function evaluateToolPolicy(policyName, toolName, command) {
  const name = (policyName || "").trim();
  if (!name) return { active: false, allowed: false, reason: "no policy in force" };
  const matchers = TEST_POLICIES[name];
  if (!matchers) return { active: true, allowed: false, reason: `unknown policy "${name}"` };
  if (toolName !== "Bash") return { active: true, allowed: false, reason: `tool ${toolName} not permitted under policy` };
  const argv = tokenizeCommand(command);
  if (!argv) return { active: true, allowed: false, reason: "command has shell metacharacters or is unparseable" };
  const allowed = matchers.some((m) => m(argv));
  return { active: true, allowed, reason: allowed ? "matched an exact-argv shape in policy" : "no matching argv shape in policy" };
}

/**
 * Judge-INDEPENDENT audit over the cockpit's recorded `tool_policy` transcript
 * events. Re-derives the verdict from the raw command via the SAME exact matcher
 * the server used, so the audit cannot drift from enforcement and a recorded
 * `allowed:true` on a chained command is caught. Asserts:
 *   1. every command the server ALLOWED still matches the policy exactly; and
 *   2. the Firecrawl extract command was actually requested (the link path ran).
 * Returns { ok, checks:[{name,ok,detail}] }.
 */
export function auditToolPolicy(events, { policyName = "ux-onboarding" } = {}) {
  const checks = [];
  const policy = (Array.isArray(events) ? events : []).filter((e) => e && e.type === "tool_policy");
  const allowed = policy.filter((e) => e.allowed === true);

  // 1: re-evaluate each ALLOWED event from its raw command; any that does not
  // independently pass the exact matcher is an off-list approval (enforcement bug).
  const offList = allowed.filter((e) => !evaluateToolPolicy(policyName, e.tool, e.command || "").allowed);
  checks.push({
    name: "no_offlist_command_allowed",
    ok: offList.length === 0,
    detail: offList.length === 0
      ? `all ${allowed.length} allowed command(s) independently re-verify against policy "${policyName}"`
      : `off-list command(s) were allowed: ${offList.map((e) => JSON.stringify(e.command)).join(", ")}`,
  });

  // 2: the Firecrawl extract command must have been requested at least once
  // (allowed or denied) — proves the flow actually drove the link path.
  const firecrawlScript = ".claude/skills/firecrawl-direct/firecrawl-extract.mjs";
  const firecrawlRequested = policy.some((e) => {
    const argv = tokenizeCommand(e.command || "");
    return !!argv && argv[0] === "node" && argv[1] === firecrawlScript;
  });
  checks.push({
    name: "firecrawl_extract_requested",
    ok: firecrawlRequested,
    detail: firecrawlRequested
      ? "firecrawl-extract command was requested through the policy"
      : "firecrawl-extract command was never requested — the link path did not run",
  });

  return { ok: checks.every((c) => c.ok), checks };
}
