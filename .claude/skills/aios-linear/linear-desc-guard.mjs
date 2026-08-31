import { describeContentDrift, findIndentedTables } from "./linear-template.mjs";

// Re-exported so callers have ONE import for description integrity, not two.
export { describeContentDrift };
import { gql } from "./linear-core.mjs";

/**
 * Write-path integrity for Linear issue descriptions (AIO-942).
 *
 * Linear re-serialises every description it stores. Most of that is cosmetic, but a markdown
 * table indented under a list item is CORRUPTED — leading characters are stripped from every
 * cell after the first column. These two guards sit either side of the write: refuse the shape
 * before sending, and re-read afterwards to catch anything not yet characterised.
 */

/**
 * Guard against markdown Linear is known to corrupt on write (AIO-942). A table indented
 * under a list item comes back with leading characters stripped from every cell after the
 * first column — silent content loss, so it is worth refusing to be quiet about.
 */
export function lintDescription(md, { force = false } = {}) {
  const indented = findIndentedTables(md);
  if (!indented.length) return;
  const label = force ? "warning" : "REFUSING TO SEND";
  console.error(
    `${label}: ${indented.length} indented table row(s) — Linear corrupts tables nested under a list item.`
  );
  console.error(
    "  It strips leading characters from every cell after the first column, and what that eats is"
  );
  console.error(
    "  file paths and identifiers — `components/x.tsx` becomes mponents/x.tsx`. A spec that has lost"
  );
  console.error(
    "  its paths still READS fine, which is how this shipped unnoticed once already (VIB-348)."
  );
  for (const hit of indented.slice(0, 6)) console.error(`  line ${hit.line}: ${hit.text}`);
  if (indented.length > 6) console.error(`  ... ${indented.length - 6} more`);
  console.error("  Fix: move the table to column 0. Override with --force if you truly mean it.");
  if (!force) process.exit(1);
}

/**
 * Re-read what Linear actually stored and compare it to what we sent, ignoring Linear's
 * cosmetic rewrites (yaml fence, emphasis re-bracketing, table delimiter restyling).
 * A byte-compare cannot do this — it fails on every write, which is why it stopped being
 * a usable gate. Returns true when the stored content matches.
 */
export async function confirmStored(issue, sent, { throwOnError = false } = {}) {
  // throwOnError propagates to gql so a caller that already performed a non-retriable write
  // (create) can catch a failed readback and still name the issue that now exists.
  const check = await gql(
    `query($id:String!){ issue(id:$id){ description } }`,
    { id: issue.id },
    { throwOnError }
  );
  const stored = check.issue.description || "";
  const drift = describeContentDrift(sent, stored);
  if (!drift) return true;
  console.error(`ERROR: ${issue.identifier} did not store what was sent - content differs.`);
  console.error(`  first divergence at normalised offset ${drift.at}`);
  console.error(`  sent  : ${JSON.stringify(drift.local)}`);
  console.error(`  stored: ${JSON.stringify(drift.remote)}`);
  console.error(
    "  This is content loss, not reformatting. Check for a table indented under a list."
  );
  console.error("  The write already completed; the issue may now contain damaged content.");
  console.error("  Repair the description immediately, rerun the write, then run verify-desc.");
  return false;
}
