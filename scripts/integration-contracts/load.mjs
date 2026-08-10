/**
 * Contract loading, canonical JSON, and digests (AIO-835 Phase 0).
 *
 * Digests are taken over a CANONICAL serialization (RFC 8785-style: recursively
 * key-sorted, no insignificant whitespace), never over the raw file bytes. That is
 * deliberate: the contract files live under `packages/**`, which prettier formats, so a
 * byte digest would change every time the formatter's preferences changed and every
 * downstream pin would break for no semantic reason. The canonical digest changes only
 * when the CONTRACT changes — which is exactly the event that requires a contract-version
 * bump and refreshed fixtures.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SELF_DIR, "..", "..");
export const CONTRACT_DIR = path.join(REPO_ROOT, "packages", "integration-sdk", "contracts", "v1");
export const FIXTURE_DIR = path.join(CONTRACT_DIR, "__fixtures__");

/** The six normative v1 artifacts, in the order the specification lists them. */
export const ARTIFACT_FILES = [
  "capabilities.json",
  "manifest.schema.json",
  "outcomes.schema.json",
  "evidence.schema.json",
  "compatibility.json",
  "invariants.json",
];

export const CONTRACT_VERSION = "1.0.0";

/**
 * Deterministic UTF-16 code-unit ordering. Explicitly NOT `localeCompare` — the same
 * reasoning `scripts/check-file-size.mjs` documents for its own comparator, and here it is
 * load-bearing rather than merely tidy: RFC 8785 canonical JSON REQUIRES code-unit key
 * ordering, so locale collation would make a contract digest depend on the ICU version and
 * `LANG` of whoever computed it. Passing this explicitly also states the intent that a bare
 * `.sort()` leaves implicit.
 */
export const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * RFC 8785-style canonical JSON. Object keys sort by UTF-16 code unit (the default
 * `Array.prototype.sort` ordering, which is what the spec prescribes). Only the JSON
 * types actually present in these contracts are handled; anything else is a bug in a
 * contract file and throws rather than silently hashing to something meaningless.
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean" || type === "number") {
    if (type === "number" && !Number.isFinite(value)) {
      throw new TypeError(`non-finite number in contract: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (type === "object") {
    const keys = Object.keys(value).sort(compareCodeUnits);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  throw new TypeError(`unserializable value in contract: ${type}`);
}

export function canonicalDigest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function readJson(absolutePath) {
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

/** Load the six artifacts plus their canonical digests. */
export function loadContracts() {
  const artifacts = {};
  const digests = {};
  for (const file of ARTIFACT_FILES) {
    const parsed = readJson(path.join(CONTRACT_DIR, file));
    artifacts[file] = parsed;
    digests[file] = canonicalDigest(parsed);
  }
  return { artifacts, digests };
}

/**
 * Every fixture is declared in `__fixtures__/index.json` rather than discovered by a
 * filesystem walk. Discovery would let a fixture be added and silently never asserted on;
 * an explicit index makes an unreferenced or missing file a hard failure (see
 * `checkFixtureIndexParity`).
 */
export function loadFixtureIndex() {
  return readJson(path.join(FIXTURE_DIR, "index.json"));
}

export function loadFixture(relativePath) {
  return readJson(path.join(FIXTURE_DIR, relativePath));
}

/** Every .json under __fixtures__ except the index itself, repo-relative to FIXTURE_DIR. */
export function listFixtureFiles() {
  const found = [];
  const visit = (absoluteDir, prefix) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) =>
      compareCodeUnits(a.name, b.name)
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(absoluteDir, entry.name), rel);
      else if (entry.isFile() && entry.name.endsWith(".json") && rel !== "index.json") {
        found.push(rel);
      }
    }
  };
  visit(FIXTURE_DIR, "");
  return found;
}

/**
 * JSON Pointer resolution (RFC 6901), used by the `requires_manifest` dependency rule.
 * Returns `undefined` for any pointer that does not resolve.
 */
export function resolvePointer(document, pointer) {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) throw new TypeError(`invalid JSON Pointer: ${pointer}`);
  let current = document;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
    current = current[token];
  }
  return current;
}
