/**
 * loop.mjs — `aios loop` (V1 Operator Loop CLI): collect / daily / manifest --explain /
 * verify / weekly / writeback / telemetry. Offline + local-first; the collector, evidence
 * ledger, and renderers are the compiled operator loop (dist/operator-loop), loaded
 * dynamically. This module is the CLI surface over them plus the JSON-writeback +
 * daily/telemetry renderers. Extracted from scripts/aios.mjs (AIO-315); behaviour-preserving.
 */

import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { c, die } from "./cli-common.mjs";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";
import { parseFrontmatter } from "./workspace-parse.mjs";
import { resolveLoopIdentity } from "./loop-config.mjs";
import { mergeTaskWriteback } from "./tasks-table.mjs";

const LOOP_TIERS = ["admin", "team", "external"];

// Read + parse a JSON file for `aios loop verify`, failing loud with a precise message rather
// than a module-not-found / SyntaxError stack. CLI inputs are a user-visible contract.
function parseJsonFile(p) {
  if (!existsSync(p)) die(`file not found: ${p}`);
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    die(`cannot read ${p}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`invalid JSON in ${p}: ${e.message}`);
  }
}

// Lightweight runtime shape checks before handing JSON to the typed verifier. An empty
// evidence array is intentionally allowed through — the verifier reports it as an ungrounded
// must-fail (V1), which is the behavior under test, not a CLI usage error.
function validateManifestShape(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) die("manifest: expected a JSON object");
  if (!Array.isArray(m.signals)) die("manifest: missing signals[] array");
  if (!m.window || typeof m.window !== "object") die("manifest: missing window object");
  // Each signal carries the evidence ref the verifier indexes — validate it so a malformed ref
  // becomes a clear CLI error, not a TypeError deep in the verifier's manifest indexing.
  m.signals.forEach((s, i) => {
    if (!s || typeof s !== "object") die(`manifest.signals[${i}]: expected an object`);
    // The top-level `tier` is the field C5's projection trusts as the egress gate — validate it
    // (not just ref.tier) so a hand-edited --manifest with a bogus signal tier is a clear error.
    if (!LOOP_TIERS.includes(s.tier))
      die(`manifest.signals[${i}].tier must be admin|team|external`);
    const ref = s.ref;
    if (!ref || typeof ref.path !== "string")
      die(`manifest.signals[${i}].ref: path must be a string`);
    if (!LOOP_TIERS.includes(ref.tier))
      die(`manifest.signals[${i}].ref: tier must be admin|team|external`);
    if (ref.row !== undefined && typeof ref.row !== "string")
      die(`manifest.signals[${i}].ref: row must be a string when present`);
  });
  return m;
}

function validateLedgerShape(l) {
  if (!l || typeof l !== "object" || Array.isArray(l)) die("ledger: expected a JSON object");
  if (!Array.isArray(l.entries)) die("ledger: missing entries[] array");
  l.entries.forEach((e, i) => {
    if (!e || typeof e !== "object") die(`ledger.entries[${i}]: expected an object`);
    if (typeof e.claim !== "string") die(`ledger.entries[${i}]: claim must be a string`);
    if (!Array.isArray(e.evidence)) die(`ledger.entries[${i}]: evidence must be an array`);
    e.evidence.forEach((r, j) => {
      if (!r || typeof r.path !== "string")
        die(`ledger.entries[${i}].evidence[${j}]: path must be a string`);
      if (!LOOP_TIERS.includes(r.tier))
        die(`ledger.entries[${i}].evidence[${j}]: tier must be admin|team|external`);
      if (r.row !== undefined && typeof r.row !== "string")
        die(`ledger.entries[${i}].evidence[${j}]: row must be a string when present`);
    });
  });
  return l;
}

// A clearly-labeled DEBUG ledger: one grounded claim per manifest signal (each claim's evidence
// is exactly that signal's ref). This is NOT a digest drafter — it exists only to demonstrate the
// verifier contract end-to-end before C5 exists. Output still flows through the tier-safe path.
function smokeLedgerFrom(manifest) {
  return {
    entries: manifest.signals.map((s) => ({
      claim: s.summary || `${s.kind} signal`,
      evidence: [{ path: s.ref.path, row: s.ref.row, tier: s.ref.tier }],
    })),
  };
}

// Audience-safe serialization of a C6 writeback plan: whitelisted fields only (paths repo-relative,
// never file content, never the admin brief body). A final leak sweep on the serialized string is a
// belt-and-suspenders guard — if it ever trips, we refuse to emit rather than risk a leak.
function jsonWriteback(plan, targets, manifest, loop) {
  const payload = {
    stamp: plan.stamp,
    targets,
    files: plan.fileWrites.map((f) => ({
      id: f.id,
      tier: f.tier,
      destRel: f.destRel,
      syncable: f.syncable,
    })),
    taskRows: plan.taskWrite
      ? plan.taskWrite.rows.map((r) => ({ row_key: r.row_key, title: r.title }))
      : [],
    skips: plan.skips,
    tierSafetyWithheld: plan.tierSafetyWithheld,
  };
  const json = JSON.stringify(payload, null, 2);
  if (manifest) {
    // Belt-and-suspenders: the serialized payload must carry no above-audience string.
    const hits = loop.sweepForLeaks(json, loop.aboveAudienceStrings(manifest, "external"));
    if (hits.length) {
      console.error("writeback --json: refusing to emit — payload tripped the leak sweep");
      process.exit(2);
    }
  } else if (payload.taskRows.length > 0 || payload.files.some((f) => f.syncable)) {
    // No manifest ⇒ no leak corpus to sweep against. Syncable content must already have been
    // withheld (fail-closed); if any survived into the payload, refuse rather than emit it unswept.
    console.error("writeback --json: refusing to emit syncable content without a leak backstop");
    process.exit(2);
  }
  return json;
}

// Human render of a C4 DailyOrientation — three sections, one screen, seconds to read. The
// machine surface is `--json` (the full orientation); this is the terse owner-local view.
function renderDaily(o) {
  const today = o.generatedAt.slice(0, 10);
  const marker = o.audience === "owner" ? "owner-private · local only" : `view: ${o.audience}`;
  const printExcludedHint = () => {
    if (!o.counts.excluded) return;
    console.log("");
    console.log(
      c.dim(
        `  ${o.counts.excluded} excluded (default-deny) — run \`aios loop manifest --explain --daily\` to inspect`
      )
    );
  };
  // "Ran (agent runtime)" — aggregate { tag, durationMin } only; safe at any audience (AIO-139).
  const renderRan = () => {
    if (!o.ranByTag?.length) return;
    const h = (m) => `${(m / 60).toFixed(1)}h`;
    const total = o.ranByTag.reduce((a, t) => a + t.durationMin, 0);
    console.log("");
    console.log(c.bold(`Ran (agent runtime · ${h(total)})`));
    for (const t of o.ranByTag)
      console.log(`  • ${c.dim(String(t.tag).padEnd(14))} ${h(t.durationMin)}`);
  };

  console.log(
    c.blue("aios loop daily") +
      c.dim(`  window ${o.window.from.slice(0, 10)} → ${o.window.to.slice(0, 10)}`) +
      c.dim(`     ${marker}`)
  );

  const asksTotal = (o.counts.attention ?? 0) + (o.counts.queuedAsks ?? 0);
  if (
    o.counts.changed === 0 &&
    o.counts.blocked === 0 &&
    o.counts.owedToday === 0 &&
    asksTotal === 0
  ) {
    console.log("");
    console.log(
      `${c.bold("Changed (0)")}   ${c.bold("Blocked (0)")}   ${c.bold("Owed today (0)")}`
    );
    console.log(
      c.green(
        o.counts.excluded
          ? "No classifiable daily items. ✓"
          : "Nothing carried over. You're clear. ✓"
      )
    );
    renderRan();
    printExcludedHint();
    return;
  }

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const refLabel = (it) => (it.ref.row ? `${it.ref.path}#${it.ref.row}` : it.ref.path);
  const annot = (it) => {
    if (it.stale != null) return c.dim(`  (stale ${it.stale}d)`);
    if (it.due) {
      const dd = String(it.due).slice(0, 10);
      return c.dim(`  (due ${dd === today ? "today" : it.due})`);
    }
    return "";
  };
  const section = (title, items, total) => {
    console.log("");
    console.log(c.bold(`${title} (${total})`));
    for (const it of items) {
      console.log(
        `  • ${c.dim(String(it.kind).padEnd(11))} ${truncate(it.summary, 60)}${annot(it)}   ${c.dim(
          refLabel(it)
        )}`
      );
    }
    if (total > items.length) console.log(c.dim(`  +${total - items.length} more`));
  };

  // Asks (owner-only, admin-tier) surface at the TOP — the operator's queue comes before the
  // workspace roll-up. Empty for any --as view (buildDailyOrientation gates them out).
  if (o.counts.attention) section("Attention", o.attention ?? [], o.counts.attention);
  if (o.counts.queuedAsks) section("Queued asks", o.queuedAsks ?? [], o.counts.queuedAsks);
  section("Changed", o.changed, o.counts.changed);
  section("Blocked", o.blocked, o.counts.blocked);
  section("Owed today", o.owedToday, o.counts.owedToday);
  renderRan();
  printExcludedHint();
}

// C8 — the local dogfood dashboard. Owner-only (admin-tier operational data). Tier-leak first
// (the product-ending metric), then a data-quality banner if the ledger has unreadable lines.
function renderTelemetry(m) {
  const badge = (met) =>
    met === true ? c.green("MET") : met === false ? c.red("NOT MET") : c.yellow("N/A ");
  const showVal = (mr) =>
    mr.value === null
      ? "—"
      : mr.unit === "rate"
        ? `${Math.round(mr.value * 100)}%`
        : `${mr.value} ${mr.unit}`;
  const line = (mr) =>
    console.log(
      `  ${badge(mr.met)}  ${mr.label}: ${showVal(mr)} ` +
        c.dim(`(target ${mr.threshold}, n=${mr.sampleSize}${mr.note ? "; " + mr.note : ""})`)
    );

  const w = m.window;
  console.log(
    c.blue("aios loop telemetry") +
      c.dim(
        `  window ${w.days === null ? "all" : w.days + "d"} · ${w.from.slice(0, 10)} → ${w.to.slice(0, 10)}`
      )
  );

  // Tier-leak FIRST — the one that's product-ending.
  const leak = m.tierLeakCount;
  const leakBadge =
    leak.met === true ? c.green("CLEAN") : leak.met === false ? c.red("LEAK ") : c.yellow("?????");
  console.log(
    `  ${leakBadge}  ${leak.label}: ${leak.value === null ? "—" : leak.value} ` +
      c.dim(`(target == 0, n=${leak.sampleSize}${leak.note ? "; " + leak.note : ""})`)
  );

  const dq = m.breakdown.dataQuality;
  const badLines = dq.corruptLines + dq.unknownVersionLines + dq.missingFieldLines;
  if (badLines > 0)
    console.log(
      c.yellow(
        `  ⚠ data quality: ${badLines} unreadable line(s) — ${dq.corruptLines} corrupt, ` +
          `${dq.unknownVersionLines} unknown-version, ${dq.missingFieldLines} missing-fields; ` +
          `${dq.unattributableGaps} unattributable, ${dq.degradedRunIds.length} degraded run(s)`
      )
    );

  line(m.weeklyWallClock);
  line(m.verifierShippableRate);
  line(m.nextWeekActionAcceptance);
  line(m.dailyRunFrequency);
  line(m.consecutiveCleanWeeklies);

  const b = m.breakdown;
  console.log(
    c.dim(
      `  runs: ${b.weeklyRuns} weekly, ${b.dailyRuns} daily · verifier ` +
        `${b.verifier.pass}✓/${b.verifier.corrected}~/${b.verifier.failed}✗ · leak-withheld ${b.leakWithheldTotal}`
    )
  );
  for (const wn of m.warnings)
    if (wn.phase === "semantic")
      console.log(
        c.yellow(
          `  ⚠ ${wn.reason}${wn.runId ? " " + wn.runId : ""}${wn.detail ? ": " + wn.detail : ""}`
        )
      );
}

export async function cmdLoop(repo, cfg, args) {
  const sub = args[0];
  const flags = new Set(args.slice(1));
  const loop = await loadOperatorLoop();
  // Identity resolved via the shared helper so CLI + MCP stamp identical member/project.
  const { member, project } = resolveLoopIdentity(repo);

  if (sub === "collect") {
    const cadence = flags.has("--daily") ? "daily" : "weekly";
    const manifest = loop.collect({ root: repo, cadence, member, project });

    // Manifests carry admin-tier signals → write to .aios/loop (outside sync_include; never pushed).
    const dir = path.join(repo, ".aios", "loop", "manifests");
    mkdirSync(dir, { recursive: true });
    const stamp = manifest.generatedAt.replace(/[:.]/g, "-");
    const out = path.join(dir, `${cadence}-${stamp}.json`);
    writeFileSync(out, JSON.stringify(manifest, null, 2));

    if (flags.has("--json")) {
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }
    const byKind = {};
    for (const s of manifest.signals) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    const kinds =
      Object.entries(byKind)
        .map(([k, n]) => `${k}:${n}`)
        .join("  ") || "(none)";
    console.log(
      c.blue(`aios loop ${cadence}`) +
        c.dim(`  window ${manifest.window.from.slice(0, 10)} → ${manifest.window.to.slice(0, 10)}`)
    );
    console.log(`  signals: ${manifest.signals.length}   ${kinds}`);
    if (manifest.excluded.length) {
      console.log(c.yellow(`  excluded (default-deny): ${manifest.excluded.length}`));
      for (const e of manifest.excluded.slice(0, 10))
        console.log(c.dim(`    - ${e.ref} — ${e.reason}`));
    }
    console.log(c.dim(`  manifest → ${path.relative(repo, out)}`));
    return;
  }

  if (sub === "manifest") {
    if (!flags.has("--explain"))
      die("usage: aios loop manifest --explain [--as team|external] [--daily]");
    const cadence = flags.has("--daily") ? "daily" : "weekly";
    const asIdx = args.indexOf("--as");
    const audience = asIdx >= 0 ? args[asIdx + 1] : "owner";
    if (!["owner", "team", "external"].includes(audience)) die(`--as must be owner|team|external`);
    const manifest = loop.collect({ root: repo, cadence, member, project });
    const view = loop.explainManifest(manifest, audience);
    console.log(
      c.blue(`evidence — ${cadence}, audience: ${audience}`) +
        c.dim(`  (${view.lines.length} signals)`)
    );
    // Owner view (default) shows every line in full. When simulating a digest audience
    // (--as team|external), a line the audience may NOT see is redacted to kind + tier only —
    // its ref (path/row) and summary are suppressed so the simulation itself doesn't leak.
    const ownerView = audience === "owner";
    for (const line of view.lines) {
      if (!ownerView && !line.visibleToAudience) {
        console.log(`  [${c.yellow("withheld")}] ${c.bold(line.kind)} (${line.tier})`);
        continue;
      }
      const mark = line.visibleToAudience ? c.green("shown") : c.yellow("withheld");
      const wh = line.withheldFrom.length
        ? c.dim(` · withheld from: ${line.withheldFrom.join(",")}`)
        : "";
      console.log(`  [${mark}] ${c.bold(line.kind)} (${line.tier}) ${line.ref}${wh}`);
      console.log(c.dim(`        ${line.summary}`));
    }
    if (view.excluded.length)
      console.log(c.yellow(`  excluded (default-deny): ${view.excluded.length}`));
    return;
  }

  if (sub === "verify") {
    // Cadence drives the correction budget + status semantics, so reject a conflicting pair
    // rather than silently picking one.
    if (flags.has("--daily") && flags.has("--weekly"))
      die("--daily and --weekly are mutually exclusive");
    const cadence = flags.has("--daily") ? "daily" : "weekly";
    const asIdx = args.indexOf("--as");
    const audience = asIdx >= 0 ? args[asIdx + 1] : "team";
    if (!["owner", "team", "external"].includes(audience)) die("--as must be owner|team|external");
    const asJson = flags.has("--json");

    const manIdx = args.indexOf("--manifest");
    const ledIdx = args.indexOf("--ledger");
    const manifestPath = manIdx >= 0 ? args[manIdx + 1] : null;
    const ledgerPath = ledIdx >= 0 ? args[ledIdx + 1] : null;

    let manifest;
    let ledger;
    if (flags.has("--smoke")) {
      manifest = manifestPath
        ? validateManifestShape(parseJsonFile(manifestPath))
        : loop.collect({ root: repo, cadence, member, project });
      ledger = smokeLedgerFrom(manifest);
      if (!asJson)
        console.log(c.dim("# smoke ledger (debug, not a drafter) — one grounded claim per signal"));
    } else {
      if (!ledgerPath)
        die(
          "usage: aios loop verify --manifest <path> --ledger <path> [--as owner|team|external] [--daily|--weekly] [--json]\n" +
            "       aios loop verify --smoke [--manifest <path>] [--as ...] [--json]"
        );
      // A ledger's refs only resolve against the run it was drafted from — require the pair.
      if (!manifestPath)
        die(
          "--ledger requires a matching --manifest so evidence refs resolve against the right run"
        );
      manifest = validateManifestShape(parseJsonFile(manifestPath));
      ledger = validateLedgerShape(parseJsonFile(ledgerPath));
    }

    const result = await loop.runVerification({ manifest, ledger, audience, cadence });

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const badge =
        result.status === "pass"
          ? c.green("PASS")
          : result.status === "corrected"
            ? c.yellow("CORRECTED")
            : c.red("FAILED");
      console.log(c.blue(`verify — ${cadence}, audience: ${audience}`) + `  ${badge}`);
      console.log(
        c.dim(`  claims: ${result.checkedClaims}   loops: ${result.loopsUsed}/${result.budget}`)
      );
      for (const f of result.findings) {
        console.log(
          c.red(`  ✗ [${f.ruleId} ${f.check}] entry #${f.entryIndex}: ${f.claimPreview}`)
        );
        console.log(c.dim(`      ${f.detail}`));
      }
      for (const a of result.advisory)
        console.log(
          c.yellow(`  · [advisory ${a.ruleId}] entry #${a.entryIndex}: ${a.claimPreview}`)
        );
      if (!result.findings.length) console.log(c.green("  no must-fails"));
    }
    // Fail loud: a failed verification must gate (non-zero) for scripts/CI. Not a usage error,
    // so set the exit code rather than die().
    if (result.status === "failed") process.exitCode = 1;
    return;
  }

  if (sub === "weekly") {
    // ── Audience selection: default brief(owner)+team; --as external; --all = both shareable. ──
    const asIdx = args.indexOf("--as");
    const asArg = asIdx >= 0 ? args[asIdx + 1] : null;
    let shareableAudiences;
    if (flags.has("--all")) shareableAudiences = ["team", "external"];
    else if (asArg) {
      if (!["team", "external"].includes(asArg)) die("weekly --as must be team|external");
      shareableAudiences = [asArg];
    } else shareableAudiences = ["team"];

    // --smoke forces the offline path even alongside --remote (used by tests/demos).
    const remote = flags.has("--remote") && !flags.has("--smoke");
    const asJson = flags.has("--json");
    const dryRun = flags.has("--dry-run");

    // C8 telemetry: wall-clock spans the whole closeout command (CLI-duration fallback for the
    // ritual span, which is completed later by the C6 writeback approval event).
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    const manIdx = args.indexOf("--manifest");
    const manifestPath = manIdx >= 0 ? args[manIdx + 1] : null;
    const manifest = manifestPath
      ? validateManifestShape(parseJsonFile(manifestPath))
      : loop.collect({ root: repo, cadence: "weekly", member, project });

    // Egress consent: the remote drafter runs ONLY under --remote AND with the key present.
    let complete;
    if (remote) {
      if (!loop.hasAnthropicKey()) {
        die(
          "--remote requires ANTHROPIC_API_KEY (the egress-consent key). Run offline (omit --remote) or set the key."
        );
      }
      complete = loop.anthropicCompletion;
      if (!asJson)
        console.log(
          c.dim(
            `# remote drafting ENABLED — sends only the ≤-audience projection (admin never leaves the machine)`
          )
        );
    } else if (!asJson) {
      console.log(
        c.dim(
          "# offline: LLM synthesis skipped — pass --remote to send the ≤-audience projection to Anthropic"
        )
      );
    }

    const closeout = await loop.runCloseout({
      fullManifest: manifest,
      shareableAudiences,
      complete,
    });

    // ── Verifier status BEFORE any approval/write. ──
    if (!asJson) {
      for (const s of closeout.shareables) {
        const badge =
          s.status === "pass"
            ? c.green("PASS")
            : s.status === "corrected"
              ? c.yellow("CORRECTED")
              : c.red("FAILED");
        console.log(
          c.blue(`weekly digest — ${s.audience}`) +
            `  ${badge}` +
            (s.shippable ? "" : c.red(" · NOT SHIPPABLE"))
        );
        console.log(
          c.dim(
            `  claims: ${s.result.checkedClaims}  loops: ${s.result.loopsUsed}/${s.result.budget}  leak-withheld: ${s.leakWithheld}`
          )
        );
        for (const f of s.result.findings)
          console.log(c.red(`  ✗ [${f.ruleId} ${f.check}] #${f.entryIndex}: ${f.claimPreview}`));
      }
    }

    // ── Write artifacts under .aios/loop/closeouts/<stamp>/ (outside sync_include; C6 owns
    //    approval→writeback into the spine). admin-tier brief never enters the synced spine. ──
    const stamp = manifest.generatedAt.replace(/[:.]/g, "-");
    const outDir = path.join(repo, ".aios", "loop", "closeouts", stamp);
    if (!dryRun) mkdirSync(outDir, { recursive: true });

    let briefPath = null;
    if (!dryRun) {
      briefPath = path.join(outDir, "brief.md"); // owner-only
      writeFileSync(briefPath, closeout.briefMarkdown);
      writeFileSync(
        path.join(outDir, "next-week-actions.json"),
        JSON.stringify(closeout.ownerNextWeekActions, null, 2)
      );
      // Persist the exact manifest this closeout was verified against. C6's writeback uses it as the
      // drift-free source for its independent leak re-sweep. Lives under .aios/loop (outside
      // sync_include), so it is never pushed.
      writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    }

    let anyFailed = false;
    const audienceBlocks = [];
    // AIO-363: admin-tier only (never a shareable artifact) — the CONCRETE reason behind every
    // leakWithheld across all audiences, since the owner brief itself carries zero leak detail.
    const leakReport = closeout.shareables.flatMap((s) => s.leakReport);
    let leakReportPath = null;
    if (!dryRun && leakReport.length) {
      leakReportPath = path.join(outDir, loop.LEAK_REPORT_FILENAME ?? "leak-report.json");
      writeFileSync(
        leakReportPath,
        JSON.stringify({ tier: "admin", stamp, entries: leakReport }, null, 2)
      );
    }
    for (const s of closeout.shareables) {
      if (!s.shippable) anyFailed = true;
      let digestPath = null;
      let unshippablePath = null;
      if (!dryRun) {
        if (s.shippable) {
          digestPath = path.join(outDir, `digest-${s.audience}.md`);
          writeFileSync(digestPath, s.digestMarkdown);
        } else {
          // Clearly-marked, inspection-only — NEVER referenced as an approved artifact.
          unshippablePath = path.join(outDir, `digest-${s.audience}.FAILED.md`);
          writeFileSync(unshippablePath, s.digestMarkdown);
        }
        writeFileSync(
          path.join(outDir, `verifier-${s.audience}.json`),
          JSON.stringify(s.result, null, 2)
        );
      }
      audienceBlocks.push({
        audience: s.audience,
        status: s.status,
        shippable: s.shippable,
        digestPath: digestPath ? path.relative(repo, digestPath) : null,
        unshippablePath: unshippablePath ? path.relative(repo, unshippablePath) : null,
        verifier: s.result, // audience-safe by the C3 contract
        nextWeekActions: s.nextWeekActions, // already tier <= this audience
        leakWithheld: s.leakWithheld,
      });
    }

    if (asJson) {
      // Audience-safe payload: brief by PATH only (never its content); no raw ledger; no admin
      // actions; per-audience action filtering already applied by each pipeline. leakReportPath is
      // a PATH only — the admin-tier detail behind it never enters this JSON.
      console.log(
        JSON.stringify(
          {
            runStamp: stamp,
            cadence: "weekly",
            briefPath: briefPath ? path.relative(repo, briefPath) : null,
            leakReportPath: leakReportPath ? path.relative(repo, leakReportPath) : null,
            audiences: audienceBlocks,
          },
          null,
          2
        )
      );
    } else {
      if (briefPath) console.log(c.dim(`  brief (owner-only) → ${path.relative(repo, briefPath)}`));
      for (const b of audienceBlocks) {
        const p = b.digestPath || b.unshippablePath;
        if (p) console.log(c.dim(`  digest (${b.audience}) → ${p}`));
      }
      if (leakReportPath)
        console.log(
          c.red(
            `  leak-report (admin-only, ${leakReport.length} entr${leakReport.length === 1 ? "y" : "ies"}) → ${path.relative(repo, leakReportPath)}`
          )
        );
      if (dryRun) console.log(c.dim("  (--dry-run: no files written)"));
    }
    // A non-shippable audience must gate (non-zero) for scripts/CI.
    if (anyFailed) process.exitCode = 1;

    // ── C8 telemetry + independent post-ship leak re-check (safety runs even if telemetry is off) ──
    if (!dryRun) {
      const telem = loop.telemetryEnabled();
      const endedAt = new Date().toISOString();
      const durationMs = Date.now() - startedMs;
      if (telem) {
        loop.recordEvent(repo, {
          kind: "weekly.run",
          runId: stamp,
          cadence: "weekly",
          member,
          project,
          at: endedAt,
          payload: { startedAt, endedAt, durationMs, audiences: shareableAudiences, anyFailed },
        });
        for (const s of closeout.shareables)
          loop.recordEvent(repo, {
            kind: "weekly.verify",
            runId: stamp,
            cadence: "weekly",
            member,
            project,
            at: endedAt,
            payload: {
              audience: s.audience,
              status: s.status,
              shippable: s.shippable,
              leakWithheld: s.leakWithheld,
              checkedClaims: s.result.checkedClaims,
              loopsUsed: s.result.loopsUsed,
              budget: s.result.budget,
            },
          });
      }
      // Re-derive leak truth from the bytes actually written — defense in depth over C5's sweep.
      // If a shipped digest still carries admin content, quarantine it (rename → .LEAKED.md, which
      // C6 can never promote), alarm, and fail. The one case C8 mutates a pipeline artifact.
      for (const s of closeout.shareables) {
        if (!s.shippable) continue;
        // Re-scan the bytes ACTUALLY WRITTEN to disk (not the in-memory string) — that is the
        // artifact C6 would promote/quarantine, so the defense-in-depth check must verify it.
        const shippedDigestPath = path.join(outDir, `digest-${s.audience}.md`);
        const tierLeak = loop.hasLeak(
          readFileSync(shippedDigestPath, "utf8"),
          loop.aboveAudienceStrings(manifest, s.audience)
        );
        if (telem)
          loop.recordEvent(repo, {
            kind: "weekly.shipped",
            runId: stamp,
            cadence: "weekly",
            member,
            project,
            at: endedAt,
            payload: { audience: s.audience, tierLeak },
          });
        if (tierLeak) {
          try {
            renameSync(shippedDigestPath, path.join(outDir, `digest-${s.audience}.LEAKED.md`));
          } catch {
            // best-effort quarantine; the alarm + non-zero exit still fire
          }
          console.error(
            c.red(
              `  ✗ TIER LEAK in shipped ${s.audience} digest — quarantined to digest-${s.audience}.LEAKED.md ` +
                `(unpromotable by writeback). This is a C5-sweep escape; investigate before shipping.`
            )
          );
          process.exitCode = 2;
        }
      }
    }
    return;
  }

  if (sub === "writeback") {
    // C6 — approval-gated writeback of a saved C5 closeout. Default-deny: no target flag = preview.
    // Each of --local / --sync / --pm opts into one target and they may be combined. C6 stages local
    // files only and NEVER performs network egress — the actual send stays the user's `aios push`.
    const stamp = args[1];
    if (!stamp || stamp.startsWith("--"))
      die(
        "usage: aios loop writeback <stamp> [--local] [--sync] [--pm] [--manifest <path>] [--json] [--dry-run]"
      );
    const wbFlags = new Set(args.slice(2));
    const approved = new Set(["local", "sync", "pm"].filter((t) => wbFlags.has(`--${t}`)));
    const asJson = wbFlags.has("--json");
    const dryRun = wbFlags.has("--dry-run");
    const manIdx = args.indexOf("--manifest");
    const manifestPathArg = manIdx >= 0 ? args[manIdx + 1] : null;

    // ── Read the closeout dir (must exist). ──
    const dir = path.join(repo, ".aios", "loop", "closeouts", stamp);
    if (!existsSync(dir))
      die(`no closeout at ${path.relative(repo, dir)} — run 'aios loop weekly' first`);
    const briefFile = path.join(dir, "brief.md");
    if (!existsSync(briefFile)) die(`closeout ${stamp} has no brief.md`);
    const briefMarkdown = readFileSync(briefFile, "utf8");

    let ownerNextWeekActions = [];
    const nwaFile = path.join(dir, "next-week-actions.json");
    if (existsSync(nwaFile)) {
      try {
        ownerNextWeekActions = JSON.parse(readFileSync(nwaFile, "utf8"));
      } catch {
        die(`closeout ${stamp}: next-week-actions.json is not valid JSON`);
      }
      if (!Array.isArray(ownerNextWeekActions))
        die(`closeout ${stamp}: next-week-actions.json is not an array`);
    }

    const shareables = [];
    for (const audience of ["team", "external"]) {
      const okPath = path.join(dir, `digest-${audience}.md`);
      const failedPath = path.join(dir, `digest-${audience}.FAILED.md`);
      const vFile = path.join(dir, `verifier-${audience}.json`);
      const shippable = existsSync(okPath);
      const hasFailedMarker = existsSync(failedPath);
      const hasVerifier = existsSync(vFile);
      // Skip only an audience that was never processed at all. If a verifier result exists but no
      // digest body (C5 withheld everything), we still surface it so the planner emits `missing-digest`
      // rather than silently dropping it.
      if (!shippable && !hasFailedMarker && !hasVerifier) continue;
      let verifierStatus = null;
      if (hasVerifier) {
        try {
          verifierStatus = JSON.parse(readFileSync(vFile, "utf8")).status ?? null;
        } catch {
          verifierStatus = null; // unparsable → planner treats as verifier-unavailable
        }
      }
      shareables.push({
        audience,
        shippable,
        hasFailedMarker,
        // A coexisting stale digest-<aud>.md must NOT be promoted alongside a FAILED marker — the
        // planner treats hasFailedMarker as authoritative, so don't even read the stale body.
        digestMarkdown: shippable && !hasFailedMarker ? readFileSync(okPath, "utf8") : null,
        verifierStatus,
      });
    }

    // ── Resolve spine folders + tasks.md + its (validated) tier. ──
    const spine = loop.resolveSpine(repo);
    const firstExisting = (names) => {
      for (const n of names) if (existsSync(path.join(repo, n))) return path.join(repo, n);
      return null;
    };
    const spinePaths = {
      work: spine.work ? path.join(repo, spine.work) : null,
      log: spine.log ? path.join(repo, spine.log) : null,
      shared: firstExisting(["4-shared", "04-client-surface"]),
    };
    if (!spinePaths.log)
      die(
        "no log spine folder (3-log/) — cannot place the owner brief; is this an AIOS workspace?"
      );
    const tasksPath = path.join(spinePaths.log, "tasks.md");
    const tasksExists = existsSync(tasksPath);
    let tasksFileTier = "team";
    if (tasksExists) {
      const { frontmatter } = parseFrontmatter(readFileSync(tasksPath, "utf8"));
      tasksFileTier = loop.resolveTierOrDefault(frontmatter?.access);
    }

    // ── Source the leak-backstop manifest: FAIL-CLOSED, no re-collect. ──
    // The corpus MUST be the exact manifest of this closeout. Both sources are shape-validated AND
    // stamp-matched: a malformed manifest yields an empty/wrong leak corpus (under-detection), and a
    // wrong-timestamp manifest carries the wrong vocabulary — both are refused.
    const stampOf = (m) => String(m?.generatedAt ?? "").replace(/[:.]/g, "-");
    let manifest = null;
    if (manifestPathArg) {
      // Explicit user input → fail LOUD (die) on missing/invalid/mismatched.
      if (!existsSync(manifestPathArg)) die(`--manifest not found: ${manifestPathArg}`);
      let m;
      try {
        m = JSON.parse(readFileSync(manifestPathArg, "utf8"));
      } catch {
        die(`--manifest is not valid JSON: ${manifestPathArg}`);
      }
      validateManifestShape(m); // dies on a malformed manifest (empty corpus / not a manifest)
      if (stampOf(m) !== stamp)
        die(
          `--manifest generatedAt (${m?.generatedAt}) does not map to closeout <stamp> ${stamp} — refusing (fail-closed)`
        );
      manifest = m;
    } else {
      // Persisted sidecar → fail SOFT (null → syncable withheld) on any corruption or stamp drift.
      const sidecar = path.join(dir, "manifest.json");
      if (existsSync(sidecar)) {
        try {
          const m = JSON.parse(readFileSync(sidecar, "utf8"));
          const ok =
            m &&
            typeof m === "object" &&
            !Array.isArray(m) &&
            Array.isArray(m.signals) &&
            m.window &&
            typeof m.window === "object";
          manifest = ok && stampOf(m) === stamp ? m : null;
        } catch {
          manifest = null; // corrupt sidecar → fail-closed on syncable writes
        }
      }
    }

    // ── Plan (pure, deterministic). ──
    const plan = loop.planWriteback({
      stamp,
      member,
      repoRel: (p) => path.relative(repo, p),
      briefMarkdown,
      ownerNextWeekActions,
      shareables,
      spinePaths,
      tasksPath: tasksExists ? tasksPath : null,
      tasksFileTier,
      manifest,
    });

    // Tier-safety exit signal, scoped to the approved targets only.
    const artifactTargets = { brief: ["local"], digest: ["local", "sync"], tasks: ["sync", "pm"] };
    const relevantTierSafety = plan.skips.some(
      (s) =>
        (s.code === "no-manifest" || s.code === "leak-detected") &&
        artifactTargets[s.artifact].some((t) => approved.has(t))
    );

    // ── Print the plan (repo-relative paths only; brief by path only, never its content). ──
    if (!asJson) {
      console.log(
        c.blue(`writeback — ${stamp}`) +
          (approved.size
            ? c.dim(`  targets: ${[...approved].join(",")}`)
            : c.dim("  (preview — no target flag)"))
      );
      for (const s of shareables) {
        const badge =
          s.verifierStatus === "pass"
            ? c.green("PASS")
            : s.verifierStatus === "corrected"
              ? c.yellow("CORRECTED")
              : c.red(s.verifierStatus ?? "no-verifier");
        console.log(
          c.dim(`  digest ${s.audience}: `) + badge + (s.shippable ? "" : c.red(" · not shippable"))
        );
      }
      for (const f of plan.fileWrites)
        console.log(
          `  ${c.green("write")} ${f.artifact} (${f.tier}) → ${f.destRel}` +
            (f.syncable ? c.dim(" [staged for aios push]") : c.dim(" [never syncs]"))
        );
      if (plan.taskWrite)
        console.log(
          `  ${c.green("write")} tasks (${plan.taskWrite.rows.length} tier-safe row(s)) → ${plan.taskWrite.tasksRel}` +
            c.dim(" [staged for aios push]")
        );
      for (const s of plan.skips)
        console.log(
          `  ${c.yellow("skip")} ${s.artifact}${s.audience ? ` ${s.audience}` : ""} [${s.code}]` +
            (s.count ? ` ×${s.count}` : "")
        );
    }

    // ── Default-deny: no target flag ⇒ preview only, write nothing. ──
    if (approved.size === 0) {
      if (asJson) console.log(jsonWriteback(plan, [...approved], manifest, loop));
      else console.log(c.dim("  preview only — pass --local / --sync / --pm to write."));
      return;
    }

    // ── Execute approved targets (idempotent; overlaps are safe). ──
    let wroteCount = 0;
    if (!dryRun) {
      for (const f of plan.fileWrites) {
        if (!f.targets.some((t) => approved.has(t))) continue;
        mkdirSync(path.dirname(f.destPath), { recursive: true });
        writeFileSync(f.destPath, f.content);
        wroteCount++;
      }
      if (plan.taskWrite && plan.taskWrite.targets.some((t) => approved.has(t))) {
        const cur = readFileSync(plan.taskWrite.tasksPath, "utf8");
        writeFileSync(plan.taskWrite.tasksPath, mergeTaskWriteback(cur, plan.taskWrite.rows));
        wroteCount++;
      }
    } else {
      wroteCount =
        plan.fileWrites.filter((f) => f.targets.some((t) => approved.has(t))).length +
        (plan.taskWrite && plan.taskWrite.targets.some((t) => approved.has(t)) ? 1 : 0);
    }

    if (asJson) {
      console.log(jsonWriteback(plan, [...approved], manifest, loop));
    } else {
      if (dryRun) console.log(c.dim("  (--dry-run: no files written)"));
      // Only nudge toward `aios push` when something syncable was actually staged.
      if (wroteCount > 0 && approved.has("sync"))
        console.log(
          c.yellow("  staged for the team brain — run `aios push` to sync (C6 sends nothing).")
        );
      if (wroteCount > 0 && approved.has("pm"))
        console.log(
          c.yellow(
            "  staged next-week task rows — run `aios push`; the brain projects them to Linear (AIO-72)."
          )
        );
    }

    // ── Exit codes: tier-safety withholding (fail-closed) → 2; nothing promotable → 1. ──
    if (relevantTierSafety) {
      if (!asJson)
        console.error(c.red("  tier-safety: syncable content withheld (see skips) — exit 2"));
      process.exitCode = 2;
    } else if (wroteCount === 0) {
      if (!asJson)
        console.error(c.yellow("  nothing promotable for the approved target(s) — exit 1"));
      process.exitCode = 1;
    }

    // ── C8 telemetry: a non-preview writeback is the approval event — it ends the wall-clock ritual
    //    and, if it wrote task rows (only under --sync/--pm), records accepted next-week actions.
    //    Preview (no target) already returned; --dry-run records nothing. ──
    if (!dryRun && approved.size > 0 && loop.telemetryEnabled()) {
      const taskRowsWritten =
        plan.taskWrite && plan.taskWrite.targets.some((t) => approved.has(t))
          ? plan.taskWrite.rows.map((r) => r.row_key)
          : [];
      loop.recordEvent(repo, {
        kind: "weekly.approve",
        runId: stamp,
        cadence: "weekly",
        member,
        project,
        payload: {
          targets: [...approved],
          wroteCount,
          taskRowsWritten,
          tierSafetyWithheld: relevantTierSafety,
          exitCode: process.exitCode ?? 0,
          nextWeekActionsProposed: ownerNextWeekActions.length,
        },
      });
    }
    return;
  }

  if (sub === "daily") {
    // Read-only daily orientation: changed / blocked / owed today. No verifier, no LLM, no sync,
    // no approval gate. The ONLY write is the local change-snapshot under .aios/loop/state/ and
    // ONLY on an owner run; --as / --manifest / --no-record are fully side-effect-free.
    const asIdx = args.indexOf("--as");
    const asArg = asIdx >= 0 ? args[asIdx + 1] : null;
    let audience = "owner";
    if (asArg) {
      if (!["team", "external"].includes(asArg)) die("daily --as must be team|external");
      audience = asArg;
    }
    const asJson = flags.has("--json");
    const manIdx = args.indexOf("--manifest");
    const hasManifest = manIdx >= 0;
    const manifestPath = hasManifest ? args[manIdx + 1] : null;
    if (hasManifest && (!manifestPath || manifestPath.startsWith("--")))
      die("daily --manifest requires a path");

    let orientation;
    if (hasManifest) {
      // Inspection path (deterministic; also how the CLI tests drive it). The saved manifest is
      // the current state; the prior baseline is read from the workspace (absent in a temp fixture
      // → first-run bootstrap). This path never records a snapshot.
      const manifest = validateManifestShape(parseJsonFile(manifestPath));
      if (manifest.window?.cadence !== "daily") die("daily --manifest requires a daily manifest");
      if (manifest.windowed !== false)
        die("daily --manifest requires an unwindowed full-state manifest (windowed:false)");
      const prior = loop.readSnapshot(repo, loop.DAILY_SCOPE);
      orientation = loop.buildDailyOrientation({ manifest, prior, audience }).orientation;
    } else {
      const dStart = Date.now();
      orientation = loop.runDaily({
        root: repo,
        member,
        audience,
        record: !flags.has("--no-record"),
      });
      // C8 telemetry: the daily-run habit signal. Only a real recording OWNER run counts — an `--as`
      // projection or `--no-record` run is side-effect-free by C4's contract, so it records nothing
      // (and the `--manifest` inspection path never reaches this branch).
      if (audience === "owner" && !flags.has("--no-record") && loop.telemetryEnabled()) {
        loop.recordEvent(repo, {
          kind: "daily.run",
          runId: orientation.generatedAt.replace(/[:.]/g, "-"),
          cadence: "daily",
          member,
          project,
          at: orientation.generatedAt,
          payload: {
            durationMs: Date.now() - dStart,
            signalCount:
              orientation.counts.changed +
              orientation.counts.blocked +
              orientation.counts.owedToday,
          },
        });
      }
    }

    if (asJson) {
      console.log(JSON.stringify(orientation, null, 2));
      return;
    }
    renderDaily(orientation);
    return;
  }

  if (sub === "telemetry") {
    // Local dogfood dashboard for the six V1 exit criteria. Owner-only: reads admin-tier
    // operational data from .aios/loop/telemetry/ and has NO audience-safe projection.
    const asJson = flags.has("--json");
    const all = flags.has("--all");
    const winIdx = args.indexOf("--window");
    let windowDays = 14;
    if (winIdx >= 0) {
      if (all) die("choose one of --window / --all, not both");
      const raw = args[winIdx + 1];
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n < 1) die("--window must be a positive integer (days)");
      windowDays = n;
    }
    const metrics = loop.computeMetrics(loop.readEvents(repo), {
      windowDays: all ? null : windowDays,
      dailySourceWired: true, // this CLI wires `aios loop daily` → daily.run
    });
    if (asJson) console.log(JSON.stringify(metrics, null, 2));
    else renderTelemetry(metrics);
    // A real shipped tier-leak on record is a CI-catchable alarm.
    if ((metrics.tierLeakCount.value ?? 0) > 0) process.exitCode = 2;
    return;
  }

  die(
    "usage: aios loop collect [--daily|--weekly] [--json]\n" +
      "       aios loop daily [--as team|external] [--manifest <path>] [--no-record] [--json]\n" +
      "       aios loop manifest --explain [--as team|external] [--daily]\n" +
      "       aios loop verify --manifest <path> --ledger <path> [--as owner|team|external] [--json]\n" +
      "       aios loop verify --smoke [--manifest <path>] [--as ...] [--json]\n" +
      "       aios loop weekly [--as team|external] [--all] [--remote] [--manifest <path>] [--json] [--dry-run]\n" +
      "       aios loop writeback <stamp> [--local] [--sync] [--pm] [--manifest <path>] [--json] [--dry-run]\n" +
      "       aios loop telemetry [--window <days>] [--all] [--json]"
  );
}
