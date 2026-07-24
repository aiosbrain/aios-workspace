// AIO-508 — dev-only parity guard between the two independent implementations of the Brain
// API 1.12 item-payload contract:
//   1. docs/contract/item-payload-1.12.schema.json — the vendored JSON Schema the Team Brain
//      executes server-side (draft 2020-12, compiled here with ajv).
//   2. scripts/workspace-parse.mjs's validateItemPayload export — the hand-written guard
//      `aios push` runs client-side, pre-POST, so a bad payload never leaves the machine.
//
// Both files are byte-identity SHA-guarded against the Brain's vendored copies by
// test/contract-conformance.test.mjs (do not edit the schema, the fixtures, or
// validateItemPayload from this file or any other — that would silently break the pin).
// This suite treats both as read-only oracles and asks a narrower question: do they agree,
// not just on the 15 fixtures in docs/contract/item-payload-1.12-fixtures.json, but on a
// much larger set of deterministic boundary probes generated FROM the schema itself
// (unknown keys, missing required keys, string length bounds, empty rows, wrong enums,
// wrong types)? Disagreement here means a real drift between the executed contract and the
// pre-flight guard — exactly the class of bug the shared-fixture test can't catch because
// fixtures are hand-picked, not exhaustive.
//
// Wrapping note: both validators operate on the SAME top-level item-payload object. The
// schema's per-kind row shape is expressed as `allOf`/`if`/`then` on the one root schema
// (not a separate per-kind schema to dispatch to), and validateItemPayload switches on
// `input.kind` internally — so every probe below is validated once, against the whole
// object, through both paths. No separate "unwrap to the per-kind branch" step is needed.
//
// Verdict normalization: ajv's `validate(payload)` already returns a boolean. validateItemPayload
// returns `{ success: boolean }` (it does not throw) — normalize by reading `.success`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { validateItemPayload } from "../scripts/workspace-parse.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(ROOT, "docs/contract/item-payload-1.12.schema.json"), "utf8")
);
const fixtures = JSON.parse(
  readFileSync(path.join(ROOT, "docs/contract/item-payload-1.12-fixtures.json"), "utf8")
);

// No `format` keywords appear anywhere in the schema (grep-verified), so ajv-formats is
// unnecessary — plain ajv is a faithful compile of the contract.
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

function schemaVerdict(payload) {
  return Boolean(validateSchema(structuredClone(payload)));
}

function validatorVerdict(payload) {
  return validateItemPayload(structuredClone(payload)).success === true;
}

// Documented, explicit known-divergence exceptions. Every generated probe and every fixture
// is checked against this list before asserting agreement: an empty entry set means "the
// two implementations agree everywhere probed" (true as of writing — see the teeth-check in
// the AIO-508 PR description for how this suite was verified to actually catch drift). If a
// real divergence is ever found, add `{ name, reason }` here instead of weakening the
// assertion, and the loop below will (a) skip the strict-agreement assert for that probe and
// (b) fail loudly if the two implementations ever start agreeing again, so the exception
// doesn't silently go stale.
const KNOWN_DIVERGENCES = new Map(
  // e.g. ["probe name", "one-line reason the schema and validateItemPayload legitimately differ here"]
  []
);

let probeCount = 0;

function agree(name, payload) {
  probeCount += 1;
  const schemaOk = schemaVerdict(payload);
  const validatorOk = validatorVerdict(payload);
  const known = KNOWN_DIVERGENCES.get(name);
  if (known) {
    assert.notEqual(
      schemaOk,
      validatorOk,
      `known-divergence entry "${name}" (${known}) no longer diverges — remove it from ` +
        `KNOWN_DIVERGENCES. probe=${JSON.stringify(payload)}`
    );
    return;
  }
  assert.equal(
    schemaOk,
    validatorOk,
    `schema/validator verdict mismatch for "${name}": schema=${schemaOk} validator=${validatorOk}. ` +
      `probe=${JSON.stringify(payload)}`
  );
}

// ---------------------------------------------------------------------------------------
// 1. Fixture agreement — the 15 shared fixtures, cross-checked against BOTH oracles (not
// just their own published `valid`/`invalid` bucket, so a fixture that's wrong about its
// own bucket would also surface here).
// ---------------------------------------------------------------------------------------

test("every valid fixture is accepted by both the schema and validateItemPayload", () => {
  for (const fixture of fixtures.valid) {
    agree(`fixture valid: ${fixture.name}`, fixture.payload);
    assert.equal(schemaVerdict(fixture.payload), true, `${fixture.name}: schema should accept`);
    assert.equal(
      validatorVerdict(fixture.payload),
      true,
      `${fixture.name}: validateItemPayload should accept`
    );
  }
});

test("every invalid fixture is rejected by both the schema and validateItemPayload", () => {
  for (const fixture of fixtures.invalid) {
    agree(`fixture invalid: ${fixture.name}`, fixture.payload);
    assert.equal(schemaVerdict(fixture.payload), false, `${fixture.name}: schema should reject`);
    assert.equal(
      validatorVerdict(fixture.payload),
      false,
      `${fixture.name}: validateItemPayload should reject`
    );
  }
});

// ---------------------------------------------------------------------------------------
// 2. Generated boundary probes, derived from each VALID fixture + the schema's own
// structure (required lists, string length bounds, enums) — deterministic, no randomness.
// ---------------------------------------------------------------------------------------

const ROW_DEF_BY_KIND = {
  task: "taskRow",
  decision: "decisionRow",
  fact: "factRow",
  stakeholder_mention: "stakeholderMentionRow",
};

// Pull every string field's {min, max} straight from a JSON Schema `properties` object,
// skipping fields with a `pattern` (content_sha256, occurred_at) — a length-boundary probe
// on a pattern-constrained field is meaningless without also holding the pattern, and those
// fields are already covered by the fixtures' own pattern-violation cases.
function stringBounds(properties) {
  const bounds = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    if (propSchema.pattern) continue;
    const types = Array.isArray(propSchema.type) ? propSchema.type : [propSchema.type];
    if (!types.includes("string")) continue;
    if (propSchema.maxLength === undefined) continue;
    bounds[key] = { min: propSchema.minLength ?? 0, max: propSchema.maxLength };
  }
  return bounds;
}

const TOP_LEVEL_BOUNDS = stringBounds(schema.properties);

function* generateProbes() {
  for (const fixture of fixtures.valid) {
    const base = fixture.payload;
    const label = fixture.name;

    // --- unknown key at each object level ---
    yield {
      name: `${label}: unknown top-level key`,
      payload: { ...structuredClone(base), __unknown: true },
    };
    if (base.frontmatter) {
      const p = structuredClone(base);
      p.frontmatter.__unknown = true;
      yield { name: `${label}: unknown frontmatter key`, payload: p };
    }
    if (base.rows) {
      for (let i = 0; i < base.rows.length; i++) {
        const p = structuredClone(base);
        p.rows[i].__unknown = true;
        yield { name: `${label}: unknown key in rows[${i}]`, payload: p };
      }
    }

    // --- delete each top-level required key ---
    for (const key of schema.required) {
      const p = structuredClone(base);
      delete p[key];
      yield { name: `${label}: delete required top-level key "${key}"`, payload: p };
    }

    // --- delete each required key in every row ---
    const rowDefName = ROW_DEF_BY_KIND[base.kind];
    if (base.rows && rowDefName) {
      const rowSchema = schema.$defs[rowDefName];
      for (let i = 0; i < base.rows.length; i++) {
        for (const key of rowSchema.required) {
          const p = structuredClone(base);
          delete p.rows[i][key];
          yield { name: `${label}: delete required row key "${key}" in rows[${i}]`, payload: p };
        }
      }
    }

    // --- string maxLength/minLength boundary probes: top-level fields ---
    for (const [key, { min, max }] of Object.entries(TOP_LEVEL_BOUNDS)) {
      {
        const p = structuredClone(base);
        p[key] = "a".repeat(max);
        yield { name: `${label}: ${key} at maxLength (${max})`, payload: p };
      }
      {
        const p = structuredClone(base);
        p[key] = "a".repeat(max + 1);
        yield { name: `${label}: ${key} one over maxLength (${max + 1})`, payload: p };
      }
      if (min > 0) {
        const p = structuredClone(base);
        p[key] = "a".repeat(min - 1);
        yield { name: `${label}: ${key} one under minLength (${min - 1})`, payload: p };
      }
    }

    // --- string maxLength/minLength boundary probes: row fields ---
    if (base.rows && rowDefName) {
      const rowBounds = stringBounds(schema.$defs[rowDefName].properties);
      for (let i = 0; i < base.rows.length; i++) {
        for (const [key, { min, max }] of Object.entries(rowBounds)) {
          {
            const p = structuredClone(base);
            p.rows[i][key] = "a".repeat(max);
            yield { name: `${label}: rows[${i}].${key} at maxLength (${max})`, payload: p };
          }
          {
            const p = structuredClone(base);
            p.rows[i][key] = "a".repeat(max + 1);
            yield {
              name: `${label}: rows[${i}].${key} one over maxLength (${max + 1})`,
              payload: p,
            };
          }
          if (min > 0) {
            const p = structuredClone(base);
            p.rows[i][key] = "a".repeat(min - 1);
            yield {
              name: `${label}: rows[${i}].${key} one under minLength (${min - 1})`,
              payload: p,
            };
          }
        }
      }
    }

    // --- empty rows array (valid for task/decision; invalid where rows are required
    // (fact/stakeholder_mention) or forbidden (deliverable/transcript/artifact/skill/blueprint)) ---
    {
      const p = structuredClone(base);
      p.rows = [];
      yield { name: `${label}: rows = []`, payload: p };
    }

    // --- wrong enum values ---
    {
      const p = structuredClone(base);
      p.access = "private_typo_bogus";
      yield { name: `${label}: access = bogus enum value`, payload: p };
    }
    {
      const p = structuredClone(base);
      p.kind = "unknown_kind";
      yield { name: `${label}: kind = unknown_kind`, payload: p };
    }
    if (base.kind === "task" && base.rows) {
      const p = structuredClone(base);
      p.rows[0].pm_provider = "jira";
      yield { name: `${label}: rows[0].pm_provider = bogus enum value`, payload: p };
    }
    if (base.kind === "decision" && base.rows) {
      const p = structuredClone(base);
      p.rows[0].audience = "executive";
      yield { name: `${label}: rows[0].audience = bogus enum value`, payload: p };
    }
    if (base.kind === "fact" && base.rows) {
      const p = structuredClone(base);
      p.rows[0].fact_type = "guess";
      yield { name: `${label}: rows[0].fact_type = bogus enum value`, payload: p };
    }

    // --- wrong types ---
    {
      const p = structuredClone(base);
      p.rows = "not-an-array";
      yield { name: `${label}: rows = string (expected array)`, payload: p };
    }
    {
      const p = structuredClone(base);
      p.project = 12345;
      yield { name: `${label}: project = number (expected string)`, payload: p };
    }
    {
      const p = structuredClone(base);
      p.body = 12345;
      yield { name: `${label}: body = number (expected string)`, payload: p };
    }
    if (base.frontmatter) {
      const p = structuredClone(base);
      p.frontmatter = "not-an-object";
      yield { name: `${label}: frontmatter = string (expected object)`, payload: p };
    }
    if (base.kind === "task" && base.rows && base.rows[0].labels !== undefined) {
      const p = structuredClone(base);
      p.rows[0].labels = "not-an-array";
      yield { name: `${label}: rows[0].labels = string (expected array)`, payload: p };
    }
    if (base.kind === "decision" && base.rows) {
      const p = structuredClone(base);
      p.rows[0].tier = "two";
      yield { name: `${label}: rows[0].tier = string (expected integer)`, payload: p };
    }

    // --- foreign row shape: reassign kind to another row-bearing kind, keeping this
    // fixture's own rows (exercises the schema's per-kind `if/then` row-shape dispatch
    // against validateItemPayload's `switch (input.kind)` the same way) ---
    if (base.rows) {
      for (const otherKind of Object.keys(ROW_DEF_BY_KIND)) {
        if (otherKind === base.kind) continue;
        const p = structuredClone(base);
        p.kind = otherKind;
        yield { name: `${label}: kind reassigned to "${otherKind}" with foreign rows`, payload: p };
      }
    }
  }
}

test("generated boundary probes agree between the schema and validateItemPayload", () => {
  let generated = 0;
  for (const probe of generateProbes()) {
    agree(probe.name, probe.payload);
    generated += 1;
  }
  // Sanity floor so a refactor that accidentally stops the generator from yielding anything
  // doesn't silently turn this into a no-op test.
  assert.ok(generated > 150, `expected >150 generated probes, got ${generated}`);
});

test("parity suite covers a substantial number of fixture + generated probes", () => {
  // probeCount accumulates across every `agree()` call in this module (fixtures + generated).
  assert.ok(probeCount > 150, `expected >150 total probes checked, got ${probeCount}`);
});
