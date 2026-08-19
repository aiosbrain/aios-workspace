#!/usr/bin/env node
// test/brain-url-mismatch.test.mjs — the AIOS_BRAIN_URL vs aios.yaml disagreement guard.
// Spec: env wins over aios.yaml silently (correct precedence), but a DISAGREEMENT between
// the two is always a mistake — detect it, warn on status/push, and carry it in status --json.
// Also pins the extracted `aios status --json` shape (AIO-568: --json is a machine surface;
// adding a field is a versioned contract change, and this test is the oracle for the shape).
// Zero-dep. Run: node test/brain-url-mismatch.test.mjs

import {
  detectBrainUrlMismatch,
  brainUrlMismatchWarning,
  warnBrainUrlMismatch,
} from "../scripts/brain-config.mjs";
import { statusJson } from "../scripts/status-json.mjs";

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

// ── detectBrainUrlMismatch ──────────────────────────────────────────────────
const a = "https://brain-a.example.com";
const b = "https://brain-b.example.com";

const hit = detectBrainUrlMismatch(a, b);
check("disagreement is detected", !!hit && hit.declared === a && hit.effective === b);
check("agreement is silent", detectBrainUrlMismatch(a, a) === null);
check("trailing slash is not a disagreement", detectBrainUrlMismatch(a, `${a}/`) === null);
check("declared-only (env unset) is silent", detectBrainUrlMismatch(a, "") === null);
check("effective-only (no aios.yaml value) is silent", detectBrainUrlMismatch("", b) === null);
check("both unset is silent", detectBrainUrlMismatch("", "") === null);
check("null/undefined never throw", detectBrainUrlMismatch(null, undefined) === null);

// ── brainUrlMismatchWarning ─────────────────────────────────────────────────
const msg = brainUrlMismatchWarning(hit);
check("warning names the declared URL", msg.includes(a));
check("warning names the effective URL", msg.includes(b));
check("warning names the remedy (unset AIOS_BRAIN_URL)", msg.includes("unset AIOS_BRAIN_URL"));
check("warning covers the .env-sourced case too", msg.includes(".env"));
check("no mismatch → empty string", brainUrlMismatchWarning(null) === "");

// ── warnBrainUrlMismatch (fail-open: never throws, logs only on a mismatch) ─
const logged = [];
warnBrainUrlMismatch({ brain_url_mismatch: hit }, { log: (m) => logged.push(m) });
check("warnBrainUrlMismatch logs once on a mismatch", logged.length === 1 && logged[0] === msg);
warnBrainUrlMismatch({ brain_url_mismatch: null }, { log: (m) => logged.push(m) });
warnBrainUrlMismatch(null, { log: (m) => logged.push(m) });
warnBrainUrlMismatch(undefined, { log: (m) => logged.push(m) });
check("warnBrainUrlMismatch stays silent on null mismatch/config", logged.length === 1);

// ── statusJson shape (the --json machine contract) ──────────────────────────
const plan = {
  push: [
    { rel: "2-work/new.md", kind: "deliverable", tier: "team", isNew: true },
    { rel: "2-work/mod.md", kind: "deliverable", tier: "team", isNew: false },
  ],
  blocked: [{ rel: "5-personal/x.md", reason: "tier" }],
  clean: [{ rel: "0-context/ok.md" }],
};
const out = statusJson({ project: "p", brain_url: a, brain_url_mismatch: null }, plan, [
  "3-log/decision-log.md",
]);
check(
  "top-level keys are exactly the documented set, in order",
  JSON.stringify(Object.keys(out)) ===
    JSON.stringify(["project", "brain_url", "brain_url_mismatch", "items", "loop_critical_blocked"])
);
check(
  "brain_url_mismatch is present-as-null when clean (never absent)",
  out.brain_url_mismatch === null
);
check(
  "items buckets keep their shape",
  out.items.new.length === 1 &&
    out.items.new[0].rel === "2-work/new.md" &&
    out.items.new[0].isNew === true &&
    out.items.modified.length === 1 &&
    out.items.blocked[0].reason === "tier" &&
    out.items.clean[0].rel === "0-context/ok.md"
);
check("loopCriticalBlocked passes through as a value", out.loop_critical_blocked.length === 1);
const outMismatch = statusJson({ project: "p", brain_url: b, brain_url_mismatch: hit }, plan, []);
check(
  "mismatch object survives into --json",
  outMismatch.brain_url_mismatch?.declared === a && outMismatch.brain_url_mismatch?.effective === b
);

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}brain-url-mismatch tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}brain-url-mismatch tests FAILED — ${failed} assertion(s)${NC}`);
process.exit(1);
