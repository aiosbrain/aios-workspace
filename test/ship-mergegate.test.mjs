#!/usr/bin/env node
// test/ship-mergegate.test.mjs — [R-Major-4] readChecks survives a non-zero `gh pr checks`.
// gh pr checks exits non-zero when checks are pending/failing; readChecks must parse the
// captured stdout (not throw), and empty/unparseable stdout must fail closed (unavailable).
// Run: node test/ship-mergegate.test.mjs

import { readChecks } from "../scripts/ship.mjs";

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

// ghExec returns { code, stdout, stderr } and NEVER throws (matches the real wrapper).
const ghReturning = (code, stdout) => () => ({ code, stdout, stderr: "" });

console.log("non-zero exit with parseable RED output → not-ok, not a thrown crash");
{
  const stdout = JSON.stringify([{ name: "test", state: "FAILURE", bucket: "fail" }]);
  const r = readChecks(44, { ghExec: ghReturning(1, stdout) });
  check("red board → ok:false", r.ok === false && r.red === true);
  check("red board not unavailable", r.unavailable === false);
}

console.log("pending → not-ok (fail closed)");
{
  const stdout = JSON.stringify([{ name: "test", state: "IN_PROGRESS", bucket: "pending" }]);
  const r = readChecks(44, { ghExec: ghReturning(8, stdout) });
  check("pending → ok:false", r.ok === false && r.pending === true);
}

console.log("empty / unparseable stdout → unavailable (fail closed)");
{
  const r1 = readChecks(44, { ghExec: ghReturning(1, "") });
  check("empty stdout → unavailable", r1.ok === false && r1.unavailable === true);
  const r2 = readChecks(44, { ghExec: ghReturning(1, "authentication failed for host github.com") });
  check("error prose → unavailable (not a red board)", r2.ok === false && r2.unavailable === true);
}

console.log("all-green → gate proceeds");
{
  const stdout = JSON.stringify([
    { name: "test", state: "SUCCESS", bucket: "pass" },
    { name: "lint", state: "SUCCESS", bucket: "pass" },
  ]);
  const r = readChecks(44, { ghExec: ghReturning(0, stdout) });
  check("green → ok:true", r.ok === true && r.red === false && r.pending === false);
}

console.log("a ghExec that throws is treated as unavailable, not a crash");
{
  const r = readChecks(44, {
    ghExec: () => {
      throw new Error("spawn gh ENOENT");
    },
  });
  check("throw → unavailable", r.ok === false && r.unavailable === true);
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
