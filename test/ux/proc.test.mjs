#!/usr/bin/env node
// test/ux/proc.test.mjs — ZERO-DEPENDENCY unit test for the teardown group-kill (test/ux/proc.mjs).
//
// Regression for the orphaned-cockpit bug: teardown must signal the whole process GROUP (negative
// pid) so the run-gui.mjs → gui/server/index.mjs grandchild is reaped, not just the direct child.
// We inject a fake `kill` and assert the target pid is NEGATED and the right signals are sent.
//
// Run: node test/ux/proc.test.mjs

import { killGroup } from "./proc.mjs";

let failed = 0;
const RED = "\x1b[0;31m", GREEN = "\x1b[0;32m", NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else { console.log(`  ${RED}✗${NC} ${label}`); failed++; }
}

console.log("killGroup: signals the GROUP (negative pid), not the bare child");
{
  const calls = [];
  const ok = killGroup(4242, { kill: (pid, sig) => calls.push([pid, sig]) });
  check("returns true when signals are delivered", ok === true);
  check("targets the NEGATED pid (whole group)", calls.every(([pid]) => pid === -4242));
  check("never signals the positive/bare pid", !calls.some(([pid]) => pid === 4242));
  check("sends SIGTERM then SIGKILL in order", calls.length === 2 && calls[0][1] === "SIGTERM" && calls[1][1] === "SIGKILL");
}

console.log("killGroup: honors a custom signal list");
{
  const calls = [];
  killGroup(10, { signals: ["SIGKILL"], kill: (pid, sig) => calls.push([pid, sig]) });
  check("only the requested signal is sent", calls.length === 1 && calls[0][0] === -10 && calls[0][1] === "SIGKILL");
}

console.log("killGroup: reports group-already-gone");
{
  const ok = killGroup(999, { kill: () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); } });
  check("returns false when every kill throws (group gone)", ok === false);
  let partial = 0;
  const ok2 = killGroup(7, { signals: ["SIGTERM", "SIGKILL"], kill: (pid, sig) => { if (sig === "SIGTERM") { partial++; return; } throw new Error("gone"); } });
  check("returns true if at least one signal landed", ok2 === true && partial === 1);
}

console.log("killGroup: refuses catastrophic targets (never broadcast to group 0/1/self)");
{
  for (const bad of [undefined, null, 0, 1, -5, 2.5, NaN, "123"]) {
    const calls = [];
    const ok = killGroup(bad, { kill: (pid, sig) => calls.push([pid, sig]) });
    check(`pid=${JSON.stringify(bad)} → no signal sent, returns false`, ok === false && calls.length === 0);
  }
}

console.log("");
if (failed) { console.log(`${RED}proc.test: ${failed} check(s) failed${NC}`); process.exit(1); }
console.log(`${GREEN}proc.test: all checks passed${NC}`);
