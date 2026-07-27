import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateItemPayload } from "../scripts/workspace-parse.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = JSON.parse(
  readFileSync(path.join(ROOT, "docs/contract/item-payload-1.12-fixtures.json"), "utf8")
);

test("accepts every canonical Brain API 1.12 item fixture", () => {
  for (const fixture of fixtures.valid) {
    assert.equal(validateItemPayload(fixture.payload).success, true, fixture.name);
  }
});

test("rejects every canonical Brain API 1.12 invalid fixture", () => {
  for (const fixture of fixtures.invalid) {
    assert.equal(validateItemPayload(fixture.payload).success, false, fixture.name);
  }
});

test("evidence payloads require at least one approved row", () => {
  const payload = structuredClone(
    fixtures.valid.find((fixture) => fixture.payload.kind === "fact").payload
  );
  payload.rows = [];
  assert.equal(validateItemPayload(payload).success, false);
});
