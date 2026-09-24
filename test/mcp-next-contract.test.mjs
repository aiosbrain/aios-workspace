// Proposed-contract consistency only. Runtime consumers must execute these vectors themselves.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { TOOLS } from "../packages/mcp-core/index.mjs";
const root = new URL("../docs/contract/mcp-next-v1/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
for (const name of readdirSync(root).filter((x) => x.endsWith(".schema.json")))
  ajv.addSchema(read(name));

test("proposed manifest pins the complete JSON artifact inventory", () => {
  const manifest = read("manifest.json");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.status, "proposed");
  assert.deepEqual(
    Object.keys(manifest.files).sort(),
    readdirSync(root)
      .filter((x) => x.endsWith(".json") && x !== "manifest.json")
      .sort()
  );
  for (const [name, hash] of Object.entries(manifest.files)) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(new URL(name, root)))
        .digest("hex"),
      hash,
      name
    );
  }
});
for (const name of readdirSync(root).filter((x) => x.endsWith("-fixtures.json"))) {
  const fixtures = read(name);
  for (const [bucket, expected] of [
    ["valid", true],
    ["invalid", false],
  ]) {
    for (const fixture of fixtures[bucket])
      test(`${name}: ${fixture.name}`, () => {
        const validate = ajv.getSchema(fixture.schema);
        assert.ok(validate, fixture.schema);
        assert.equal(validate(fixture.value), expected, JSON.stringify(validate.errors));
      });
  }
}
test("every reserved operation resolves both input and output and preserves distinct grants", () => {
  const index = read("operations.json");
  assert.equal(index.operations.length, 13);
  assert.equal(new Set(index.operations.map((op) => op.tool)).size, 13);
  for (const op of [...index.operations, ...index.http_contracts]) {
    for (const key of ["input", "output", "error", "envelope"])
      if (op[key]) assert.ok(ajv.getSchema(op[key]), `${op.tool ?? op.path}: ${key}`);
  }
  for (const key of ["input", "migrationInput", "migrationOutput"])
    assert.ok(ajv.getSchema(index.configuration[key]));
  assert.ok(ajv.getSchema(index.status_extension.schema));
  const publishing = index.operations.filter((op) => op.tool.startsWith("workspace_sync_"));
  assert.ok(
    publishing.every(
      (op) => op.grants.includes("workspacePublish") && !op.grants.includes("brainActions")
    )
  );
});
test("existing nine read tool inputs and annotations remain unchanged", () => {
  assert.deepEqual(
    TOOLS.filter((tool) => tool.name.startsWith("brain_")).map(
      ({ name, inputSchema, annotations }) => ({ name, inputSchema, annotations })
    ),
    read("read-baseline.json").tools
  );
  assert.equal(TOOLS.filter((tool) => tool.name.startsWith("brain_")).length, 9);
});
// Reference truth tables validate expected cases, not server persistence or authorization.
for (const vector of read("tasks-fixtures.json").semantic)
  test(`reference: ${vector.name}`, () => {
    const i = vector.input;
    if (vector.rule === "legacy-batch") {
      assert.equal(
        i.revision_enabled && i.changed_or_deleted ? "upgrade_required" : "legacy_compatible",
        vector.expected
      );
    } else {
      const outcome =
        i.brain === i.incoming
          ? i.brain === i.baseline
            ? "noop"
            : "agree"
          : i.brain === i.baseline
            ? "apply"
            : i.incoming === i.baseline
              ? "keep"
              : "conflict";
      assert.deepEqual(
        { outcome, value: outcome === "apply" ? i.incoming : i.brain },
        vector.expected
      );
    }
  });
for (const vector of read("actions-fixtures.json").semantic)
  test(`reference: ${vector.name}`, () => {
    const i = vector.input;
    if (vector.rule === "idempotency") {
      assert.equal(i.stored_actor, i.actor);
      assert.equal(i.stored_destination, i.destination);
      assert.equal(i.stored_operation_id, i.operation_id);
      assert.equal(
        i.stored_payload === i.payload ? "replay" : "operation_id_conflict",
        vector.expected
      );
    } else {
      const outcome =
        !i.live_member || !i.project_visible || !i.grant || i.read_only || i.policy === "deny"
          ? "denied"
          : i.policy === "require_approval"
            ? "pending_approval"
            : "allow";
      assert.equal(outcome, vector.expected);
    }
  });
