#!/usr/bin/env node
// test/ux/driver.test.mjs — ZERO-DEPENDENCY unit test for the pure Bash allowlist used by the
// agentic UX driver (test/ux/allowlist.mjs). No SDK import: these functions are pure.
//
// The allowlist is load-bearing security: the driver may run Bash ONLY when the command parses
// as exactly `agent-browser <subcommand> [args…]` with no shell features and no leading
// env-assignment. Deny on any doubt. We cover the allow path and every deny class.
//
// Run: node test/ux/driver.test.mjs

import { tokenizeSimpleCommand, isAgentBrowserCommand } from "./allowlist.mjs";

let failed = 0;
const RED = "\x1b[0;31m", GREEN = "\x1b[0;32m", NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else { console.log(`  ${RED}✗${NC} ${label}`); failed++; }
}
const allow = (cmd) => isAgentBrowserCommand(cmd).allow === true;
const deny = (cmd) => isAgentBrowserCommand(cmd).allow === false;

console.log("allowlist: ALLOW well-formed agent-browser commands");
{
  check("plain snapshot", allow("agent-browser snapshot"));
  check("snapshot with -i flag", allow("agent-browser snapshot -i"));
  check("--session + open with quoted query URL", allow('agent-browser --session s open "https://x/?a=b"'));
  check("screenshot with output path", allow("agent-browser screenshot out.png"));
  check("screenshot --annotate path", allow("agent-browser screenshot --annotate /tmp/e/step.png"));
  check("--session value then subcommand", allow("agent-browser --session flowA wait"));
  check("wait --load networkidle", allow("agent-browser wait --load networkidle"));
  check("errors subcommand", allow("agent-browser errors"));
  check("close subcommand", allow("agent-browser close"));
  check("leading/trailing whitespace tolerated", allow("   agent-browser snapshot   "));
}

console.log("allowlist: DENY shell metacharacters");
{
  check("semicolon chaining", deny("agent-browser snapshot; rm -rf /"));
  check("pipe", deny("agent-browser snapshot | cat"));
  check("background &", deny("agent-browser snapshot &"));
  check("command substitution $()", deny("agent-browser open $(echo http://x)"));
  check("backtick substitution", deny("agent-browser open `echo http://x`"));
  check("output redirection >", deny("agent-browser snapshot > out.txt"));
  check("input redirection <", deny("agent-browser snapshot < in.txt"));
  check("&& chaining", deny("agent-browser snapshot && echo hi"));
  check("brace expansion", deny("agent-browser open {a,b}"));
  check("dollar var", deny("agent-browser open $URL"));
  check("newline embedded", deny("agent-browser snapshot\nrm -rf /"));
}

console.log("allowlist: DENY non-agent-browser binaries");
{
  check("node", deny("node .claude/skills/x.mjs"));
  check("rm", deny("rm -rf /tmp"));
  check("bash -c", deny("bash -c 'agent-browser snapshot'"));
  check("relative ./agent-browser is not the literal binary", deny("./agent-browser snapshot"));
  check("agentbrowser typo", deny("agentbrowser snapshot"));
}

console.log("allowlist: DENY leading env-assignment");
{
  check("FOO=bar agent-browser …", deny("FOO=bar agent-browser snapshot"));
  check("PROXY=http://x agent-browser open …", deny("PROXY=1 agent-browser open https://x"));
}

console.log("allowlist: DENY embedded quotes / malformed quoting");
{
  check("embedded quote in bare token", deny('agent-browser open foo"bar'));
  check("unterminated quote", deny('agent-browser open "https://x'));
}

console.log("allowlist: DENY missing subcommand / bad flags / bad subcommand");
{
  check("no subcommand (binary only)", deny("agent-browser"));
  check("only flags, no subcommand", deny("agent-browser --session s"));
  check("uppercase flag is rejected", deny("agent-browser --Session s open https://x"));
  check("uppercase subcommand rejected", deny("agent-browser Snapshot"));
  check("empty command", deny(""));
}

console.log("allowlist: tokenizeSimpleCommand low-level behavior");
{
  const t1 = tokenizeSimpleCommand('agent-browser --session s open "https://x/?a=b"');
  check("tokenizes quoted URL as one arg", t1.ok && t1.argv.length === 5 && t1.argv[4] === "https://x/?a=b");
  const t2 = tokenizeSimpleCommand("agent-browser snapshot; ls");
  check("metachar rejected at tokenize", t2.ok === false && /metacharacter/.test(t2.reason));
  const t3 = tokenizeSimpleCommand(42);
  check("non-string rejected", t3.ok === false);
}

console.log("");
if (failed) { console.log(`${RED}driver.test: ${failed} check(s) failed${NC}`); process.exit(1); }
console.log(`${GREEN}driver.test: all checks passed${NC}`);
