#!/usr/bin/env node
/**
 * check-review-evidence-parity.mjs — drift detector for the vendored review validator.
 *
 * `scripts/review-evidence.mjs` carries a copy of the hub's release-gate validator
 * (johnellison/aios → scripts/validate-adversarial-review.mjs). Copies drift. This runs one
 * corpus through BOTH implementations and fails on any disagreement, so the release gate and
 * the PR gate can never quietly develop different opinions about what a clean review is.
 *
 * It is deliberately NOT a CI job: the hub is a different repo and is not available to this
 * repo's CI — which is the same fact that ruled out checking the hub out inside the gate
 * workflow (see docs/pr-review-evidence.md). Run it whenever either copy is touched:
 *
 *   npm run check:review-evidence-parity -- --hub ~/Projects/aios
 *
 * Without `--hub`, it still runs the corpus through the local copy and asserts the expected
 * verdicts, so the corpus is a live regression test even when the hub is not on disk.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { validateReviewBody } from "./review-evidence.mjs";

const SHA = "a".repeat(39) + "1";
const OTHER = "b".repeat(39) + "2";

function attestation({
  findings = "- no reportable findings",
  mergeability = "- Ready to merge",
  open = "- none",
  verification = `- Reviewed at ${SHA}`,
  tail = "\nMERGE_READY",
} = {}) {
  return [
    "## Findings",
    findings,
    "## Mergeability",
    mergeability,
    "## Open Questions",
    open,
    "## Verification",
    verification,
    tail,
  ].join("\n");
}

/**
 * Every case is `{ name, body, shas, valid }`. `valid: false` means "must throw" — the exact
 * message is not compared across implementations, only the accept/reject decision, because
 * wording is allowed to differ and semantics is not.
 */
export const PARITY_CORPUS = [
  { name: "clean attestation binds the head", body: attestation(), shas: [SHA], valid: true },
  {
    name: "negated hyphen compound stays clean",
    body: attestation({ findings: "- No high-severity issues found." }),
    shas: [SHA],
    valid: true,
  },
  {
    name: "resolved Medium is allowed",
    body: attestation({ findings: "- [RESOLVED] Medium: log line leaked a request id." }),
    shas: [SHA],
    valid: true,
  },
  {
    name: "benign compound is not a finding",
    body: attestation({ findings: "- Only high-level structure changed." }),
    shas: [SHA],
    valid: true,
  },
  { name: "stale SHA is rejected", body: attestation(), shas: [OTHER], valid: false },
  {
    name: "High finding blocks",
    body: attestation({ findings: "- High: auth bypass on the admin route." }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "unknown hyphen compound with a severity word blocks",
    body: attestation({ findings: "- sev-Critical: token printed to stdout." }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "entity-encoded severity still blocks",
    body: attestation({ findings: "- &#67;ritical: secret written to the log." }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "unresolved Medium blocks",
    body: attestation({ findings: "- Medium: still open, not yet triaged." }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "adversative withdraws the negation exemption",
    body: attestation({ findings: "- No issues except a High-severity auth bypass." }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "contradictory mergeability blocks",
    body: attestation({ open: "- do not merge until the migration lands" }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "non-ready mergeability blocks",
    body: attestation({ mergeability: "- Ready to merge if the flake settles" }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "missing MERGE_READY blocks",
    body: attestation({ tail: "" }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "extra SHA in Verification blocks",
    body: attestation({ verification: `- Reviewed at ${SHA} (was ${OTHER})` }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "raw HTML blocks",
    body: attestation({ findings: "- <details>hidden</details>" }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "link reference definition blocks",
    body: attestation({ verification: `- Reviewed at ${SHA}\n[ref]: https://example.invalid` }),
    shas: [SHA],
    valid: false,
  },
  {
    name: "empty section blocks",
    body: attestation({ open: "" }),
    shas: [SHA],
    valid: false,
  },
];

/** Run one implementation over the corpus; returns the accept/reject decision per case. */
export function decisions(validate) {
  return PARITY_CORPUS.map((entry) => {
    try {
      validate(entry.body, entry.shas);
      return true;
    } catch {
      return false;
    }
  });
}

/** Compare two decision vectors, returning the names of the cases that disagree. */
export function disagreements(ours, theirs) {
  return PARITY_CORPUS.filter((entry, index) => ours[index] !== theirs[index]).map((e) => e.name);
}

async function main() {
  const index = process.argv.indexOf("--hub");
  const ours = decisions(validateReviewBody);
  const wrong = PARITY_CORPUS.filter((entry, i) => ours[i] !== entry.valid).map((e) => e.name);
  if (wrong.length) {
    console.error(`Local validator disagrees with the corpus on:\n  ${wrong.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Local validator agrees with all ${PARITY_CORPUS.length} corpus cases.`);

  if (index === -1) {
    console.log("No --hub <path> given — skipped the cross-repo comparison.");
    return;
  }
  const hub = resolve(process.argv[index + 1] ?? "");
  const module = resolve(hub, "scripts/validate-adversarial-review.mjs");
  if (!existsSync(module)) {
    console.error(`No hub validator at ${module}`);
    process.exitCode = 1;
    return;
  }
  const imported = await import(pathToFileURL(module).href);
  const drift = disagreements(ours, decisions(imported.validateReviewBody));
  if (drift.length) {
    console.error(`Vendored copy has DRIFTED from the hub on:\n  ${drift.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Vendored copy matches ${module} on all ${PARITY_CORPUS.length} cases.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
