#!/usr/bin/env node
/**
 * gen-contract-fixture.mjs — regenerate the brain-contract fixture's contentHash.
 *
 * The pinned conformance fixture (docs/contract/brain-contract.json) is the canonical
 * workspace<->brain seam (AIO-314); the brain vendors a byte-identical copy. Its
 * `contentHash` pins the version, tier aliases, SSE frames, provisioning tools, gateway reference,
 * and item-payload reference so the two copies
 * can't drift silently. When you edit the fixture (e.g. bump `version` for a contract
 * release), run this to recompute the hash — the exact canonicalization + hashed field
 * set that test/contract-conformance.test.mjs (and the brain's mirror guard) verify.
 *
 *   node scripts/gen-contract-fixture.mjs [path]   # default: docs/contract/brain-contract.json
 *
 * Rewrites the file in place (pretty JSON + trailing newline) and prints the new hash.
 * After regenerating, re-vendor the copy into aios-team-brain/test/fixtures/contract/.
 *
 * Zero dependencies (Node stdlib only).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "docs/contract/brain-contract.json");

// Recursive key sort → stable JSON. MUST match test/contract-conformance.test.mjs and the
// brain's test/guards/contract-conformance.test.ts, or the fixture reads as drifted.
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.keys(v)
          .sort()
          .reduce((o, k) => ((o[k] = canonical(v[k])), o), {})
      : v;

const fixture = JSON.parse(readFileSync(target, "utf8"));
const { version, tierAliases, sse, provisioningTools, gatewayContract, itemPayloadContract } =
  fixture;
const contentHash = createHash("sha256")
  .update(
    JSON.stringify(
      canonical({
        version,
        tierAliases,
        sse,
        provisioningTools,
        gatewayContract,
        itemPayloadContract,
      })
    )
  )
  .digest("hex");

fixture.contentHash = contentHash;
writeFileSync(target, JSON.stringify(fixture, null, 2) + "\n");
console.log(`brain-contract.json v${version} → contentHash ${contentHash}`);
console.log(
  `  re-vendor: cp ${path.relative(ROOT, target)} ../aios-team-brain/test/fixtures/contract/brain-contract.json`
);
