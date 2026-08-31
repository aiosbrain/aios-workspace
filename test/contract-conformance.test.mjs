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

// ---------------------------------------------------------------------------------------
// brain-api 1.24 scanner-identity READING (AIO-1011). The schema pins the wire shape of
// `metrics.scanner_version`; nothing in JSON Schema can pin what a reader must CONCLUDE from
// it, so the conclusion is pinned here against the vendored vectors instead of left to prose.
//
// The rule these exist to defend: absent / null / unparseable is `unknown`, NEVER `stale`.
// "The scan did not tell us" is a different statement from "the scan told us it is old".
// Right now every scanner in the fleet predates 1.24 and sends nothing, so `unknown` will
// almost always in fact be an old scanner — which is exactly why this is worth a guard. That
// is a strong prior, not a measurement, and a contract that encodes the prior as a fact
// reproduces the defect 1.24 exists to remove: absence of evidence rendered as evidence.
//
// SCOPE — READ THIS BEFORE TRUSTING THIS SUITE. `classifyScanner` below is a REFERENCE
// implementation of the published truth table, and it exists ONLY to validate that the
// `scanner_state` fixtures are internally self-consistent: that every vector's declared state is
// the one the table produces, that all three states are covered, and that both "we were not told"
// arms are present. It executes NO production reader, so **it proves nothing about how any real
// consumer behaves** — a reader that returned `unknown` for literally every input, including
// `0.1.0` and `0.2.0`, would leave this whole file green. Do not read a pass here as evidence
// that the brain classifies anything correctly; this repo cannot make that claim and must not
// look like it does.
//
// Reader conformance is enforced in the CONSUMER leg: aios-team-brain vendors this fixtures file
// and runs all of the `scanner_state` vectors against its own classifier. That is where a real
// implementation is held to the table, and where non-vacuity has to be demonstrated by injecting
// a defect and watching vector tests fail. If you add a vector here, the consumer picks it up on
// its next re-vendor — which is the point of shipping the vectors as data rather than as prose.
// ---------------------------------------------------------------------------------------

// Ordered comparison of the release triple, matching the grammar docs/brain-api.md publishes
// beneath each truth table: EXACTLY three dotted non-negative integers, nothing else. A leading
// `v`, a two-part version, a channel name, and a SemVer pre-release or build suffix are all
// UNREADABLE, and unreadable resolves to `unknown` by the table rather than to any position in
// the ordering. The strictness is deliberate and fails safe: `0.2.0-rc1` reads as `unknown`
// rather than `current`, because SemVer orders a pre-release before its release, so it is not
// evidence the build emits everything `0.2.0` promises. The `scanner_state` vectors pin this
// choice rather than leaving it implied.
function parseRelease(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// The truth table from docs/brain-api.md, executable. Reference only — see SCOPE above.
function classifyScanner(scannerVersion, minScannerVersion) {
  const got = parseRelease(scannerVersion);
  if (!got) return "unknown";
  const min = parseRelease(minScannerVersion);
  assert.ok(min, "minScannerVersion must itself be a release triple");
  for (let i = 0; i < 3; i += 1) {
    if (got[i] !== min[i]) return got[i] > min[i] ? "current" : "stale";
  }
  return "current"; // at the minimum is at-or-above
}

const scannerVectors = (() => {
  const c = fixture.codebasePayloadContract;
  const fx = JSON.parse(readFileSync(path.join(ROOT, "docs/contract", c.fixtures.path), "utf8"));
  return { vectors: fx.scanner_state?.vectors, min: c.minScannerVersion };
})();

test("scanner-state vectors cover all three outcomes, including both unknown arms", () => {
  const { vectors } = scannerVectors;
  assert.ok(Array.isArray(vectors) && vectors.length > 0, "fixtures must carry scanner_state");
  const states = new Set(vectors.map((v) => v.state));
  assert.deepEqual([...states].sort(), ["current", "stale", "unknown"]);
  // Both ways of saying "we were not told" must be represented, or the guard could pass while
  // only one of them is handled.
  assert.ok(
    vectors.some((v) => !("scanner_version" in v) && v.state === "unknown"),
    "an ABSENT scanner_version vector must be present"
  );
  assert.ok(
    vectors.some((v) => v.scanner_version === null && v.state === "unknown"),
    "an explicit-null scanner_version vector must be present"
  );
  assert.ok(
    vectors.some((v) => typeof v.scanner_version === "string" && v.state === "unknown"),
    "an unparseable scanner_version vector must be present"
  );
});

test("every scanner-state vector matches the contract's truth table", () => {
  const { vectors, min } = scannerVectors;
  for (const v of vectors) {
    // Absence is encoded by the key being missing, exactly as it is on the wire.
    const value = "scanner_version" in v ? v.scanner_version : undefined;
    assert.equal(classifyScanner(value, min), v.state, v.name);
  }
});

test("reference classifier: unknown is never stale, and stale is still reachable", () => {
  const { min } = scannerVectors;
  for (const notTold of [undefined, null, "", "nightly", "not a version at all"]) {
    assert.equal(
      classifyScanner(notTold, min),
      "unknown",
      `${JSON.stringify(notTold)} must read as unknown, never stale`
    );
  }
  // And the one case that IS stale still is, so the guard above cannot pass by collapsing
  // everything to `unknown` instead — the opposite failure, equally wrong.
  assert.equal(classifyScanner("0.1.0", min), "stale");
  assert.equal(classifyScanner(min, min), "current");
});
