// AIO-314 — client-side conformance guard for the workspace<->brain seam.
// Asserts the workspace's own normalizeTier + SSE parser match the shared contract fixture, that the
// fixture's version tracks docs/brain-api.md, and that its contentHash is intact (drift tripwire).
// The aios-team-brain repo runs the mirror guard against a vendored copy of the same fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTier } from "../scripts/workspace-parse.mjs";
import { parseSseBlock, splitSseBlocks } from "../scripts/brain-client.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(path.join(ROOT, "docs/contract/brain-contract.json"), "utf8")
);

// Same canonicalization the generator + brain guard use (recursive key sort → stable JSON).
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.keys(v)
          .sort()
          .reduce((o, k) => ((o[k] = canonical(v[k])), o), {})
      : v;

test("fixture contentHash is intact (no out-of-band edit)", () => {
  // v1.7 added provisioningTools (the member-invite tool vocabulary) to the pinned content.
  const { version, tierAliases, sse, provisioningTools } = fixture;
  const recomputed = createHash("sha256")
    .update(JSON.stringify(canonical({ version, tierAliases, sse, provisioningTools })))
    .digest("hex");
  assert.equal(
    recomputed,
    fixture.contentHash,
    "edit the fixture via the generator so contentHash updates"
  );
});

test("fixture provisioningTools is a non-empty unique string list (v1.7)", () => {
  const tools = fixture.provisioningTools;
  assert.ok(
    Array.isArray(tools) && tools.length > 0,
    "provisioningTools must be a non-empty array"
  );
  assert.equal(new Set(tools).size, tools.length, "provisioningTools must be unique");
  for (const t of tools) assert.equal(typeof t, "string", `tool ${t} must be a string`);
});

test("fixture version tracks docs/brain-api.md", () => {
  const doc = readFileSync(path.join(ROOT, "docs/brain-api.md"), "utf8");
  const m = doc.match(/\*\*Version:\s*([0-9]+\.[0-9]+)\*\*/);
  assert.ok(m, "brain-api.md must state **Version: X.Y**");
  assert.equal(
    fixture.version,
    m[1],
    "fixture.version must equal the documented brain-api version"
  );
});

test("client normalizeTier matches every shared alias row", () => {
  for (const [input, expected] of Object.entries(fixture.tierAliases.shared)) {
    assert.equal(normalizeTier(input), expected, `shared: ${input}`);
  }
});

test("client normalizeTier matches the client column of every divergent row", () => {
  for (const [input, { client }] of Object.entries(fixture.tierAliases.divergent)) {
    assert.equal(normalizeTier(input), client, `divergent(client): ${input}`);
  }
});

test("client SSE parser round-trips every contract frame (incl. the forward-compat event)", () => {
  for (const frame of fixture.sse.frames) {
    const { blocks, rest } = splitSseBlocks(frame.raw);
    assert.equal(blocks.length, 1, `${frame.name}: one block`);
    assert.equal(rest, "", `${frame.name}: no trailing partial`);
    const parsed = parseSseBlock(blocks[0]);
    assert.equal(parsed.event, frame.event, `${frame.name}: event`);
    assert.deepEqual(parsed.data, frame.data, `${frame.name}: data`);
  }
});
