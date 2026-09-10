// Contract-only proof: no production route, parser, authorization or database is executed here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
const root = new URL("../docs/contract/", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const json = (p) => JSON.parse(read(p));
const ref = json("brain-contract.json").debtIntakeEventsContract;
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])])
        )
      : v;
const digest = (domain, v) =>
  createHash("sha256")
    .update(domain + "\0" + JSON.stringify(canonical(v)))
    .digest("hex");
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(json(ref.canonicalSchema.path));
const request = ajv.compile(json(ref.schema.path));
const ack = ajv.compile(json(ref.ackSchema.path));
const envelope = (events) => ({ schema_version: "debt-intake-events.v1", events });
const sets = ref.canonicalFixtures.map((r) => ({
  name: r.path,
  records: read(r.path).trimEnd().split("\n").map(JSON.parse),
}));
const candidate = sets.flatMap((s) => s.records).find((r) => r.record_type === "candidate");
const summary = sets.flatMap((s) => s.records).find((r) => r.record_type === "run_summary");

test("intake references are content-addressed at reserved API1.26 and exact Harness pins", () => {
  assert.equal(ref.version, "1.26");
  assert.equal(ref.method, "POST");
  assert.equal(ref.route, "/api/v1/codebases/:slug/debt-intake-events");
  assert.equal(
    ref.canonicalSchema.sha256,
    "a51f360769ab26440287891867447baf6e3df93073df6f0d7febc1f3c10322b2"
  );
  assert.equal(
    ref.canonicalContract.sha256,
    "b23baa16b0055e4841584433390c9412ac11c922a333dec35cae45108761e0ac"
  );
  for (const r of [
    ref.schema,
    ref.ackSchema,
    ref.canonicalSchema,
    ref.canonicalContract,
    ref.fixtures,
    ref.knownAnswers,
    ref.trustedConfig,
    ...ref.canonicalFixtures,
  ])
    assert.equal(createHash("sha256").update(read(r.path)).digest("hex"), r.sha256, r.path);
});
test("all canonical positive ledgers satisfy Draft2020-12 request structure and unchanged known-answer identities", () => {
  for (const s of sets) {
    assert.ok(request(envelope(s.records)), s.name + JSON.stringify(request.errors));
    for (const r of s.records) {
      const { event_id, ...value } = r;
      assert.equal(digest("aios.finding.event.v1", value), event_id);
      if (r.record_type === "candidate")
        assert.equal(digest("aios.finding.candidate.discovery.v1", r.identity), r.candidate_id);
    }
  }
  const known = json(ref.knownAnswers.path);
  assert.equal(JSON.stringify(canonical(known.identity)), known.canonical_identity_utf8);
  assert.equal(digest("aios.finding.candidate.discovery.v1", known.identity), known.candidate_id);
  assert.ok(sets.flatMap((s) => s.records).some((r) => r.event_id === known.discovered_event_id));
});
test("closed request and record union reject smuggling, omissions and event bounds", () => {
  assert.ok(request(envelope([candidate, summary])));
  assert.ok(request(envelope(Array(256).fill(summary))));
  for (const v of [
    envelope([]),
    envelope(Array(257).fill(summary)),
    { ...envelope([summary]), team_id: "secret" },
    { events: [summary] },
    envelope([{ ...candidate, raw_content: "secret" }]),
    envelope([{ ...summary, record_type: "other" }]),
    envelope([{ ...candidate, links: undefined }]),
  ])
    assert.equal(request(v), false, JSON.stringify(v).slice(0, 150));
  assert.equal(ref.maxRawBodyBytes, 1048576); // Actual streaming ceiling belongs to the future route.
});
test("closed ack structure validates replay and rejects rejected-buckets, unsafe IDs and duplicates", () => {
  for (const a of [
    { status: "ok", accepted_event_ids: [candidate.event_id], duplicate_event_ids: [] },
    { status: "ok", accepted_event_ids: [], duplicate_event_ids: [candidate.event_id] },
  ])
    assert.ok(ack(a));
  for (const a of [
    { status: "ok", accepted_event_ids: [], duplicate_event_ids: [], rejected: [] },
    { status: "ok", accepted_event_ids: ["raw"], duplicate_event_ids: [] },
    {
      status: "ok",
      accepted_event_ids: [],
      duplicate_event_ids: [candidate.event_id, candidate.event_id],
    },
  ])
    assert.equal(ack(a), false);
});
test("future semantic fixtures retain disjoint ordered acknowledgments and honest proof ownership", () => {
  const fx = json(ref.fixtures.path);
  assert.equal(new Set(fx.cases.map((c) => c.name)).size, fx.cases.length);
  for (const c of fx.cases) {
    assert.ok(["future-brain", "future-publisher"].includes(c.proofOwner));
    const e = c.expected;
    if (e.accepted_event_ids) {
      assert.ok(
        ack({
          status: "ok",
          accepted_event_ids: e.accepted_event_ids,
          duplicate_event_ids: e.duplicate_event_ids,
        })
      );
      assert.equal(
        e.accepted_event_ids.some((id) => e.duplicate_event_ids.includes(id)),
        false
      );
    }
  }
  for (const name of [
    "complete-zero",
    "unknown-provider-failure",
    "audit-failure",
    "concurrent-replay",
    "sequence-fork",
    "bounded-out-of-order-then-finalize",
    "late-new-record-after-finalization",
    "ordinary-team-impersonation",
    "revoked-uploader-replay",
    "zero-without-inventory-attestation",
  ])
    assert.ok(fx.cases.some((c) => c.name === name));
});
