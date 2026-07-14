/**
 * inbox.mjs — `aios inbox` (I-02 / AIO-383): the unified inbox journal + SQLite read model.
 *
 * Offline + local-first. The append-only `inbox-events.ndjson` journal and its SQLite read model
 * live under `.aios/loop/inbox/` — admin-tier, NEVER synced to the Team Brain. This CLI is the dev
 * surface over the compiled operator loop: `rebuild` deterministically re-projects the read model
 * from asks.ndjson ∪ activity.jsonl ∪ inbox-events.ndjson; `compact` collapses superseded transition
 * events into a snapshot while keeping consumed-tombstones + receipts. All journal/read-model logic
 * lives in the compiled operator loop (src/operator-loop/inbox/*).
 */

import { c, die } from "./cli-common.mjs";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";

const INBOX_SUBCOMMANDS = ["rebuild", "compact"];

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev.splice(0, prev.length, ...row);
  }
  return prev[b.length];
}
function nearestSubcommand(input) {
  if (!input) return null;
  const ranked = INBOX_SUBCOMMANDS.map((name) => ({
    name,
    distance: editDistance(input, name),
  })).sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return ranked[0].distance <= Math.max(2, Math.floor(input.length / 3)) ? ranked[0].name : null;
}

export async function cmdInbox(repo, cfg, args) {
  const sub = args[0];
  const rest = args.slice(1);
  const flags = new Set(rest);
  const asJson = flags.has("--json");
  const argVal = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : null;
  };

  const loop = await loadOperatorLoop();

  if (sub === "rebuild") {
    const dbPath = argVal("--db") ?? undefined;
    const report = loop.rebuildReadModel(repo, dbPath ? { dbPath } : {});
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(c.blue("aios inbox rebuild") + c.dim(`  ${report.dbPath}`));
    console.log(
      `  events: ${report.counts.events}   items: ${report.counts.items}   ` +
        `tombstones: ${report.counts.tombstones}   receipts: ${report.counts.receipts}   ` +
        `audit: ${report.counts.auditLinks}`
    );
    console.log(
      `  digest: ${report.digest.slice(0, 16)}…   maxSeq: ${report.maxSeq}` +
        (report.builtFromSnapshot ? c.dim("   (from snapshot)") : "") +
        (report.tornTail ? c.dim("   (recovered a torn tail)") : "")
    );
    console.log(
      c.dim(
        "  sources: " +
          report.sourcesRead
            .map((s) => `${s.kind}${s.present ? "" : "(absent)"}:${s.records}`)
            .join("  ")
      )
    );
    if (report.warnings.length) {
      console.error(c.dim(`  ${report.warnings.length} warning(s):`));
      for (const w of report.warnings.slice(0, 10)) console.error(c.dim(`    ${w}`));
    }
    return;
  }

  if (sub === "compact") {
    const boundaryRaw = argVal("--boundary-seq");
    const boundarySeq = boundaryRaw != null ? Number(boundaryRaw) : undefined;
    if (boundaryRaw != null && !Number.isFinite(boundarySeq))
      die(`--boundary-seq must be a number: ${boundaryRaw}`);
    const cr = loop.compactInboxJournal(repo, boundarySeq != null ? { boundarySeq } : {});
    if (asJson) {
      console.log(JSON.stringify(cr, null, 2));
      return;
    }
    console.log(
      c.blue("aios inbox compact") +
        (cr.skipped ? c.dim("   (skipped: lock contention — rerun)") : "")
    );
    console.log(
      `  boundary: ${cr.boundarySeq}   pruned: ${cr.prunedEvents}   retained: ${cr.retainedEvents}   ` +
        `tombstones: ${cr.tombstones}   receipts: ${cr.receipts}   audit: ${cr.auditLinks}`
    );
    return;
  }

  const suggestion = nearestSubcommand(sub);
  die(
    (suggestion
      ? `unknown inbox subcommand: ${sub} — did you mean \`aios inbox ${suggestion}\`?\n`
      : "") +
      "usage: aios inbox rebuild [--db <path>] [--json]\n" +
      "       aios inbox compact [--boundary-seq <n>] [--json]"
  );
}
