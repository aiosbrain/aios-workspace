/**
 * decisions.mjs — `aios decisions` (AIO-170 / EE4): human-in-the-loop decision-capture
 * corpus. Offline + local-first: an append-only NDJSON store folded to state
 * (`.aios/loop/decisions/`, admin-tier, never synced) that captures the AskUserQuestion /
 * plan-approval prompts the hook records into a durable learning corpus. Subcommands:
 * list / show / outcome / export. Extracted from scripts/aios.mjs (AIO-315);
 * behaviour-preserving. All decision-store logic lives in the compiled operator loop.
 */

import path from "node:path";
import os from "node:os";
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { c, die, safeReal } from "./cli-common.mjs";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";
import { resolveLoopModels } from "./loop-models.mjs";
import { extractDecisions, contextTagFor } from "./decision-extract.mjs";
import { discoverClaude } from "./analyze/sources.mjs";
import { parseJsonl } from "./analyze/parse-claude.mjs";

// ── aios decisions (AIO-170 / EE4): human-in-the-loop decision capture corpus ─
// Offline + local-first. An append-only NDJSON store folded to state (`.aios/loop/decisions/`,
// admin-tier, never synced). Captures the AskUserQuestion / plan-approval prompts the hook records
// into a durable learning/training corpus. Mirrors cmdAsks: dist import, `--repo` respected,
// friendly die if the loop isn't built. Subcommands: list / show / outcome / export.
export async function cmdDecisions(repo, cfg, args) {
  const sub = args[0];
  const rest = args.slice(1);
  const flags = new Set(rest);
  const asJson = flags.has("--json");
  const argVal = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const loop = await loadOperatorLoop();
  const warnNote = (warnings) => {
    if (warnings?.length && !asJson)
      console.error(c.dim(`  (${warnings.length} malformed line(s) skipped)`));
  };
  const resolveId = (decisions, given) => {
    const exact = decisions.find((d) => d.id === given);
    if (exact) return exact;
    const prefixed = decisions.filter((d) => d.id.startsWith(given));
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1) die(`ambiguous id prefix: ${given}`);
    return null;
  };
  const fmtChoice = (d) => {
    if (Array.isArray(d.choice) && d.choice.length) return d.choice.join(", ");
    return null;
  };

  if (sub === "list") {
    const kind = argVal("--kind");
    const sinceArg = argVal("--since");
    let sinceMs = null;
    if (sinceArg) {
      sinceMs = Date.parse(sinceArg);
      if (!Number.isFinite(sinceMs)) die(`--since is not a valid date: ${sinceArg}`);
    }
    const { decisions, warnings } = loop.readDecisions(repo);
    let filtered = decisions;
    if (kind) filtered = filtered.filter((d) => d.kind === kind);
    if (sinceMs != null) filtered = filtered.filter((d) => Date.parse(d.createdAt) >= sinceMs);
    filtered = filtered
      .slice()
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    if (asJson) {
      console.log(JSON.stringify({ decisions: filtered, warnings }, null, 2));
      return;
    }
    console.log(c.blue("aios decisions") + c.dim(`  ${filtered.length}`));
    for (const d of filtered) {
      const choice = fmtChoice(d);
      console.log(
        `  ${d.id.slice(0, 8)}  ${d.kind.padEnd(18)} ${d.question}` +
          (choice ? c.dim(`  → ${choice}`) : c.dim("  → (no choice)")) +
          (d.outcome ? c.dim("  ✓outcome") : "")
      );
    }
    if (!filtered.length) console.log(c.dim("  (none)"));
    warnNote(warnings);
    return;
  }

  if (sub === "show") {
    const given = rest.find((a) => !a.startsWith("--"));
    if (!given) die("usage: aios decisions show <id> [--json]");
    const { decisions } = loop.readDecisions(repo);
    const d = resolveId(decisions, given);
    if (!d) die(`decision not found: ${given}`);
    if (asJson) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }
    console.log(c.blue("aios decisions show") + c.dim(`  ${d.id}`));
    console.log(`  kind:      ${d.kind}`);
    console.log(`  question:  ${d.question}`);
    if (d.header) console.log(`  header:    ${d.header}`);
    if (d.options?.length) {
      console.log(`  options:`);
      for (const o of d.options)
        console.log(`    - ${o.label}` + (o.description ? c.dim(`  (${o.description})`) : ""));
    }
    console.log(`  choice:    ${fmtChoice(d) ?? c.dim("(none)")}`);
    if (d.notes) console.log(`  notes:     ${d.notes}`);
    if (d.context?.sessionId) console.log(`  session:   ${d.context.sessionId}`);
    if (d.context?.project) console.log(`  project:   ${d.context.project}`);
    console.log(`  created:   ${d.createdAt}`);
    if (d.outcome) console.log(`  outcome:   ${d.outcome}` + c.dim(`  (${d.outcomeAt})`));
    return;
  }

  if (sub === "outcome") {
    const positional = rest.filter((a) => !a.startsWith("--"));
    const given = positional[0];
    const text = positional.slice(1).join(" ").trim();
    if (!given || !text) die("usage: aios decisions outcome <id> <text...> [--json]");
    const { decisions } = loop.readDecisions(repo);
    const d = resolveId(decisions, given);
    if (!d) die(`decision not found: ${given}`);
    loop.appendOutcome(repo, d.id, text);
    if (asJson) {
      console.log(JSON.stringify({ id: d.id, outcome: text }));
      return;
    }
    console.log(c.blue("aios decisions outcome") + c.dim(`  ${d.id}`));
    return;
  }

  if (sub === "export") {
    // The "training corpus" read path — always JSON (both --json and default emit the array).
    const { decisions } = loop.readDecisions(repo);
    const sorted = decisions
      .slice()
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    console.log(JSON.stringify(sorted, null, 2));
    return;
  }

  // ── backfill (AIO-192): recover historical steering decisions from ~/.claude transcripts ──
  // Default: only the CURRENT repo (cwd realpath contained in `repo`), full context (mirrors the
  // hook). --all: also ingest ALLOWLISTED foreign repos with their ORIGIN REDACTED (no paths / no
  // basenames — contextTag + sessionId only). Client / unknown / non-existent-cwd roots (incl. the
  // NDA anchor) are skipped + counted, never ingested. All records are written to THIS repo's
  // store via the lock-held deduped batch writer.
  if (sub === "backfill") {
    const all = flags.has("--all");
    const dryRun = flags.has("--dry-run");
    const home = argVal("--home") || os.homedir();
    const sinceArg = argVal("--since");
    let sinceMs = null;
    if (sinceArg) {
      sinceMs = Date.parse(sinceArg);
      if (!Number.isFinite(sinceMs)) die(`--since is not a valid date: ${sinceArg}`);
    }
    // HARD denylist — these roots hold client / engagement / personal content and can NEVER be
    // ingested, not even via --include. `client`/`clients` are the NDA anchor + the clients/ bucket
    // (contextTagFor lowercases the first segment); `personal` is the personal-life anchor rename;
    // `unknown` is any root outside $HOME/Projects (an unclassifiable cwd we refuse to launder).
    const FORBIDDEN_ROOTS = new Set(["client", "clients", "personal", "unknown"]);
    const includeArg = argVal("--include");
    const include = includeArg
      ? includeArg
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : [];
    // Fail loud: --include may only ADD safe roots. Trying to opt a forbidden root back in is a
    // mistake we surface, never silently honor.
    const forbiddenIncluded = include.filter((t) => FORBIDDEN_ROOTS.has(t));
    if (forbiddenIncluded.length)
      die(
        `--include cannot re-enable protected root(s): ${forbiddenIncluded.join(", ")} ` +
          `(client/engagement/personal content is never ingested)`
      );
    const SAFE_ALLOWLIST = new Set([
      "aios",
      "hermes",
      "products",
      "sites",
      "labs",
      "games",
      "workspace",
      ...include.filter((t) => !FORBIDDEN_ROOTS.has(t)),
    ]);

    const sinceOk = (d) => sinceMs == null || !d.createdAt || Date.parse(d.createdAt) >= sinceMs;

    const repoReal = safeReal(repo);
    // Canonicalize the context-tag base to the SAME realpath domain as the cwds we resolve below
    // (macOS /var → /private/var, worktree symlinks, etc.) — otherwise every foreign root would
    // read as "unknown". In production ($HOME has no symlink) this is a no-op.
    const homeReal = safeReal(home) ?? home;
    const currentTag = contextTagFor(repoReal, homeReal);
    // Claude project-dir slug for the current repo: "/" → "-" (e.g. "-Users-x-Projects-aios-…").
    // Used to decide whether a transcript file's own dir slug encodes THIS repo (§isCurrent).
    const repoSlug = "-" + repoReal.split(path.sep).filter(Boolean).join("-");
    // The protected-root rule applies to the CURRENT repo too, not just foreign `--all` roots
    // (review r1): a backfill run from a repo under Projects/clients/… would otherwise ingest
    // client content — with full raw context — into that repo's store. Client/engagement/personal
    // ingestion is permanently out of AIO-192. Unrecognized roots are refused the same way
    // (opt one in deliberately via --include); the message names no tag/path — the root itself
    // may be NDA-protected.
    if (FORBIDDEN_ROOTS.has(currentTag) || !SAFE_ALLOWLIST.has(currentTag)) {
      die(
        "backfill: the current repo resolves to a protected or unrecognized root — " +
          "client/engagement/personal content is never ingested (out of scope; " +
          "use --include <tag> only for roots that are safe to ingest)"
      );
    }

    const accepted = [];
    let scannedFiles = 0;
    let unpaired = 0;
    let missingTimestamp = 0;
    let skippedNoCwd = 0;
    let skippedNonexistentCwd = 0;
    let skippedSensitive = 0;
    const byContext = new Map();

    for (const file of discoverClaude(home)) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      scannedFiles += 1;
      const records = parseJsonl(text);
      const { decisions, stats } = extractDecisions(records);
      // Counted before ANY early-continue: a file whose only moments are timestampless must still
      // surface them in the report (they were dropped, not absent).
      missingTimestamp += stats.missingTimestamp;
      if (!decisions.length) continue;
      const sessionDecisions = decisions.filter(sinceOk);
      if (!sessionDecisions.length) continue;

      // Classify EACH decision by its OWN originating record cwd — never the file's first cwd. A
      // transcript can span multiple cwds (resumed session / `cd` mid-session), so a safe leading
      // record must not launder a later client-cwd decision into the store. A decision whose
      // record carried NO cwd is skipped + counted — origin is never guessed (spec + review r4:
      // inheriting an earlier record's cwd could ingest a protected-context moment as safe).
      let acceptedFromFile = false;
      for (const d of sessionDecisions) {
        const cwdRaw = typeof d.originCwd === "string" && d.originCwd.trim() ? d.originCwd : null;
        if (!cwdRaw) {
          skippedNoCwd += 1;
          continue;
        }
        let cwdReal = null;
        let cwdExists = false;
        try {
          cwdReal = realpathSync(cwdRaw);
          cwdExists = true;
        } catch {
          cwdReal = path.resolve(cwdRaw);
          cwdExists = false;
        }
        const isCurrent =
          cwdReal && (cwdReal === repoReal || cwdReal.startsWith(repoReal + path.sep));

        if (isCurrent) {
          // The transcript's project-dir name is a slug of the session's ORIGINAL cwd. A record
          // classified current-repo by its own cwd can still live in a transcript whose dir slug
          // encodes a protected path (mixed session that started elsewhere) — keep transcriptPath
          // only when the slug encodes the current repo itself, else null it (review r3, Bugbot).
          const fileSlug = path.basename(path.dirname(file));
          const safeTranscript = fileSlug === repoSlug ? file : null;
          accepted.push({
            ...d,
            context: {
              sessionId: d.context?.sessionId ?? null,
              project: path.basename(cwdReal),
              transcriptPath: safeTranscript,
              // Persist the CANONICAL path, never the raw one (review r4): the safe-classification
              // ran on the realpath, and a raw cwd reached through a symlink under a protected
              // root would smuggle that protected path string into the store.
              cwd: cwdReal,
            },
            contextTag: currentTag,
          });
          byContext.set(currentTag, (byContext.get(currentTag) ?? 0) + 1);
          acceptedFromFile = true;
          continue;
        }

        // Foreign origin — only under --all, and only for allowlisted roots.
        if (!all) continue; // default mode ignores other repos entirely (not "sensitive")
        if (!cwdExists) {
          skippedNonexistentCwd += 1;
          continue;
        }
        const tag = contextTagFor(cwdReal, homeReal);
        if (FORBIDDEN_ROOTS.has(tag) || !SAFE_ALLOWLIST.has(tag)) {
          // clients / unknown / the NDA anchor / any unrecognized root — never ingested, and the
          // report NEVER names them (only this aggregate count leaves this branch).
          skippedSensitive += 1;
          continue;
        }
        // Allowlisted foreign: REDACT the origin — no absolute paths, no basenames enter the store.
        accepted.push({
          ...d,
          context: {
            sessionId: d.context?.sessionId ?? null,
            project: null,
            transcriptPath: null,
            cwd: null,
          },
          contextTag: tag,
        });
        byContext.set(tag, (byContext.get(tag) ?? 0) + 1);
        acceptedFromFile = true;
      }
      if (acceptedFromFile) unpaired += stats.unpaired;
    }

    // Dedupe preview (report) via the store's exact RAW-LINE key set — the same reader the batch
    // writer uses under its lock (review r4: a folded-store preview drops invalid-createdAt lines
    // the raw writer still honors, so the two counts could diverge). The preview also simulates
    // DECISIONS_HARD_LINE_CAP (review r2): dry-run's "would append" must match what
    // appendDecisionsDeduped will actually write, never overstate it.
    const existing = loop.existingDecisionKeys(repo);
    const storeAbs = path.join(repo, ".aios", "loop", "decisions", "decisions.ndjson");
    let storeLines = 0;
    try {
      storeLines = readFileSync(storeAbs, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim()).length;
    } catch {
      storeLines = 0;
    }
    let room = Math.max(0, loop.DECISIONS_HARD_LINE_CAP - storeLines);
    const seen = new Set(existing);
    let wouldAppend = 0;
    let wouldDup = 0;
    let wouldCap = 0;
    for (const inp of accepted) {
      const k = loop.decisionDedupeKey(loop.buildDecisionRecord(inp));
      if (seen.has(k)) {
        wouldDup += 1;
        continue;
      }
      if (room === 0) {
        wouldCap += 1;
        continue;
      }
      seen.add(k);
      wouldAppend += 1;
      room -= 1;
    }

    let appended = wouldAppend;
    let skippedDup = wouldDup;
    let cappedStore = wouldCap;
    if (!dryRun) {
      const res = loop.appendDecisionsDeduped(repo, accepted);
      appended = res.appended;
      skippedDup = res.skipped;
      cappedStore = res.capped;
    }

    const report = {
      dryRun,
      all,
      scannedFiles,
      recoverable: accepted.length,
      appended,
      skippedDuplicate: skippedDup,
      skippedNoCwd,
      skippedNonexistentCwd,
      skippedSensitive,
      skippedMissingTimestamp: missingTimestamp,
      cappedStore,
      unpaired,
      byContext: Object.fromEntries([...byContext.entries()].sort()),
    };
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      c.blue("aios decisions backfill") +
        (dryRun ? c.dim("  (dry-run)") : "") +
        (all ? c.dim("  --all") : "")
    );
    console.log(`  scanned files:     ${scannedFiles}`);
    console.log(`  recoverable:       ${accepted.length}`);
    console.log(`  ${dryRun ? "would append" : "appended"}:      ${appended}`);
    console.log(`  skipped (dup):     ${skippedDup}`);
    if (unpaired) console.log(c.dim(`  unpaired:          ${unpaired}`));
    if (byContext.size) {
      console.log("  by context:");
      for (const [tag, n] of [...byContext.entries()].sort())
        console.log(`    ${tag.padEnd(12)} ${n}`);
    }
    if (
      skippedNoCwd ||
      skippedNonexistentCwd ||
      skippedSensitive ||
      missingTimestamp ||
      cappedStore
    ) {
      console.log("  skipped:");
      if (skippedNoCwd) console.log(c.dim(`    no cwd on record:   ${skippedNoCwd}`));
      if (skippedNonexistentCwd)
        console.log(c.dim(`    non-existent cwd:   ${skippedNonexistentCwd}`));
      if (skippedSensitive) console.log(c.dim(`    sensitive/unknown:  ${skippedSensitive}`));
      if (missingTimestamp) console.log(c.dim(`    no timestamp:       ${missingTimestamp}`));
      if (cappedStore) console.log(c.dim(`    store at line cap:  ${cappedStore}`));
    }
    return;
  }

  // ── distill (AIO-192): draft reusable steering mental models for HUMAN REVIEW ──
  // Egress-gated: --remote is explicit consent to send ADMIN-tier steering content to Anthropic;
  // a present ANTHROPIC_API_KEY is not consent by itself. Fail-closed; the draft is written ONCE,
  // only after distill's structured output fully validates.
  if (sub === "distill") {
    const remote = flags.has("--remote");
    const contextFilter = argVal("--context");
    const minSupportArg = argVal("--min-support");
    const minSupport = minSupportArg != null ? Number(minSupportArg) : 3;
    if (!Number.isInteger(minSupport) || minSupport < 1)
      die(`--min-support must be a positive integer (got ${minSupportArg})`);

    const DEFAULT_OUT = path.join(".aios", "loop", "decisions", "decision-principles.draft.md");
    const outArg = argVal("--out");
    const outRel = outArg || DEFAULT_OUT;
    const outAbs = path.isAbsolute(outRel) ? outRel : path.join(repo, outRel);

    if (!remote) {
      die(
        "aios decisions distill sends admin-tier steering content to a third-party model (Anthropic).\n" +
          "  Re-run with --remote to consent. (Having ANTHROPIC_API_KEY set is not consent by itself.)"
      );
    }

    // Test-only completion seam: a local JSON file stands in for the SDK (no network), still gated
    // behind --remote. Mirrors the --now / --projects-dir test-override convention.
    const stubFile = process.env.AIOS_DISTILL_STUB_FILE || null;
    let complete;
    if (stubFile) {
      const canned = JSON.parse(readFileSync(stubFile, "utf8"));
      complete = async () => canned;
    } else {
      if (!loop.hasAnthropicKey())
        die("--remote requires ANTHROPIC_API_KEY — set it, or run offline (no distill).");
      const models = resolveLoopModels({ repo });
      const step = models.decisions_distill;
      complete = loop.makeAnthropicCompletion({
        model: step.model,
        effort: step.effort,
        timeoutMs: step.timeoutMs,
      });
      // Egress warning goes to STDERR regardless of --json — a machine reading JSON on stdout must
      // still see (on stderr) that admin-tier content left the machine. Never suppressed.
      console.error(c.yellow("⚠ aios decisions distill — third-party egress"));
      console.error(
        c.dim("  admin-tier steering decisions are sent to Anthropic for summarization.")
      );
    }

    // Notice when the draft would land OUTSIDE the gitignored admin store (a tracked file).
    // Stderr regardless of --json, same rule as the egress warning above: a machine reading
    // JSON on stdout must still see that the draft lands in a TRACKED file.
    const insideStore = !path.relative(path.join(repo, ".aios"), outAbs).startsWith("..");
    if (!insideStore) {
      console.error(
        c.yellow(`  note: --out is OUTSIDE the ignored .aios/ store (${outRel}) — the draft will`)
      );
      console.error(c.yellow("        be a TRACKED file that leak-gate scans at commit time."));
    }

    const { decisions } = loop.readDecisions(repo);
    let result;
    try {
      result = await loop.distill({ records: decisions, minSupport, contextFilter, complete });
    } catch (e) {
      die(`distill failed — no draft written: ${e.message}`);
    }
    mkdirSync(path.dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, result.markdown + "\n");
    if (asJson) {
      console.log(
        JSON.stringify(
          { out: outAbs, principles: result.principles.length, used: result.used },
          null,
          2
        )
      );
      return;
    }
    console.log(
      c.blue("aios decisions distill") +
        c.dim(`  ${result.principles.length} principle(s) → ${outRel}`)
    );
    console.log(c.dim("  DRAFT — for human review; promote accepted principles by hand."));
    return;
  }

  die(
    "usage: aios decisions list [--kind <k>] [--since <date>] [--json]\n" +
      "       aios decisions show <id> [--json]\n" +
      "       aios decisions outcome <id> <text...> [--json]\n" +
      "       aios decisions export [--json]\n" +
      "       aios decisions backfill [--all] [--home <dir>] [--since <date>] [--include <tag,…>] [--dry-run] [--json]\n" +
      "       aios decisions distill --remote [--context <tag>] [--min-support <n>] [--out <file>] [--json]"
  );
}
