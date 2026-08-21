// AIO-608 / AIO-995 / AIO-1011 — contract guard for the Brain API 1.23 codebase-scan payload
// (POST /api/v1/codebases, including the optional scalar-only `metrics.codebase_health`
// object introduced at 1.15, and the six coverage-denominator / run-integrity measures
// introduced at document revision 1.22).
//
// Pattern mirrors test/item-payload-contract.test.mjs + test/item-payload-schema-parity.test.mjs:
//   1. docs/contract/codebase-payload-1.23.schema.json — the machine-readable contract
//      (draft 2020-12, compiled here with ajv), referenced normatively from docs/brain-api.md.
//   2. docs/contract/codebase-payload-1.23-fixtures.json — canonical fixtures, both buckets
//      cross-checked against the compiled schema.
//
// Unlike the item-payload suite there is no second, hand-written client-side validator to
// establish parity with: this repo's `aios assess-codebase` is offline/read-only (its sparse
// `--push` was removed at the 2026-06-19 revision) and the canonical pusher is the ingestion
// sidecar (`aios-ingest scan`), which lives outside this repo. The ajv-compiled schema is the
// single executable oracle here, so this suite asserts (a) fixture agreement in both buckets
// and (b) deterministic boundary probes generated FROM the schema's own structure — the same
// probe classes the parity suite uses (missing required keys, unknown keys where the shape is
// closed, wrong types, wrong enums) — so a hand-edit to schema or fixtures that flips a
// documented invariant fails loudly.
//
// Load-bearing invariants probed below (see docs/brain-api.md, revision 1.22):
//   - additive: a pre-1.15 payload without `codebase_health` stays valid;
//   - never sparse: `codebase_health` cannot ride on a partial metrics block (the metrics
//     upsert REPLACES the (codebase_id, head_sha) row, so a health-only push zeroes analytics);
//   - provenance-only + scalars-only: `codebase_health` is closed — no extra keys, so no
//     file paths, findings text, or contributor identity can be smuggled through it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(ROOT, "docs/contract/codebase-payload-1.23.schema.json"), "utf8")
);
const fixtures = JSON.parse(
  readFileSync(path.join(ROOT, "docs/contract/codebase-payload-1.23-fixtures.json"), "utf8")
);

// No `format` keywords appear anywhere in the schema (measured_at is pinned by `pattern`),
// so ajv-formats is unnecessary — plain ajv is a faithful compile of the contract.
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

function verdict(payload) {
  return Boolean(validate(structuredClone(payload)));
}

test("fixtures file tracks the 1.23 contract revision", () => {
  assert.equal(fixtures.version, "1.23");
  assert.ok(fixtures.valid.length >= 3, "expected at least 3 valid fixtures");
  assert.ok(fixtures.invalid.length >= 3, "expected at least 3 invalid fixtures");
});

test("accepts every canonical Brain API 1.23 codebase-payload fixture", () => {
  for (const fixture of fixtures.valid) {
    assert.equal(verdict(fixture.payload), true, fixture.name);
  }
});

test("rejects every canonical Brain API 1.23 invalid fixture", () => {
  for (const fixture of fixtures.invalid) {
    assert.equal(verdict(fixture.payload), false, fixture.name);
  }
});

// ---------------------------------------------------------------------------------------
// Generated boundary probes, derived from each VALID fixture + the schema's own required
// lists — deterministic, no randomness (same approach as item-payload-schema-parity).
// ---------------------------------------------------------------------------------------

const METRICS_REQUIRED = schema.properties.metrics.required;
const HEALTH_SCHEMA = schema.$defs.codebaseHealth;

function healthFixtures() {
  return fixtures.valid.filter((f) => f.payload.metrics.codebase_health);
}

test("dropping any single required metrics field invalidates the payload (never sparse)", () => {
  let probes = 0;
  for (const fixture of fixtures.valid) {
    for (const key of METRICS_REQUIRED) {
      const p = structuredClone(fixture.payload);
      delete p.metrics[key];
      assert.equal(
        verdict(p),
        false,
        `${fixture.name}: deleting required metrics key "${key}" must invalidate`
      );
      probes += 1;
    }
  }
  assert.ok(probes >= METRICS_REQUIRED.length * 2, `expected broad coverage, got ${probes}`);
});

test("dropping any single required codebase_health field invalidates the payload", () => {
  const carriers = healthFixtures();
  assert.ok(carriers.length >= 2, "need at least two health-carrying valid fixtures");
  for (const fixture of carriers) {
    for (const key of HEALTH_SCHEMA.required) {
      const p = structuredClone(fixture.payload);
      delete p.metrics.codebase_health[key];
      assert.equal(
        verdict(p),
        false,
        `${fixture.name}: deleting required codebase_health key "${key}" must invalidate`
      );
    }
  }
});

test("removing codebase_health entirely keeps the payload valid (additive, old payloads OK)", () => {
  for (const fixture of healthFixtures()) {
    const p = structuredClone(fixture.payload);
    delete p.metrics.codebase_health;
    assert.equal(verdict(p), true, `${fixture.name}: without codebase_health must stay valid`);
  }
});

test("codebase_health is closed: any unknown key is rejected (scalars-only surface)", () => {
  assert.equal(HEALTH_SCHEMA.additionalProperties, false, "health subschema must be closed");
  for (const fixture of healthFixtures()) {
    const p = structuredClone(fixture.payload);
    p.metrics.codebase_health.__unknown = "smuggled";
    assert.equal(verdict(p), false, `${fixture.name}: unknown codebase_health key must invalidate`);
  }
});

test("codebase_health wrong enum / wrong type probes are rejected", () => {
  const base = healthFixtures()[0].payload;
  const mutations = [
    ["status = bogus enum value", (h) => (h.status = "amber")],
    ["score_pct = string", (h) => (h.score_pct = "high")],
    ["score_pct > 100", (h) => (h.score_pct = 101)],
    ["head_sha = non-hex", (h) => (h.head_sha = "not-a-sha")],
    ["dimensions = array", (h) => (h.dimensions = [])],
    ["dimensions value missing total", (h) => (h.dimensions = { structure: { passed: 1 } })],
    [
      "dimensions passed = negative",
      (h) => (h.dimensions = { structure: { passed: -1, total: 2 } }),
    ],
    ["failed_invariant_ids = string", (h) => (h.failed_invariant_ids = "OGR04")],
    [
      "failed_invariant_ids item = path-like (slash rejected)",
      (h) => (h.failed_invariant_ids = ["3-log/decision-log.md"]),
    ],
    ["measured_at = bare date", (h) => (h.measured_at = "2026-07-30")],
    ["schema_version = number", (h) => (h.schema_version = 1)],
  ];
  for (const [name, mutate] of mutations) {
    const p = structuredClone(base);
    mutate(p.metrics.codebase_health);
    assert.equal(verdict(p), false, `probe must be rejected: ${name}`);
  }
});

test("unknown top-level payload key is rejected (top level is closed)", () => {
  const p = structuredClone(fixtures.valid[0].payload);
  p.__unknown = true;
  assert.equal(verdict(p), false);
});

test("schema stays in lockstep with docs/brain-api.md's documented header revision", () => {
  const doc = readFileSync(path.join(ROOT, "docs/brain-api.md"), "utf8");
  const m = doc.match(/\*\*Version:\s*([0-9]+\.[0-9]+)\*\*/);
  assert.ok(m, "brain-api.md must state **Version: X.Y**");
  // Scanner identity entered at 1.23; the doc revision may move past it but never behind it.
  // This is what makes a version bump that forgets THIS file fail loudly — the gap AIO-995
  // shipped through once already, when only the hash fixture was bumped and the executable
  // contract stayed at 1.15, licensing payloads the brain then rejected. Moving THIS bound is
  // therefore part of every bump: leaving it at 22 would let 1.24 ship against a 1.22 schema
  // exactly as 1.22 shipped against a 1.15 one.
  const [major, minor] = m[1].split(".").map(Number);
  assert.ok(major > 1 || (major === 1 && minor >= 23), `doc version ${m[1]} predates 1.23`);
  assert.match(schema.$id, /\/1\.23\//, "schema $id must be pinned at its own revision");
  assert.equal(
    fixtures.version,
    m[1],
    "fixtures, schema $id and brain-api.md must state one revision"
  );
});

// ---------------------------------------------------------------------------------------
// 1.23 — scanner identity (AIO-1011). The payload declares WHICH SCANNER BUILD produced it,
// so the brain can say "this repo's scanner predates what the contract needs" instead of
// rendering an unexplained "(scope unknown)".
//
// The invariant these probe is not "is it well-formed" but **what a malformed value costs**.
// A rejected payload drops the repo's ENTIRE scan — metrics, findings, contributions, issues —
// and returns before the ingest run is recorded, so the failure is not even logged. A version
// string is provenance; it can never be worth that. Hence: bounded, typed, and otherwise
// permissive, with the brain normalizing anything it cannot read to "unknown".
// ---------------------------------------------------------------------------------------

const SCANNER_IDENTITY = ["scanner_version", "scanner_sha"];

test("scanner identity is additive: a pre-1.23 payload without it stays valid", () => {
  for (const fixture of fixtures.valid) {
    const p = structuredClone(fixture.payload);
    for (const key of SCANNER_IDENTITY) delete p.metrics[key];
    assert.equal(verdict(p), true, `${fixture.name}: without scanner identity must stay valid`);
  }
});

test("scanner identity is nullable: explicit null is a sendable value (unknown build)", () => {
  const p = structuredClone(fixtures.valid[0].payload);
  for (const key of SCANNER_IDENTITY) p.metrics[key] = null;
  assert.equal(verdict(p), true);
});

test("an UNPARSEABLE scanner version is accepted, never rejected", () => {
  // The one probe that would be easy to get backwards. "nightly", "" and a git-describe string
  // are all things a fork or a local build can emit. None of them is a reason to throw away a
  // repository's whole scan; all of them are reasons to read the scanner as unknown.
  for (const bogus of ["nightly", "", "v0.2.0-dirty", "0.2", "not a version at all"]) {
    const p = structuredClone(fixtures.valid[0].payload);
    p.metrics.scanner_version = bogus;
    assert.equal(verdict(p), true, `scanner_version ${JSON.stringify(bogus)} must be accepted`);
  }
});

test("scanner identity is a bounded string or null — nothing else", () => {
  for (const key of SCANNER_IDENTITY) {
    for (const bad of [2, true, {}, [], "x".repeat(65)]) {
      const p = structuredClone(fixtures.valid[0].payload);
      p.metrics[key] = bad;
      assert.equal(verdict(p), false, `${key} = ${JSON.stringify(bad)} must be rejected`);
    }
  }
});

test("scanner identity carries no `pattern` — shape is the scanner's promise, not the gate", () => {
  // Deliberate, and the inverse of 1.22's mistake. A `pattern` here would make the canonical
  // contract STRICTER than the brain, so a payload valid by the implementation would read as
  // invalid by the contract — the same drift class as 1.22 (contract looser than brain),
  // pointed the other way. Assert the absence so nobody "tightens" it without reading this.
  const props = schema.properties.metrics.properties;
  for (const key of SCANNER_IDENTITY) {
    assert.ok(props[key], `${key} must be documented in the schema`);
    assert.equal(props[key].pattern, undefined, `${key} must not pin a pattern`);
    assert.deepEqual(props[key].type, ["string", "null"]);
  }
});
