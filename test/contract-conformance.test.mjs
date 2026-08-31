// AIO-314 — client-side conformance guard for the workspace<->brain seam.
// Asserts the workspace's own normalizeTier + SSE parser match the shared contract fixture, that the
// fixture's version tracks docs/brain-api.md, and that its contentHash is intact (drift tripwire).
// The aios-team-brain repo runs the mirror guard against a vendored copy of the same fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTier } from "../scripts/workspace-parse.mjs";
import { parseSseBlock, splitSseBlocks } from "../scripts/brain-client.mjs";
import { TOOLS as MEMBER_CLI_TOOLS } from "../scripts/member-cli.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = path.join(ROOT, "docs/contract/brain-contract.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

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
  const {
    version,
    tierAliases,
    sse,
    provisioningTools,
    gatewayContract,
    itemPayloadContract,
    codebasePayloadContract,
  } = fixture;
  const recomputed = createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          version,
          tierAliases,
          sse,
          provisioningTools,
          gatewayContract,
          itemPayloadContract,
          codebasePayloadContract,
        })
      )
    )
    .digest("hex");
  assert.equal(
    recomputed,
    fixture.contentHash,
    "edit the fixture via the generator so contentHash updates"
  );
});

// The item-payload contract carries its OWN version (last changed at 1.12) and is deliberately
// decoupled from the document/API revision: 1.13 (the sync-origin task return leg) touched the
// tasks feed, not the item payload, so these fixtures must stay pinned at 1.12.
test("item payload contract is content-addressed at Brain API 1.12", () => {
  assert.equal(fixture.itemPayloadContract.version, "1.12");
  for (const key of ["schema", "fixtures"]) {
    const ref = fixture.itemPayloadContract[key];
    const bytes = readFileSync(path.join(ROOT, "docs/contract", ref.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256, key);
  }
});

test("gateway contract reference is content-addressed and independently versioned", () => {
  const gatewayPath = path.join(ROOT, "docs/contract", fixture.gatewayContract.path);
  const bytes = readFileSync(gatewayPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.gatewayContract.sha256);
  const gateway = JSON.parse(bytes.toString("utf8"));
  assert.equal(gateway.version, fixture.gatewayContract.version);
  assert.equal(gateway.version, "1.10");
  assert.equal(Object.keys(gateway.tools.definitions).length, 7);
  assert.equal(gateway.tools.hashVectors.length, 7);
  assert.equal(Object.keys(gateway.routes).length, 3);
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

test("`aios member` CLI tool vocabulary matches the fixture's provisioningTools (v1.7)", () => {
  // The brain runs the mirror assertion (ALL_TOOLS + its invite request schema) against its
  // vendored fixture copy — so a tool added on either side without the other fails that side's build.
  assert.deepEqual(
    [...MEMBER_CLI_TOOLS].sort(),
    [...fixture.provisioningTools].sort(),
    "scripts/member-cli.mjs TOOLS must equal the contract's provisioningTools"
  );
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

// The codebase-payload contract (brain-api 1.24 / AIO-1011). Unlike the item-payload reference
// it carries a VALUE the brain reads at runtime — `minScannerVersion`, the threshold a scan's
// `metrics.scanner_version` is compared against — so this block is enforcement input, not a
// pointer, and it is inside the hashed set for that reason.
test("codebase payload contract is content-addressed and declares a scanner minimum", () => {
  const c = fixture.codebasePayloadContract;
  assert.ok(c, "brain-contract.json must carry a codebasePayloadContract block");
  assert.equal(c.version, fixture.version, "codebase payload tracks the document revision");
  for (const key of ["schema", "fixtures"]) {
    const ref = c[key];
    const bytes = readFileSync(path.join(ROOT, "docs/contract", ref.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256, key);
  }
  // A parseable, ordered version — not a SHA, not a commit count. The choice is normative
  // (see docs/brain-api.md v1.24): commit distance is meaningless across branches, unavailable
  // to the brain at runtime, and gone the moment the scanner ships as a package.
  assert.match(c.minScannerVersion, /^\d+\.\d+\.\d+$/, "minScannerVersion must be a semver");
});

test("codebase payload schema, fixtures and doc revision state ONE version", () => {
  // The gap AIO-995 shipped through: brain-contract.json was bumped while the executable schema
  // stayed at 1.15, so the canonical contract licensed payloads the brain then rejected. Three
  // files, one number, asserted here rather than trusted.
  const c = fixture.codebasePayloadContract;
  const schema = JSON.parse(readFileSync(path.join(ROOT, "docs/contract", c.schema.path), "utf8"));
  const fx = JSON.parse(readFileSync(path.join(ROOT, "docs/contract", c.fixtures.path), "utf8"));
  assert.ok(schema.$id.includes(`/${c.version}/`), `schema $id must pin ${c.version}`);
  assert.equal(fx.version, c.version);
  assert.ok(c.schema.path.includes(c.version), "schema filename must carry its revision");
  assert.ok(c.fixtures.path.includes(c.version), "fixtures filename must carry its revision");
});

// The generator and this suite each carry their OWN copy of the canonicalization and of the
// hashed field set, and until now nothing asserted the two agree. That is the drift this
// fixture exists to catch, pointed at itself: add a block to the hashed set in one file and
// not the other, and the committed fixture regenerates to a hash the guard does not compute
// — `contentHash is intact` stays green while `node scripts/gen-contract-fixture.mjs` starts
// producing a different number, so the next contract bump ships a fixture the brain's mirror
// guard rejects. Run the REAL script against a scratch copy and require byte-identical output.
test("gen-contract-fixture.mjs reproduces the committed fixture byte-for-byte", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-brain-contract-"));
  try {
    const target = path.join(dir, "brain-contract.json");
    copyFileSync(FIXTURE_PATH, target);
    const stdout = execFileSync(
      process.execPath,
      [path.join(ROOT, "scripts/gen-contract-fixture.mjs"), target],
      { encoding: "utf8" }
    );
    assert.equal(
      readFileSync(target, "utf8"),
      readFileSync(FIXTURE_PATH, "utf8"),
      "regenerating must be a no-op on a committed fixture — hash, formatting and all"
    );
    assert.ok(
      stdout.includes(`v${fixture.version} `),
      "the generator must name the revision it hashed"
    );
    assert.ok(stdout.includes(fixture.contentHash), "the generator must print the hash it wrote");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
