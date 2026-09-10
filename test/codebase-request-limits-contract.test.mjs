// AUDITFIX-17 / AIO-1136 — contract guard for the codebase request-admission supplement
// (docs/contract/codebase-request-limits-v1.json), the executable statement of the two
// admission bounds on POST /api/v1/codebases: `metrics.recent_commits` at 100 elements and
// the request body at 2,400,000 bytes.
//
// This supplement is deliberately NOT a JSON Schema and NOT a member-API revision: it is a
// separately versioned resource-admission descriptor published under the change policy's
// resource-admission exception, so there is no ajv oracle to compile it against (contrast
// test/codebase-payload-contract.test.mjs, which compiles the payload SHAPE schema). What can
// silently rot here is different, so that is what this suite pins:
//
//   1. Identity/applicability — the fields a consumer keys on to decide whether the supplement
//      applies to the brain it is talking to.
//   2. Internal consistency — every published boundary case must FOLLOW from the declared
//      limit. A hand-edit that raises `maxRecentCommits` and forgets the 101-rejected case
//      (or vice versa) ships a contract that contradicts itself, and both halves are copied
//      into two repos' test suites.
//   3. Non-vacuity — the cases must actually straddle each limit. A boundaryCases block of
//      only-admitted values would satisfy (2) trivially.
//   4. The published error messages must carry the literal ceilings. The route answers with the
//      FIRST issue only, so the message is the caller's whole diagnosis; a limit changed without
//      its message is a contract that lies to the operator it exists to help.
//   5. docs/brain-api.md must name this file and state the same two literals, and must NOT have
//      bumped the member-facing version to claim it — the supplement is versioned on its own
//      `revision`, and the member API deliberately stays 1.24 (only the document revision moved,
//      to 1.25, for the deployment note below).
//   6. The document must keep publication and deployment distinct. Nothing on the wire tells a
//      caller whether the brain it is talking to enforces these limits yet, so the doc has to say
//      so; the easy rot is a later edit that reads the published contract, or the "from 1.23"
//      eligibility range, as an enforcement guarantee.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPPLEMENT_REL = "docs/contract/codebase-request-limits-v1.json";
const supplement = JSON.parse(readFileSync(path.join(ROOT, SUPPLEMENT_REL), "utf8"));
const brainApi = readFileSync(path.join(ROOT, "docs/brain-api.md"), "utf8");

test("supplement declares its kind, revision and the endpoint it bounds", () => {
  assert.equal(supplement.kind, "aios-codebase-request-limits");
  assert.equal(supplement.revision, 1);
  assert.equal(supplement.method, "POST");
  assert.equal(supplement.path, "/api/v1/codebases");
});

test("applicability is an open-ended major-1 range from 1.23, not a finite version list", () => {
  assert.equal(supplement.memberApiMajor, 1);
  // A string, not a number: 1.23 as a float would compare wrong against 1.3 and would also
  // silently lose a future 1.230.
  assert.equal(supplement.appliesFromMemberApiVersion, "1.23");
  assert.equal(typeof supplement.applicability, "string");
  assert.match(supplement.applicability, /not \/api\/v2/);
  // The supplement must not enumerate the revisions it covers — it covers subsequent 1.x
  // revisions until explicitly superseded or withdrawn.
  assert.equal(supplement.appliesToMemberApiVersions, undefined);
});

test("published boundary cases follow from the declared limits", () => {
  const { maxRecentCommits, maxBodyBytes, boundaryCases } = supplement;
  assert.equal(Number.isInteger(maxRecentCommits) && maxRecentCommits > 0, true);
  assert.equal(Number.isInteger(maxBodyBytes) && maxBodyBytes > 0, true);

  for (const testCase of boundaryCases.recentCommits) {
    assert.equal(
      testCase.admitted,
      testCase.count <= maxRecentCommits,
      `recent_commits count ${testCase.count} contradicts maxRecentCommits ${maxRecentCommits}`
    );
  }
  for (const testCase of boundaryCases.body) {
    assert.equal(
      testCase.admitted,
      testCase.bytes <= maxBodyBytes,
      `body ${testCase.bytes} bytes contradicts maxBodyBytes ${maxBodyBytes}`
    );
  }
});

test("boundary cases straddle both limits (the consistency check above is non-vacuous)", () => {
  const { maxRecentCommits, maxBodyBytes, boundaryCases } = supplement;
  const counts = boundaryCases.recentCommits.map((c) => c.count);
  const byteSizes = boundaryCases.body.map((c) => c.bytes);

  // Exactly-at and exactly-over, for each limit: an inclusive ceiling is only pinned by both.
  assert.ok(counts.includes(maxRecentCommits), "no case at exactly maxRecentCommits");
  assert.ok(counts.includes(maxRecentCommits + 1), "no case at maxRecentCommits + 1");
  assert.ok(counts.includes(0), "no empty-array case (the array is required but may be empty)");
  assert.ok(byteSizes.includes(maxBodyBytes), "no case at exactly maxBodyBytes");
  assert.ok(byteSizes.includes(maxBodyBytes + 1), "no case at maxBodyBytes + 1");

  assert.ok(
    boundaryCases.recentCommits.some((c) => c.admitted === false),
    "recentCommits cases are all admitted — nothing proves the ceiling rejects"
  );
  assert.ok(
    boundaryCases.body.some((c) => c.admitted === false),
    "body cases are all admitted — nothing proves the ceiling rejects"
  );
  // The cases are only meaningful under the stated precondition that nothing ELSE is wrong
  // with the payload; without it "count 100 admitted" is not a statement anyone can test.
  assert.match(supplement.boundaryCasePrecondition, /other existing payload constraints pass/);
});

test("error envelopes name the status, code and the literal ceiling the caller must respect", () => {
  const { body, recentCommits } = supplement.errors;

  assert.equal(body.status, 413);
  assert.equal(body.code, "payload_too_large");
  assert.ok(
    body.message.includes(String(supplement.maxBodyBytes)),
    `413 message must state ${supplement.maxBodyBytes}: ${body.message}`
  );

  assert.equal(recentCommits.status, 422);
  assert.equal(recentCommits.code, "invalid_payload");
  assert.ok(
    recentCommits.message.includes(String(supplement.maxRecentCommits)),
    `422 message must state ${supplement.maxRecentCommits}: ${recentCommits.message}`
  );
  assert.ok(
    recentCommits.message.startsWith("metrics.recent_commits:"),
    "the 422 message must name the offending field, not just the ceiling"
  );

  // Batching is the recovery a caller reaches for and the one that destroys data here: the
  // metrics upsert REPLACES the (codebase_id, head_sha) row, so a split snapshot loses the
  // first half. Both messages must say so.
  for (const message of [body.message, recentCommits.message]) {
    assert.match(message, /do not split a snapshot across pushes/);
  }
});

test("body measurement is documented as wire bytes, with Content-Length non-authoritative", () => {
  assert.match(supplement.bodyMeasurement, /Request\.body/);
  assert.match(supplement.bodyMeasurement, /inclusive limit/);
  assert.match(supplement.bodyMeasurement, /Content-Length is not authoritative/);
});

test("brain-api.md adopts this supplement by name and repeats its literals", () => {
  assert.ok(
    brainApi.includes("contract/codebase-request-limits-v1.json"),
    "docs/brain-api.md must link the supplement it adopts"
  );
  assert.ok(
    brainApi.includes(supplement.errors.recentCommits.message),
    "docs/brain-api.md must publish the exact 422 message"
  );
  assert.ok(
    brainApi.includes(supplement.errors.body.message),
    "docs/brain-api.md must publish the exact 413 message"
  );
  // The resource-admission exception is what licenses a v1 tightening without /api/v2.
  assert.match(brainApi, /Resource-admission exception/);
  // …and the coordinated rollback, which is the half of the exception that is easy to omit.
  assert.match(brainApi, /Coordinated rollback/);
});

test("adopting the supplement did NOT bump the member-facing API version", () => {
  // Historical activation must remain explicit without freezing subsequent additive revisions.
  const activation = brainApi.match(
    /2026-09-07 — \*\*request-admission supplement[\s\S]*?\*\*Publication is not deployment\.\*\*/
  )?.[0];
  assert.ok(activation, "the dated supplement activation remains documented");
  const prose = activation.replace(/\s+/g, " ");
  assert.match(prose, /\*\*No member-facing version bump\.\*\* The member API stays \*\*1\.24\*\*/);
  assert.match(prose, /only the document revision moves \(\*\*1\.25\*\*/);
});

test("enforcement is documented as per-deployment, not implied by publication or version", () => {
  // Phrase matching against wrapped prose: collapse the markdown's hard wraps first, otherwise
  // every assertion here is really an assertion about where the line breaks fall.
  const prose = brainApi.replace(/\s+/g, " ");

  assert.match(prose, /\*\*Enforcement is per deployed instance\.\*\*/);
  // Deployment of the patched build is the activating event — nothing else is.
  assert.match(
    prose,
    /enforces them only once that instance is running a Brain build that contains the AUDITFIX-17 enforcement/
  );
  assert.match(prose, /Publication of the canonical contract activates nothing by itself/);
  // Reported API version is not evidence of the patch, and the supplement's applicability range is
  // eligibility, not an enforcement claim — these are the two inferences a reader will reach for.
  assert.match(
    prose,
    /an instance reporting member API \*\*1\.23\*\* or \*\*1\.24\*\* is reporting its API version/
  );
  assert.match(
    prose,
    /states the \*eligible\* member-API range for this supplement, not that every instance in that range enforces it/
  );
  assert.match(
    prose,
    /An instance on an older build retains the previous behaviour .{0,120} until it is upgraded/
  );
  // The applicability floor the prose refers to must still be the one the supplement declares.
  assert.equal(supplement.appliesFromMemberApiVersion, "1.23");
});
