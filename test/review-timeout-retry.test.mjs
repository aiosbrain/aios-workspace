#!/usr/bin/env node
// test/review-timeout-retry.test.mjs — pure exports from build.mjs for review resilience:
// isTimeoutError, reviewWithTimeoutRetry (retry-once-on-timeout with a doubled timeout),
// adaptiveReviewTimeout boundaries, and computeReviewPayloadChars (the pre-truncation,
// DIFF_CAP-clamped size the timeout keys off — Major 3). Injected fake agent; no live cursor.
// Run: node test/review-timeout-retry.test.mjs

import {
  isTimeoutError,
  reviewWithTimeoutRetry,
  adaptiveReviewTimeout,
  computeReviewPayloadChars,
  DIFF_CAP,
} from "../scripts/build.mjs";

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

// Silence the retry's console.log during runs.
async function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

const timeoutErr = () => new Error("cursor agent timed out after 300s — increase the timeout and retry");
const exitErr = () => new Error("cursor agent exited 1: boom");

console.log("isTimeoutError");
{
  check("true for timeout shape", isTimeoutError(timeoutErr()) === true);
  check("false for exit shape", isTimeoutError(exitErr()) === false);
  check("false for undefined", isTimeoutError(undefined) === false);
}

console.log("reviewWithTimeoutRetry — one timeout then success");
{
  const calls = [];
  let n = 0;
  const callFn = async (p, t, o) => {
    calls.push({ t, o });
    n++;
    if (n === 1) throw timeoutErr();
    return "REVIEW OK";
  };
  const logs = [];
  const rv = await quiet(() =>
    reviewWithTimeoutRetry(callFn, "prompt", 300000, { cwd: "/wt" }, { log: (l, m) => logs.push(`${l}: ${m}`) })
  );
  check("returns the second-attempt result", rv === "REVIEW OK");
  check("retried exactly twice", calls.length === 2);
  check("second attempt uses 2× timeout", calls[1].t === 600000);
  check("opts are forwarded", calls[1].o.cwd === "/wt");
  check("logs the retry decision (original/doubled/attempt)", logs.some((l) => /300s/.test(l) && /600s/.test(l) && /attempt 2\/2/.test(l)));
}

console.log("reviewWithTimeoutRetry — second timeout propagates");
{
  let n = 0;
  const callFn = async () => {
    n++;
    throw timeoutErr();
  };
  let threw = false;
  await quiet(async () => {
    try {
      await reviewWithTimeoutRetry(callFn, "p", 100000, {});
    } catch {
      threw = true;
    }
  });
  check("rejects after a second timeout", threw === true);
  check("exactly 2 invocations", n === 2);
}

console.log("reviewWithTimeoutRetry — non-timeout error is NOT retried");
{
  let n = 0;
  const callFn = async () => {
    n++;
    throw exitErr();
  };
  let threw = false;
  await quiet(async () => {
    try {
      await reviewWithTimeoutRetry(callFn, "p", 100000, {});
    } catch {
      threw = true;
    }
  });
  check("rejects immediately", threw === true);
  check("exactly 1 invocation (no retry)", n === 1);
}

console.log("adaptiveReviewTimeout boundaries (seconds)");
{
  check("0 chars → 300", adaptiveReviewTimeout(0) === 300);
  check("10000 → 360", adaptiveReviewTimeout(10000) === 360);
  check("49999 → 540", adaptiveReviewTimeout(49999) === 540);
  check("50000 (=DIFF_CAP) → 600", adaptiveReviewTimeout(50000) === 600);
  check(">50000 → 600 (cap)", adaptiveReviewTimeout(999999) === 600);
  check("custom base/cap honored", adaptiveReviewTimeout(30000, { base: 120, cap: 200 }) === 200);
  check("null payload → base", adaptiveReviewTimeout(null) === 300);
}

console.log("computeReviewPayloadChars (Major 3) — clamped to DIFF_CAP");
{
  check("small diff → own length", computeReviewPayloadChars("abcde") === 5);
  const big = "x".repeat(DIFF_CAP + 20000);
  check("over-cap diff → clamped to DIFF_CAP", computeReviewPayloadChars(big) === DIFF_CAP);
  // The whole point of Major 3: an over-cap diff scales the timeout to the 2× cap (600s),
  // NOT to the tiny truncation-message length it would otherwise collapse to.
  check("over-cap payload → timeout at the 600s cap", adaptiveReviewTimeout(computeReviewPayloadChars(big)) * 1000 === 600000);
  check("null → 0", computeReviewPayloadChars(null) === 0);
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
