#!/usr/bin/env node
// test/simplify.test.mjs — unit tests for the post-review simplify pass (scripts/simplify.mjs).
// Zero-dep, no network, no git side effects (all deps injected). Run: node test/simplify.test.mjs

import {
  SIMPLIFY_DONE_TOKEN,
  SIMPLIFY_NOOP_TOKEN,
  detectSimplifyToken,
  buildSimplifyPrompt,
  runSimplify,
} from "../scripts/simplify.mjs";

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

console.log("detectSimplifyToken");
{
  check("done on last line", detectSimplifyToken(`did work\n${SIMPLIFY_DONE_TOKEN}`) === "done");
  check("noop on last line", detectSimplifyToken(`clean\n${SIMPLIFY_NOOP_TOKEN}\n`) === "noop");
  check(
    "tolerates trailing prose after token",
    detectSimplifyToken(`x\n${SIMPLIFY_DONE_TOKEN} - all tidy`) === "done"
  );
  check(
    "no false match on glued token",
    detectSimplifyToken(`${SIMPLIFY_DONE_TOKEN}_NOT_REALLY`) === null
  );
  check(
    "null when token mid-text",
    detectSimplifyToken(`${SIMPLIFY_DONE_TOKEN}\ntrailing`) === null
  );
  check("null on empty", detectSimplifyToken("") === null && detectSimplifyToken(null) === null);
}

console.log("buildSimplifyPrompt");
{
  const p = buildSimplifyPrompt({
    branch: "feat/x",
    baseSha: "abc123",
    diffStat: "1 file changed",
    diff: "DIFF BODY",
    logOneline: "abc feat: thing",
    constitution: "- Domains are siblings, not friends.",
  });
  check("carries branch + base", p.includes("feat/x") && p.includes("abc123"));
  check("carries diff", p.includes("DIFF BODY"));
  check("carries constitution", p.includes("siblings, not friends"));
  check("behavior-preserving rule", p.includes("Behavior-preserving ONLY"));
  check(
    "both verdict tokens offered",
    p.includes(SIMPLIFY_DONE_TOKEN) && p.includes(SIMPLIFY_NOOP_TOKEN)
  );
  check(
    "no constitution section when null",
    !buildSimplifyPrompt({
      branch: "b",
      baseSha: "s",
      diffStat: "d",
      diff: "x",
      logOneline: "l",
    }).includes("Engineering constitution")
  );
}

// Fake git: scripted rev-parse HEAD sequence + porcelain status; records revert calls.
function makeGit({ heads, dirty = [] }) {
  let revParse = 0;
  let statusCall = 0;
  const calls = [];
  return {
    calls,
    fn: (args) => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse") return heads[Math.min(revParse++, heads.length - 1)];
      if (args[0] === "status") return dirty[Math.min(statusCall++, dirty.length - 1)] ?? "";
      return "";
    },
    reverted: () => calls.some((c) => c.startsWith("reset --hard")),
    committed: () => calls.some((c) => c.startsWith("commit")),
    cleaned: () => calls.some((c) => c.startsWith("clean")),
    sweptUntracked: () => calls.some((c) => c === "add -A"),
  };
}
const CAPTURE = () => ({ diffStat: "1 file", logOneline: "abc msg", diff: "DIFF" });
const BASE = {
  worktree: process.cwd(), // must exist; all git/verify effects are injected fakes
  baseSha: "base0",
  branch: "feat/x",
  model: "claude-haiku-4-5",
};

console.log("runSimplify");
{
  // no diff → skip
  const g0 = makeGit({ heads: ["h0"] });
  const r0 = await runSimplify({
    ...BASE,
    deps: {
      git: g0.fn,
      capture: () => ({ diffStat: "", logOneline: "", diff: "" }),
      agentCall: () => "x",
    },
  });
  check(
    "no diff → ok noop, only the precondition status ran",
    r0.ok && !r0.changed && g0.calls.every((call) => call.startsWith("status"))
  );

  // noop verdict, no drift → ok
  const g1 = makeGit({ heads: ["h0", "h0", "h0"] });
  const r1 = await runSimplify({
    ...BASE,
    deps: { git: g1.fn, capture: CAPTURE, agentCall: async () => `clean\n${SIMPLIFY_NOOP_TOKEN}` },
  });
  check("noop verdict → ok, unchanged, no revert", r1.ok && !r1.changed && !g1.reverted());

  // noop verdict but head moved → anomaly, reverted
  const g2 = makeGit({ heads: ["h0", "h1"] });
  const r2 = await runSimplify({
    ...BASE,
    deps: { git: g2.fn, capture: CAPTURE, agentCall: async () => `oops\n${SIMPLIFY_NOOP_TOKEN}` },
  });
  check("noop-but-drifted → reverted, not ok", !r2.ok && r2.reverted && g2.reverted());

  // done verdict + verify green → changed
  let verified = 0;
  const g3 = makeGit({ heads: ["h0", "h1", "h1"] });
  const r3 = await runSimplify({
    ...BASE,
    verify: "true",
    deps: {
      git: g3.fn,
      capture: CAPTURE,
      agentCall: async () => `tidied\n${SIMPLIFY_DONE_TOKEN}`,
      execVerify: () => verified++,
    },
  });
  check("done + verify green → changed", r3.ok && r3.changed && verified === 1 && !g3.reverted());

  // done verdict + verify FAILS → reverted, never blocks (ok:false, changed:false)
  const g4 = makeGit({ heads: ["h0", "h1", "h1"] });
  const r4 = await runSimplify({
    ...BASE,
    verify: "npm test",
    deps: {
      git: g4.fn,
      capture: CAPTURE,
      agentCall: async () => `tidied\n${SIMPLIFY_DONE_TOKEN}`,
      execVerify: () => {
        throw new Error("tests failed");
      },
    },
  });
  check("done + verify red → reverted", !r4.ok && !r4.changed && r4.reverted && g4.reverted());

  // done verdict with uncommitted remainder → swept into a commit before verify
  // (dirty sequence: precondition clean, post-agent dirty, post-commit clean)
  const g5 = makeGit({ heads: ["h0", "h1", "h1"], dirty: ["", " M scripts/x.mjs", ""] });
  const r5 = await runSimplify({
    ...BASE,
    verify: "true",
    deps: {
      git: g5.fn,
      capture: CAPTURE,
      agentCall: async () => `tidied\n${SIMPLIFY_DONE_TOKEN}`,
      execVerify: () => {},
    },
  });
  check("done + dirty tree → remainder committed", r5.ok && r5.changed && g5.committed());
  check("sweep uses add -u, never add -A", !g5.sweptUntracked());

  // pre-existing uncommitted tracked changes → skip before the agent ever runs
  const gPre = makeGit({ heads: ["h0"], dirty: [" M scripts/aios.mjs"] });
  let preAgentCalled = false;
  const rPre = await runSimplify({
    ...BASE,
    deps: {
      git: gPre.fn,
      capture: CAPTURE,
      agentCall: async () => {
        preAgentCalled = true;
        return `x\n${SIMPLIFY_DONE_TOKEN}`;
      },
    },
  });
  check(
    "dirty tracked tree → skipped, agent never called, nothing reverted",
    rPre.ok && !rPre.changed && !preAgentCalled && !gPre.reverted()
  );

  // missing token with drift → fail closed on the cleanup (revert)
  const g6 = makeGit({ heads: ["h0", "h1"] });
  const r6 = await runSimplify({
    ...BASE,
    deps: { git: g6.fn, capture: CAPTURE, agentCall: async () => "rambling, no verdict" },
  });
  check("no token + drift → reverted", !r6.ok && r6.reverted && g6.reverted());

  // agent throws → reverted, never throws outward
  const g7 = makeGit({ heads: ["h0"] });
  const r7 = await runSimplify({
    ...BASE,
    deps: {
      git: g7.fn,
      capture: CAPTURE,
      agentCall: async () => {
        throw new Error("model timeout");
      },
    },
  });
  check("agent failure → reverted result, no throw", !r7.ok && r7.reverted && g7.reverted());
  check("revert never runs git clean (hydrated config survives)", !g7.cleaned() && !g4.cleaned());

  // done verdict but nothing actually committed → honest no-op
  const g8 = makeGit({ heads: ["h0", "h0", "h0"] });
  const r8 = await runSimplify({
    ...BASE,
    verify: "true",
    deps: {
      git: g8.fn,
      capture: CAPTURE,
      agentCall: async () => `claimed work\n${SIMPLIFY_DONE_TOKEN}`,
      execVerify: () => {
        throw new Error("should not verify a no-op");
      },
    },
  });
  check("done-but-no-commit → ok noop, verify skipped", r8.ok && !r8.changed);
}

if (failed) {
  console.error(`\n${RED}${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}all simplify checks passed${NC}`);
