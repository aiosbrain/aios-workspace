// C3 verifier tests. The leak-critical behavior: no finding or serialized VerifierResult may
// carry raw above-audience claim text, path, or row — including a mixed (requiresIndependentSupport)
// claim whose sensitive detail rests on admin evidence. Plus: bounded correction (pass/corrected/
// failed) and the blocking supportCheck / advisory semanticCheck seams.

import test from "node:test";
import assert from "node:assert/strict";
import { verifyLedger, runVerification, budgetFor } from "../../dist/operator-loop/index.js";

// ── fixtures ────────────────────────────────────────────────────────────────
const sig = (path, row, tier, summary = "s") => ({
  kind: "decision",
  source: "decision-log",
  tier,
  occurredAt: "2026-06-29T00:00:00.000Z",
  ref: { path, row, tier },
  summary,
});

// A manifest whose signals the ledger refs must resolve against.
const MANIFEST = {
  member: "alex",
  project: "acme",
  generatedAt: "2026-06-30T00:00:00.000Z",
  window: { cadence: "weekly", from: "2026-06-23", to: "2026-06-30" },
  signals: [
    sig("4-shared/public.md", "1", "external"),
    sig("2-work/notes.md", "2", "team"),
    sig("5-personal/acme-acquisition-secret.md", "7", "admin"),
  ],
  excluded: [],
};

const ref = (path, row, tier) => ({ path, row, tier });
const ledger = (...entries) => ({ entries });

// ── evidence checks (V1/V2) ───────────────────────────────────────────────────
test("V1: ungrounded claim (no evidence) is a must-fail and never echoes its text", async () => {
  const f = await verifyLedger({
    manifest: MANIFEST,
    ledger: ledger({ claim: "secret-internal-only-text", evidence: [] }),
    audience: "external",
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, "V1");
  assert.equal(f[0].check, "evidence");
  assert.ok(
    !JSON.stringify(f).includes("secret-internal-only-text"),
    "ungrounded text must not leak"
  );
});

test("V2: an evidence ref that does not resolve to a manifest signal is fabricated grounding", async () => {
  const f = await verifyLedger({
    manifest: MANIFEST,
    ledger: ledger({ claim: "made up", evidence: [ref("4-shared/nope.md", "99", "external")] }),
    audience: "external",
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, "V2");
});

test("V2: a path/row match with a SPOOFED tier does not resolve (and the claim is withheld)", async () => {
  // ref claims external, but the real signal at that path/row is admin → spoof.
  const f = await verifyLedger({
    manifest: MANIFEST,
    ledger: ledger({
      claim: "acquisition price is 40m",
      evidence: [ref("5-personal/acme-acquisition-secret.md", "7", "external")],
    }),
    audience: "external",
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, "V2");
  assert.ok(!JSON.stringify(f).includes("40m"), "spoofed-tier claim text must not leak");
  assert.ok(!JSON.stringify(f).includes("acquisition-secret"), "admin path must not leak");
});

// ── tier-policy + mixed support (V3/V7) ────────────────────────────────────────
const MIXED = ledger({
  claim: "We shipped X at a 40pct margin",
  evidence: [
    ref("4-shared/public.md", "1", "external"),
    ref("5-personal/acme-acquisition-secret.md", "7", "admin"),
  ],
});

test("V7: mixed external+admin claim must-fails for external WITHOUT a supportCheck", async () => {
  const f = await verifyLedger({ manifest: MANIFEST, ledger: MIXED, audience: "external" });
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, "V7");
  assert.equal(f[0].check, "support");
});

test("V7 anti-leak: the mixed claim's admin-derived text/path/row never appears in findings", async () => {
  const f = await verifyLedger({ manifest: MANIFEST, ledger: MIXED, audience: "external" });
  const ser = JSON.stringify(f);
  assert.ok(!ser.includes("40pct"), "admin-derived claim text must not leak");
  assert.ok(!ser.includes("acme-acquisition-secret"), "admin path must not leak");
  assert.ok(!ser.includes('"row":"7"') && !ser.includes('"row": "7"'), "admin row must not leak");
  // the withheld COUNT + tier is allowed (content-free).
  assert.match(f[0].detail, /admin-tier/);
});

test("V7: a blocking supportCheck that certifies clears the mixed claim", async () => {
  const f = await verifyLedger({
    manifest: MANIFEST,
    ledger: MIXED,
    audience: "external",
    supportCheck: (_entry, allowed) => allowed.every((r) => r.tier === "external"), // certify
  });
  assert.equal(f.length, 0);
});

test("V7: a supportCheck that returns false keeps the must-fail", async () => {
  const f = await verifyLedger({
    manifest: MANIFEST,
    ledger: MIXED,
    audience: "external",
    supportCheck: () => false,
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, "V7");
});

test("mixed claim is fine for the OWNER audience (private brief sees everything)", async () => {
  const f = await verifyLedger({ manifest: MANIFEST, ledger: MIXED, audience: "owner" });
  assert.equal(f.length, 0);
});

test("a team-only claim is withheld from an external audience but is clean (correctly redacted)", async () => {
  const f = await verifyLedger({
    manifest: MANIFEST,
    ledger: ledger({
      claim: "internal team note",
      evidence: [ref("2-work/notes.md", "2", "team")],
    }),
    audience: "external",
  });
  assert.equal(
    f.length,
    0,
    "a fully-withheld single-tier claim emits no finding (correctly dropped)"
  );
});

test("clean all-allowed ledger passes with no findings", async () => {
  const f = await verifyLedger({
    manifest: MANIFEST,
    ledger: ledger({ claim: "public win", evidence: [ref("4-shared/public.md", "1", "external")] }),
    audience: "external",
  });
  assert.equal(f.length, 0);
});

// ── bounded correction loop (status: pass/corrected/failed) ─────────────────────
test("budgetFor: daily 0, weekly 2", () => {
  assert.equal(budgetFor("daily"), 0);
  assert.equal(budgetFor("weekly"), 2);
});

test("runVerification: clean ledger → pass, loopsUsed 0", async () => {
  const r = await runVerification({
    manifest: MANIFEST,
    ledger: ledger({ claim: "public win", evidence: [ref("4-shared/public.md", "1", "external")] }),
    audience: "external",
    cadence: "weekly",
  });
  assert.equal(r.status, "pass");
  assert.equal(r.loopsUsed, 0);
  assert.equal(r.findings.length, 0);
});

test("runVerification: daily (budget 0) fails immediately on a must-fail — no correction", async () => {
  let called = 0;
  const r = await runVerification({
    manifest: MANIFEST,
    ledger: MIXED,
    audience: "external",
    cadence: "daily",
    correct: () => {
      called++;
      return MIXED;
    },
  });
  assert.equal(r.status, "failed");
  assert.equal(r.loopsUsed, 0);
  assert.equal(called, 0, "daily must not invoke the corrector (budget 0)");
});

test("runVerification: weekly + a corrector that fixes → corrected, loopsUsed 1", async () => {
  const fixed = ledger({
    claim: "We shipped X",
    evidence: [ref("4-shared/public.md", "1", "external")],
  });
  const r = await runVerification({
    manifest: MANIFEST,
    ledger: MIXED,
    audience: "external",
    cadence: "weekly",
    correct: () => fixed, // rewrite into an audience-safe (external-only) claim
  });
  assert.equal(r.status, "corrected");
  assert.equal(r.loopsUsed, 1);
  assert.equal(r.findings.length, 0);
});

test("runVerification: weekly + a corrector that never fixes → failed after budget loops (bounded)", async () => {
  let called = 0;
  const r = await runVerification({
    manifest: MANIFEST,
    ledger: MIXED,
    audience: "external",
    cadence: "weekly",
    correct: () => {
      called++;
      return MIXED; // never fixes
    },
  });
  assert.equal(r.status, "failed");
  assert.equal(r.loopsUsed, budgetFor("weekly"));
  assert.equal(called, budgetFor("weekly"), "the loop is bounded by the budget");
});

test("runVerification: a blocking supportCheck threads through and certifies the mixed claim", async () => {
  const r = await runVerification({
    manifest: MANIFEST,
    ledger: MIXED,
    audience: "external",
    cadence: "weekly",
    supportCheck: () => true,
  });
  assert.equal(r.status, "pass");
});

// ── advisory semantic seam ──────────────────────────────────────────────────────
test("semanticCheck populates advisory[] without changing status (weekly, advisory-only)", async () => {
  const r = await runVerification({
    manifest: MANIFEST,
    ledger: ledger({ claim: "public win", evidence: [ref("4-shared/public.md", "1", "external")] }),
    audience: "external",
    cadence: "weekly",
    semanticCheck: () => [
      {
        check: "evidence",
        ruleId: "ADV",
        entryIndex: 0,
        claimPreview: "note",
        detail: "prose drift?",
      },
    ],
  });
  assert.equal(r.status, "pass");
  assert.equal(r.advisory.length, 1);
  assert.equal(r.findings.length, 0);
});

test("advisory findings from semanticCheck are SANITIZED — a leaky hook cannot smuggle admin content", async () => {
  // A hook that maliciously/accidentally returns raw admin claim text, path, and row in its
  // claimPreview + detail. The verifier must re-derive the preview and scrub the detail.
  const r = await runVerification({
    manifest: MANIFEST,
    ledger: ledger({
      claim: "We shipped X at a 40pct margin",
      evidence: [
        ref("4-shared/public.md", "1", "external"),
        ref("5-personal/acme-acquisition-secret.md", "7", "admin"),
      ],
    }),
    audience: "external",
    cadence: "weekly",
    supportCheck: () => true, // clear the must-fail so we exercise the advisory path on a "shippable" entry
    semanticCheck: () => [
      {
        // every field is hook-controlled and stuffed with admin content / junk
        check: "the secret margin is 40pct", // bogus check value carrying admin text
        ruleId: "leak: 5-personal/acme-acquisition-secret.md row 7 = 40pct", // ruleId is printed by the CLI
        entryIndex: 999, // out of range
        claimPreview: "We shipped X at a 40pct margin", // raw admin-derived text
        detail: "see 5-personal/acme-acquisition-secret.md row 7 — 40pct margin",
      },
    ],
  });
  assert.equal(r.status, "pass");
  assert.equal(r.advisory.length, 1);
  const ser = JSON.stringify(r.advisory);
  assert.ok(
    !ser.includes("40pct"),
    "admin-derived text must not reach a shared advisory (any field)"
  );
  assert.ok(
    !ser.includes("acme-acquisition-secret"),
    "admin path must not reach a shared advisory"
  );
  // every hook-controlled field is replaced/validated for a shared audience
  assert.equal(r.advisory[0].claimPreview, "[advisory]"); // out-of-range entryIndex → safe fallback
  assert.equal(r.advisory[0].ruleId, "advisory");
  assert.equal(r.advisory[0].check, "evidence");
  assert.equal(r.advisory[0].entryIndex, -1);
  assert.match(r.advisory[0].detail, /withheld/);
});

test("advisory detail IS surfaced for the owner brief (no tier concern at owner)", async () => {
  const r = await runVerification({
    manifest: MANIFEST,
    ledger: ledger({
      claim: "private detail",
      evidence: [ref("5-personal/acme-acquisition-secret.md", "7", "admin")],
    }),
    audience: "owner",
    cadence: "weekly",
    semanticCheck: () => [
      {
        check: "evidence",
        ruleId: "ADV",
        entryIndex: 0,
        claimPreview: "private detail",
        detail: "prose drift on the margin note",
      },
    ],
  });
  assert.equal(r.advisory.length, 1);
  assert.equal(r.advisory[0].detail, "prose drift on the margin note");
});

test("V2 row-exactness: a ref with row '' does NOT resolve against a manifest signal that has no row", async () => {
  const manifestNoRow = {
    ...MANIFEST,
    signals: [{ ...sig("4-shared/public.md", undefined, "external") }],
  };
  // ref claims row:"" but the real signal has no row → must NOT resolve (fabricated grounding).
  const f = await verifyLedger({
    manifest: manifestNoRow,
    ledger: ledger({ claim: "x", evidence: [ref("4-shared/public.md", "", "external")] }),
    audience: "external",
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, "V2");
  // and the exact (no-row) ref DOES resolve cleanly
  const ok = await verifyLedger({
    manifest: manifestNoRow,
    ledger: ledger({ claim: "x", evidence: [ref("4-shared/public.md", undefined, "external")] }),
    audience: "external",
  });
  assert.equal(ok.length, 0);
});

test("semanticCheck does NOT run on the daily path", async () => {
  let called = 0;
  const r = await runVerification({
    manifest: MANIFEST,
    ledger: ledger({ claim: "public win", evidence: [ref("4-shared/public.md", "1", "external")] }),
    audience: "external",
    cadence: "daily",
    semanticCheck: () => {
      called++;
      return [];
    },
  });
  assert.equal(called, 0);
  assert.equal(r.advisory.length, 0);
});

// ── full-result anti-leak sweep ──────────────────────────────────────────────────
test("a full failed VerifierResult for an external audience leaks no admin text/path/row", async () => {
  const r = await runVerification({
    manifest: MANIFEST,
    ledger: ledger(
      {
        claim: "secret price 40m",
        evidence: [ref("5-personal/acme-acquisition-secret.md", "7", "admin")],
      },
      MIXED.entries[0]
    ),
    audience: "external",
    cadence: "weekly",
  });
  const ser = JSON.stringify(r);
  assert.ok(!ser.includes("40m"), "admin claim text must not leak");
  assert.ok(!ser.includes("40pct"), "mixed admin-derived text must not leak");
  assert.ok(!ser.includes("acme-acquisition-secret"), "admin path must not leak");
  assert.ok(!ser.includes('"7"'), "admin row must not leak");
});
