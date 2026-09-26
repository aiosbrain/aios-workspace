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
    if (vector.rule === "note-attempt") {
      const outcome = !i.authorized
        ? "denied"
        : i.note_exists
          ? "existing_note"
          : i.active_attempt
            ? "existing_attempt"
            : "new_attempt";
      assert.equal(outcome, vector.expected);
    } else if (vector.rule === "idempotency") {
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

test("valid large batches can report all four conflicts per row", () => {
  const validate = ajv.getSchema("urn:aios:mcp-next:1:tasks#/definitions/Result");
  const conflicts = Array.from({ length: 1251 }, (_, row) =>
    ["title", "assignee", "status", "due"].map((field) => {
      const values = {
        title: ["Base", "Brain", "Incoming"],
        assignee: [null, "member-a", "member-b"],
        status: ["backlog", "ready", "done"],
        due: [null, "2026-10-01", "2026-10-02"],
      }[field];
      return {
        task_id: `task-${row}`,
        revision: "r2",
        field,
        baseline: values[0],
        brain: values[1],
        incoming: values[2],
        origin: "workspace",
        code: "divergent_change",
      };
    })
  ).flat();
  assert.equal(validate({ applied: [], conflicts }), true, JSON.stringify(validate.errors));
  assert.equal(conflicts.length, 5004);
});

test("task publishing pins row revisions, canonical bytes, destination and complete receipts", () => {
  const fixtures = read("workspace-fixtures.json");
  const input = fixtures.valid.find((v) => v.name === "publish-item-input").value;
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
  const bound = (v) =>
    v.taskBatch.project_id === v.projectId &&
    v.taskBatch.source_item_id === v.itemId &&
    v.taskBatch.operation_id === v.operationId &&
    JSON.stringify(canonical(v.taskBatch)) === v.payloadJson &&
    `sha256:${createHash("sha256").update(v.payloadJson).digest("hex")}` === v.payloadHash;
  assert.equal(bound(input), true);
  for (const key of ["projectId", "itemId", "operationId", "payloadJson", "payloadHash"])
    assert.equal(bound({ ...input, [key]: "changed" }), false, key);
  assert.equal(new Set(input.taskBatch.rows.map((r) => r.expected_revision)).size, 2);
  const receipt = fixtures.valid.find(
    (v) => v.name === "task-receipt-partially-applied-conflict"
  ).value;
  const accounted = new Set(
    [...receipt.taskResult.applied, ...receipt.taskResult.conflicts].map((r) => r.task_id)
  );
  assert.deepEqual(accounted, new Set(input.taskBatch.rows.map((r) => r.task_id)));
});

// Negotiation reference only; validates advertised compatibility, never authorizes execution.
function negotiateAdvertisement(value) {
  if (!value || Buffer.byteLength(JSON.stringify(value), "utf8") > 16384)
    return { version: null, actions: [] };
  const validate = ajv.getSchema("urn:aios:mcp-next:1:actions#/definitions/Capabilities");
  if (!validate(value) || !value.contract_versions.includes("mcp-next/1"))
    return { version: null, actions: [] };
  const supported = new Set(["note.append", "task.create", "task.update", "decision.record"]);
  return {
    version: "mcp-next/1",
    actions: value.actions.filter((action) => supported.has(action)),
  };
}
test("additive capability negotiation intersects supported sets and remains fail closed", () => {
  const advertisement = read("actions-fixtures.json").valid.find(
    (v) => v.name === "additive-capability-advertisement"
  ).value;
  assert.deepEqual(negotiateAdvertisement(advertisement), {
    version: "mcp-next/1",
    actions: ["note.append"],
  });
  assert.deepEqual(
    negotiateAdvertisement({ ...advertisement, contract_versions: ["mcp-next/2"] }),
    { version: null, actions: [] }
  );
  assert.deepEqual(negotiateAdvertisement({ ...advertisement, actions: ["future.action"] }), {
    version: "mcp-next/1",
    actions: [],
  });
  assert.deepEqual(negotiateAdvertisement({ ...advertisement, task_revisions: "true" }), {
    version: null,
    actions: [],
  });
  assert.deepEqual(negotiateAdvertisement({ ...advertisement, future_blob: "x".repeat(16384) }), {
    version: null,
    actions: [],
  });
  assert.deepEqual(negotiateAdvertisement(undefined), { version: null, actions: [] });
});
test("503 unavailable has an executable retryable transport-error representation", () => {
  const value = read("actions-fixtures.json").valid.find(
    (v) => v.name === "retryable-unavailable-503"
  ).value;
  assert.equal(
    ajv.getSchema("urn:aios:mcp-next:1:actions#/definitions/TransportError")(value),
    true
  );
  const statuses = { unavailable: 503, rate_limited: 429, invalid_payload: 422 };
  assert.equal(statuses[value.error.code], 503);
  assert.equal(value.error.retryable, true);
  assert.match(
    readFileSync(new URL("README.md", root), "utf8"),
    /503 with `TransportError\.error\.code: unavailable` and `retryable: true`/
  );
});
