// C2 evidence ledger tests. The leak-critical behavior: a claim backed only by
// above-audience evidence must NOT emit its factual text to a lower-tier digest.

import test from "node:test";
import assert from "node:assert/strict";
import {
  visibleTiers,
  assertGrounded,
  redactForTier,
  resolveTier,
} from "../../dist/operator-loop/index.js";

test("resolveTier default-denies a multi-valued (malformed) access/audience", () => {
  assert.equal(resolveTier(["team", "admin"]), null); // must NOT resolve to "team"
  assert.equal(resolveTier(["team"]), "team"); // a single-element array is fine
  assert.equal(resolveTier("team"), "team");
  assert.equal(resolveTier("nonsense"), null);
  assert.equal(resolveTier("private"), "admin"); // alias still normalizes
});

const ref = (tier, row) => ({ path: "3-log/x.md", row, tier });

test("visibleTiers lattice: external⊂team⊂owner", () => {
  assert.deepEqual([...visibleTiers("external")].sort(), ["external"]);
  assert.deepEqual([...visibleTiers("team")].sort(), ["external", "team"]);
  assert.deepEqual([...visibleTiers("owner")].sort(), ["admin", "external", "team"]);
});

test("assertGrounded: zero-evidence claim is a hard fail", () => {
  assert.throws(() => assertGrounded({ claim: "x", evidence: [] }), /ungrounded/);
  assert.doesNotThrow(() => assertGrounded({ claim: "x", evidence: [ref("team", "1")] }));
});

test("admin-only evidence → no claim text emitted to an external digest", () => {
  const r = redactForTier(
    { claim: "the secret margin is 40%", evidence: [ref("admin", "1")] },
    "external"
  );
  assert.equal(r.emit, false);
  assert.ok(!JSON.stringify(r.entry).includes("secret margin"), "claim text must not leak");
  assert.match(r.entry.claim, /withheld/);
  assert.match(r.placeholder, /admin/);
});

test("team-tier source is withheld from an external digest too (not just admin)", () => {
  const r = redactForTier(
    { claim: "internal team note", evidence: [ref("team", "1")] },
    "external"
  );
  assert.equal(r.emit, false);
  assert.match(r.entry.claim, /withheld/);
  assert.match(r.placeholder, /team/);
});

test("mixed evidence → emit with requiresIndependentSupport + visible withheld count", () => {
  const r = redactForTier(
    { claim: "we shipped X", evidence: [ref("external", "1"), ref("admin", "2")] },
    "external"
  );
  assert.equal(r.emit, true);
  assert.equal(r.entry.requiresIndependentSupport, true);
  assert.equal(r.entry.evidence.length, 1);
  assert.equal(r.entry.evidence[0].tier, "external");
  // withheld is a count-by-tier summary, NOT raw refs (no path/row leak).
  assert.equal(r.entry.withheld.length, 1);
  assert.deepEqual(r.entry.withheld[0], { tier: "admin", count: 1 });
  assert.equal(r.entry.claim, "we shipped X");
});

test("withheld never leaks the above-audience source path/row into a digest entry", () => {
  const r = redactForTier(
    {
      claim: "we shipped X",
      evidence: [
        { path: "4-shared/public.md", row: "9", tier: "external" },
        { path: "5-personal/acme-acquisition-secret.md", row: "3", tier: "admin" },
      ],
    },
    "external"
  );
  const serialized = JSON.stringify(r.entry);
  assert.ok(!serialized.includes("acme-acquisition-secret"), "admin path must not appear");
  assert.ok(!serialized.includes('"row":"3"'), "admin row must not appear");
  // the allowed external ref is fine to keep
  assert.ok(serialized.includes("4-shared/public.md"));
});

test("all-allowed evidence → emit, nothing withheld", () => {
  const r = redactForTier({ claim: "public note", evidence: [ref("external", "1")] }, "external");
  assert.equal(r.emit, true);
  assert.ok(!r.entry.withheld || r.entry.withheld.length === 0);
  assert.ok(!r.entry.requiresIndependentSupport);
});

test("owner audience sees admin evidence (private brief)", () => {
  const r = redactForTier({ claim: "private detail", evidence: [ref("admin", "1")] }, "owner");
  assert.equal(r.emit, true);
  assert.equal(r.entry.claim, "private detail");
});
