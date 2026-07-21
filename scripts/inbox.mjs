/**
 * inbox.mjs — `aios inbox` (I-09 / AIO-390 read view + I-02 / AIO-383 journal maintenance).
 *
 * Offline + local-first + READ-ONLY. The append-only `inbox-events.ndjson` journal and its SQLite
 * read model live under `.aios/loop/inbox/` — admin-tier, NEVER synced to the Team Brain.
 *
 *   • `aios inbox` (default / `list`) — I-09: the unified ranked queue over asks (agent-events) ∪
 *     enriched observations ∪ legacy activity (thread-states). Protected items render above a
 *     separator; `--raw` is the pure-chronological escape hatch; `--json` is the stable machine
 *     surface `{ items, ranker_version, generated_at, staleness }` (a LOCAL artifact, not a sync
 *     surface). The per-item v1 ask fields pass through byte-identical to `aios asks --json`.
 *   • `aios inbox --overdue` — I-05: the recovery view (the notify lane's safety net). One line per
 *     OPEN, un-acknowledged ask whose Telegram interrupt went unacknowledged past the escalation
 *     window (derived from the durable asks queue ∪ the journal's notify-lane events). `--json` is
 *     the stable machine surface `{ items, generated_at, escalation_window_ms }`. Fails safe — a
 *     silent/disabled lane never loses an ask.
 *   • `aios inbox rebuild` — I-02: deterministically re-projects the read model from
 *     asks.ndjson ∪ activity.jsonl ∪ inbox-events.ndjson.
 *   • `aios inbox compact` — I-02: collapses superseded transition events into a snapshot while
 *     keeping consumed-tombstones + receipts.
 *
 * No mutation of asks/journal happens here; all logic lives in the compiled operator loop
 * (src/operator-loop/inbox/*).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { c, die } from "./cli-common.mjs";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";
import { createGogSendClient, gogTokenSecurityGate } from "./inbox-gog-adapter.mjs";

// Preserve the existing test/CLI helper surface while the process-facing implementation lives in
// one shared adapter used by both terminal and GUI sends.
export {
  commandMarker,
  createGogSendClient,
  gogTokenSecurityGate,
  resolveGogCredential,
} from "./inbox-gog-adapter.mjs";

const INBOX_SUBCOMMANDS = [
  "list",
  "rebuild",
  "compact",
  "outbox",
  "send",
  "m365-verify",
  "seed",
  "status",
];
const M365_FIXTURE_SCENARIOS = ["happy", "bad-token", "missing-scope", "throttled"];

// The I-02 journal event kinds the I-11 outbox emits (subset of INBOX_EVENT_KINDS).
const OUTBOX_EVENT_KINDS = new Set(["action-attempt", "outcome", "native-receipt"]);

/**
 * True iff a durable journal event belongs to the OUTBOX lane. The PR-#317 capability lane writes
 * the SAME `outcome`/`native-receipt` kinds (keyed by capability handles) into the same
 * `inbox-events.ndjson`, so filtering by kind alone folds capability handles into outbox state.
 * New events carry an explicit `payload.lane` discriminator (`"outbox"` vs `"capability"`); legacy
 * events (pre-lane) are separated by shape — the capability lane's `outcome` carries `result`
 * (never the outbox's `status`) and its `native-receipt` carries `receipt_id`, while
 * `action-attempt` was always outbox-only. Old journals therefore still replay sensibly.
 */
export function isOutboxLaneEvent(ev) {
  if (!OUTBOX_EVENT_KINDS.has(ev.kind)) return false;
  const payload = ev.payload ?? {};
  if (payload.lane != null) return payload.lane === "outbox";
  if (ev.kind === "outcome") return !("result" in payload);
  if (ev.kind === "native-receipt") return !("receipt_id" in payload);
  return true; // action-attempt: outbox-only
}

/** Map a durable I-02 journal event ({correlation_id, ts, payload}) onto the outbox seam's
 *  {command_id, at, data} shape so `foldOutboxState` can derive lifecycle state. */
function journalToOutboxEvent(ev) {
  return { kind: ev.kind, command_id: ev.correlation_id, at: ev.ts, data: ev.payload ?? {} };
}

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

  // ── `--overdue` — the I-05 recovery view (the notify lane's safety net) ────────────────────────
  // Triggered by `aios inbox --overdue` (with optional `--json` / `--window <minutes>`). Read-only.
  if (new Set(args).has("--overdue")) {
    const windowArg = (() => {
      const i = args.indexOf("--window");
      return i >= 0 ? Number(args[i + 1]) : null;
    })();
    if (windowArg !== null && !Number.isFinite(windowArg))
      die(`--window must be a number of minutes: ${args[args.indexOf("--window") + 1]}`);
    const view = loop.buildOverdue(
      repo,
      windowArg !== null ? { escalationWindowMs: windowArg * 60 * 1000 } : {}
    );
    if (new Set(args).has("--json")) {
      console.log(JSON.stringify(view, null, 2));
      return;
    }
    console.log(loop.renderOverdueText(view, { colors: c }));
    return;
  }

  // ── default / `list` — the I-09 read-only unified queue ────────────────────────────────────────
  // Triggered by `aios inbox`, `aios inbox list`, or a bare-flag form (`aios inbox --json`).
  if (!sub || sub === "list" || sub.startsWith("--")) {
    const allFlags = new Set(args);
    const raw = allFlags.has("--raw");
    const view = loop.buildInbox(repo);
    if (allFlags.has("--json")) {
      const items = raw ? loop.rawOrder(view.items) : view.items;
      console.log(
        JSON.stringify(
          {
            items,
            ranker_version: view.ranker_version,
            generated_at: view.generated_at,
            staleness: view.staleness,
          },
          null,
          2
        )
      );
      return;
    }
    console.log(loop.renderInboxText(view, { raw, colors: c }));
    return;
  }

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

  // ── outbox — read-only lifecycle view of I-11 outbox commands from the durable journal ─────────
  if (sub === "outbox") {
    const { events } = loop.readJournalSegments(repo);
    const outboxEvents = events.filter(isOutboxLaneEvent).map(journalToOutboxEvent);
    const folded = loop.foldOutboxState(outboxEvents);
    const rows = [...folded.entries()].map(([command_id, s]) => ({
      command_id,
      state: s.state,
      native_message_id: s.native_message_id ?? null,
      native_thread_id: s.native_thread_id ?? null,
    }));
    if (asJson) {
      console.log(JSON.stringify({ commands: rows, count: rows.length }, null, 2));
      return;
    }
    console.log(c.blue("aios inbox outbox") + c.dim("  (admin-tier local; never synced)"));
    if (!rows.length) {
      console.log(c.dim("  no outbox commands journaled yet"));
      return;
    }
    for (const r of rows) {
      // A reconciled command may hold only a thread id (gog's Sent search returns threads).
      const idShort = r.native_message_id
        ? c.dim(` ${r.native_message_id}`)
        : r.native_thread_id
          ? c.dim(` thread:${r.native_thread_id}`)
          : "";
      console.log(`  ${r.state.padEnd(16)} ${r.command_id}${idShort}`);
    }
    return;
  }

  // ── send — gated Gmail send: PDP (I-10) → outbox pre-send checks (I-11) → gog. DRY-RUN default. ──
  if (sub === "send") {
    const draftPath = argVal("--draft");
    if (!draftPath) {
      die(
        "usage: aios inbox send --draft <draft.json> [--confirm] [--account <email>] [--json]\n" +
          "  draft: { command_id, request: <I-10 ReplyRequest>, thread: <I-10 ThreadContext>,\n" +
          "           message: { subject, body } }  (recipients are DERIVED from the PDP-approved\n" +
          "           request.recipients — you cannot type a recipient the PDP did not approve).\n" +
          "  Default is a DRY-RUN (PDP + pre-send checks, no send). --confirm performs ONE gog send."
      );
    }
    const confirm = flags.has("--confirm");
    const account = argVal("--account") ?? undefined;
    let draft;
    try {
      draft = JSON.parse(readFileSync(path.resolve(draftPath), "utf8"));
    } catch (e) {
      die(`could not read/parse draft ${draftPath}: ${e.message}`);
    }
    if (!draft?.command_id || !draft?.request || !draft?.thread || !draft?.message) {
      die("draft must carry { command_id, request, thread, message: { subject, body } }");
    }

    // 1) PDP (I-10). The decision + one content-free journal event is the origin-confinement gate.
    //    A CONFIRMED (real) send journals its `pdp-decision` DURABLY into the same I-02 journal the
    //    outbox lane writes — keyed by the command id and stamped `lane: "outbox"` like every other
    //    outbox-lane event — so the audit trail of a real send never lives only in process memory.
    //    A dry-run stays side-effect-free (in-memory sink).
    const sink = confirm
      ? {
          record(event) {
            loop.appendInboxEvent(repo, {
              kind: "pdp-decision",
              correlation_id: draft.command_id,
              payload: { lane: "outbox", ...event },
            });
          },
        }
      : loop.createMemoryJournalSink();
    const decision = loop.decideReply(draft.request, { thread: draft.thread, journal: sink });
    if (decision.verdict !== "allow") {
      const payload = { command_id: draft.command_id, decision };
      if (asJson) console.log(JSON.stringify({ ok: false, ...payload }, null, 2));
      else {
        console.error(c.red(`✗ PDP ${decision.verdict}: ${decision.rule_id}`));
        console.error(c.dim(`  ${decision.explanation}`));
        if (decision.promotion_path)
          console.error(c.dim(`  promotion: ${decision.promotion_path}`));
      }
      process.exitCode = 1;
      return;
    }

    // 2) Recipients are DERIVED from the PDP-approved request — never free-typed. The bytes contain
    //    ONLY the fields gog transmits (To/Cc/Bcc/Subject + body); the stable reconcile marker lives
    //    in the BODY (robust to subject edits). These exact bytes are what `send` parses + transmits.
    const to = draft.request.recipients.map((r) => r.address);
    let bytes;
    try {
      bytes = loop.buildGmailReplyOutboundBytes({
        commandId: draft.command_id,
        to,
        subject: String(draft.message.subject ?? ""),
        body: String(draft.message.body ?? ""),
      });
    } catch (e) {
      // The shared builder validates the body (empty, NUL, reserved marker, >100 KiB). Report it the
      // way every other CLI rejection reports, not as an uncaught stack trace.
      if (e?.name !== "GmailReplyValidationError") throw e;
      if (asJson)
        console.log(JSON.stringify({ ok: false, reason: e.code, detail: e.message }, null, 2));
      else console.error(c.red(`✗ draft rejected (${e.code}): ${e.message}`));
      process.exitCode = 1;
      return;
    }

    // 3) Outbox pre-send checks on the EXACT bytes (recipient-set equality, injection, admin leak).
    const preCheck = loop.checkPreSend(
      { reply_request: draft.request, exact_outbound_bytes: bytes },
      decision,
      { kind: "direct" }
    );
    if (!preCheck.ok) {
      if (asJson)
        console.log(
          JSON.stringify({ ok: false, reason: preCheck.reason, detail: preCheck.detail }, null, 2)
        );
      else console.error(c.red(`✗ pre-send rejected (${preCheck.reason}): ${preCheck.detail}`));
      process.exitCode = 1;
      return;
    }

    if (!confirm) {
      const out = {
        ok: true,
        dry_run: true,
        command_id: draft.command_id,
        verdict: decision.verdict,
        recipients: to,
      };
      if (asJson) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(c.green(`✓ dry-run: PDP allow + pre-send checks pass`) + c.dim("  (no send)"));
        console.log(c.dim(`  command: ${draft.command_id}   recipients: ${to.join(", ")}`));
        console.log(c.dim("  re-run with --confirm to perform ONE gog send"));
      }
      return;
    }

    // 4a) Credential gate: assert the gog send credential is secure BEFORE any first send. A
    //     file-backed token that is missing/insecure fails closed on POSIX; a keyring-backed
    //     credential (gog default) is a named skip (the OS keyring is the boundary).
    const gate = gogTokenSecurityGate(loop);
    if (!gate.ok) {
      if (asJson)
        console.log(
          JSON.stringify({ ok: false, reason: "insecure-credential", detail: gate.reason }, null, 2)
        );
      else console.error(c.red(`✗ credential gate (fail closed): ${gate.reason}`));
      process.exitCode = 1;
      return;
    }
    if (gate.skipped && !asJson) console.error(c.dim(`  credential gate: skip — ${gate.reason}`));

    // 4b) Confirmed: one reconcile-first, at-most-once gog send through the durable outbox journal.
    const { events } = loop.readJournalSegments(repo);
    const priorEvents = events.filter(isOutboxLaneEvent).map(journalToOutboxEvent);
    const client = createGogSendClient(loop, { account, commandId: draft.command_id });
    const outbox = loop.createOutbox({
      client,
      journal: loop.createDurableOutboxJournal(repo),
      priorEvents,
    });
    let cmd;
    try {
      cmd = outbox.sendApproved({
        command_id: draft.command_id,
        reply_request: draft.request,
        exact_outbound_bytes: bytes,
        decision,
      });
    } catch (e) {
      if (e && e.name === "OutboxRetryDeferredError") {
        // A deferral is NOT a success: the retry is refused inside the eventual-consistency window.
        // Non-zero like every other non-sent branch of this command, but named distinctly.
        if (asJson)
          console.log(
            JSON.stringify(
              {
                ok: false,
                deferred: true,
                command_id: draft.command_id,
                retry_after: e.retryAfter ?? null,
                detail: e.message,
              },
              null,
              2
            )
          );
        else console.error(c.yellow(`✗ outbox retry deferred: ${e.message}`));
        process.exitCode = 1;
        return;
      }
      die(`outbox send rejected: ${e.message}`);
    }
    const out = {
      ok: cmd.state === "sent" || cmd.state === "reconciled",
      command_id: cmd.command_id,
      state: cmd.state,
      native_message_id: cmd.native_message_id ?? null,
      native_thread_id: cmd.native_thread_id ?? null,
    };
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else {
      const ok = out.ok ? c.green("✓") : c.red("✗");
      console.log(`${ok} outbox ${cmd.state}  ${c.dim(cmd.command_id)}`);
      if (cmd.native_message_id) console.log(c.dim(`  gmail message id: ${cmd.native_message_id}`));
      else if (cmd.native_thread_id)
        console.log(c.dim(`  gmail thread id: ${cmd.native_thread_id}`));
    }
    // A confirmed send that did not verifiably land (`failed` / `outcome_unknown`) exits non-zero,
    // consistent with every other failure branch of this command.
    if (!out.ok) process.exitCode = 1;
    return;
  }

  // ── m365-verify — I-12: connect-and-verify the m365 channel (auth → read → send) ────────────────
  // CREDENTIAL-FREE build: with no `.aios/m365-config.json` (or `--tenant`) this reports `needs-tenant`
  // and exits non-zero — it never makes a live Graph call and never claims verified. `--fixture <s>`
  // runs a deterministic in-memory scenario so the three diagnostic states are demonstrable locally;
  // a fixture run is always `mode: fixture` and its claim stays "not verified". Live verification
  // against an Abe-provisioned test tenant is the labelled residual — see the runbook.
  if (sub === "m365-verify") {
    const fixture = argVal("--fixture");
    const configPath = argVal("--config") ?? undefined;
    const RUNBOOK = "docs/v1-operator-loop/runbooks/m365-connect-and-verify.md";

    let report;
    if (fixture != null) {
      if (!M365_FIXTURE_SCENARIOS.includes(fixture)) {
        die(
          `unknown --fixture scenario: ${fixture} — expected one of ${M365_FIXTURE_SCENARIOS.join("|")}`
        );
      }
      report = await loop.verifyM365({
        transport: loop.createFixtureTransport(fixture),
        config: {
          tenant_id: "contoso.onmicrosoft.test",
          client_id: "fixture-client",
          test_recipient: "test-recipient@contoso.onmicrosoft.test",
          account: "verify@contoso.onmicrosoft.test",
        },
        mode: "fixture",
        sleep: () => Promise.resolve(),
      });
    } else {
      // No live Graph transport is wired in this credential-free build. Load config purely to name
      // the tenant in the needs-tenant report; absence (or presence) both yield needs-tenant here.
      let config = null;
      try {
        config = loop.loadM365Config(repo, configPath);
      } catch (e) {
        die(e?.message ?? String(e));
      }
      report = loop.needsTenantReport(config);
    }

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      renderM365Report(report, RUNBOOK);
    }
    // Exit 0 only when fully verified; needs-tenant / any failing check exits non-zero (the failing
    // check is named in the rendered output + the JSON `checks`).
    if (report.status !== "verified") process.exitCode = 1;
    return;
  }

  // ── seed — I-08: cold-start entity seeding (REVIEW-ONLY). Mines the enriched observation history
  // into confidence-scored suggestions the operator merges/rejects one at a time. Nothing is written
  // to the registry/entity files except an explicit per-item `--merge` (no bulk-accept). Every
  // suggestion + evidence summary is admin-tier local state under `.aios/loop/inbox/`, NEVER synced.
  if (sub === "seed") {
    const ownerArg = argVal("--owner");
    const ownerIds = ownerArg
      ? ownerArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [cfg?.owner, cfg?.email, cfg?.member].filter((v) => typeof v === "string" && v.trim());
    const { observations } = loop.readObservations(repo);
    const history = loop.observationsToHistory(observations, { ownerIds });

    const mergeId = argVal("--merge");
    const rejectId = argVal("--reject");
    const unmergeId = argVal("--unmerge");

    // Reversal path — restore the registry/entity files to their exact pre-merge bytes.
    if (unmergeId) {
      const r = loop.unmergeSuggestion(repo, unmergeId);
      if (asJson) return void console.log(JSON.stringify(r, null, 2));
      return void console.log(
        c.blue("aios inbox seed") +
          c.dim("  unmerged ") +
          unmergeId +
          c.dim(`  (reversed ${r.reversed})`)
      );
    }

    // Mutating paths — a SINGLE explicit per-item confirmation each. No bulk-accept exists. The
    // proposed-status gate is authoritative INSIDE the lock, so a SeedConflictError here means a
    // concurrent merge/reject already won — report it deterministically, never a raw stack.
    if (mergeId || rejectId) {
      const id = mergeId || rejectId;
      const suggestion = loop.readSuggestions(repo, history).find((s) => s.id === id);
      if (!suggestion)
        die(`no suggestion '${id}' in the current history — run \`aios inbox seed --review\``);
      let r;
      try {
        r = mergeId
          ? loop.mergeSuggestion(repo, suggestion)
          : loop.rejectSuggestion(repo, suggestion);
      } catch (e) {
        if (e && e.name === "SeedConflictError") die(e.message);
        throw e;
      }
      if (asJson) return void console.log(JSON.stringify(r, null, 2));
      return void console.log(
        c.blue("aios inbox seed") +
          (mergeId ? c.green("  merged ") : c.dim("  rejected ")) +
          id +
          c.dim(`  (${suggestion.kind})`)
      );
    }

    // Default (and `--review`) — READ-ONLY listing with confidence scores.
    const suggestions = loop.readSuggestions(repo, history);
    const summary = loop.summarizeStatuses(suggestions);
    if (asJson) {
      return void console.log(JSON.stringify({ suggestions, summary }, null, 2));
    }
    console.log(
      c.blue("aios inbox seed --review") +
        c.dim(`  ${suggestions.length} suggestion(s) from ${history.length} observation(s)`)
    );
    if (suggestions.length === 0) {
      console.log(
        c.dim("  no cold-start suggestions — the history is empty or everyone is already seeded.")
      );
    }
    for (const s of suggestions) {
      const mark =
        s.status === "merged"
          ? c.green("✓ merged  ")
          : s.status === "rejected"
            ? c.dim("x rejected")
            : "  proposed";
      const who = s.proposed_entry?.display || (s.proposed_entry?.ids || [])[0] || "?";
      console.log(
        `  ${mark}  ${c.dim(s.id)}  ${s.kind.padEnd(17)} ${s.confidence.toFixed(2)}  ${who}  ${c.dim(s.evidence_summary)}`
      );
    }
    console.log(
      c.dim(
        `  proposed ${summary.proposed}   merged ${summary.merged}   rejected ${summary.rejected}` +
          "   —  merge one with: aios inbox seed --merge <id>"
      )
    );
    return;
  }

  // ── status — coordinator + adapter health (I-15 / AIO-396). Reads the admin-tier host-health state
  //    file the Fly coordinator writes on every supervision tick; NEVER synced to the Team Brain. ──
  if (sub === "status") {
    const hh = loop.readHostHealth(repo);
    const summary = loop.coordinatorHealthSummary(hh ? hh.adapters : []);
    // A degraded coordinator exits non-zero (both output modes) so `aios inbox status` is scriptable.
    if (hh && !summary.ok) process.exitCode = 1;
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            coordinator_ok: summary.ok,
            generated_at: hh ? hh.generatedAt : null,
            counts: summary.counts,
            adapters: summary.adapters,
          },
          null,
          2
        )
      );
      return;
    }
    console.log(c.blue("aios inbox status") + c.dim("  (admin-tier local; never synced)"));
    if (!hh) {
      console.log(
        c.dim("  no host-health state yet — the coordinator has not reported (local-only run?)")
      );
      return;
    }
    const badge = summary.ok ? c.green("● healthy") : c.red("● degraded");
    console.log(
      `  coordinator: ${badge}   ${c.dim(
        `${summary.counts.healthy}/${summary.counts.total} adapters healthy · reported ${hh.generatedAt}`
      )}`
    );
    for (const a of summary.adapters) {
      const mark = a.healthy ? c.green("✓") : c.yellow("⚠");
      console.log(`    ${mark} ${a.adapter.padEnd(16)} ${a.state.padEnd(14)} ${c.dim(a.detail)}`);
    }
    return;
  }

  const suggestion = nearestSubcommand(sub);
  die(
    (suggestion
      ? `unknown inbox subcommand: ${sub} — did you mean \`aios inbox ${suggestion}\`?\n`
      : "") +
      "usage: aios inbox [list] [--raw] [--json]\n" +
      "       aios inbox --overdue [--window <minutes>] [--json]\n" +
      "       aios inbox rebuild [--db <path>] [--json]\n" +
      "       aios inbox compact [--boundary-seq <n>] [--json]\n" +
      "       aios inbox outbox [--json]\n" +
      "       aios inbox send --draft <draft.json> [--confirm] [--account <email>] [--json]\n" +
      "       aios inbox m365-verify [--fixture happy|bad-token|missing-scope|throttled] [--json]\n" +
      "       aios inbox seed [--review] [--owner <id,…>] [--json]\n" +
      "       aios inbox seed --merge|--reject <id>   |   aios inbox seed --unmerge <id>\n" +
      "       aios inbox status [--json]"
  );
}

/** Render a VerifyReport as a human-readable connect-and-verify status block. */
function renderM365Report(report, runbook) {
  const glyph = (s) => (s === "pass" ? c.green("✓") : s === "fail" ? c.red("✗") : c.dim("–"));
  console.log(
    c.blue("aios inbox m365-verify") +
      c.dim(`  tenant ${report.tenant} · mode ${report.mode} · ${report.status}`)
  );
  for (const name of ["auth", "read", "send"]) {
    const chk = report.checks[name];
    console.log(`  ${glyph(chk.status)} ${name.padEnd(5)} ${c.dim(chk.code)}  ${chk.detail}`);
  }
  console.log(
    c.dim(
      `  graph permissions: ${report.graph_permissions.length ? report.graph_permissions.join(", ") : "(none observed)"}`
    )
  );
  if (report.native_message_id)
    console.log(c.dim(`  native message-id: ${report.native_message_id}`));
  console.log(
    `  claim: ${report.claim === "connected and verified" ? c.green(report.claim) : c.dim(report.claim)}`
  );
  if (report.status === "needs-tenant") {
    console.log(
      c.yellow(
        `  needs a test tenant — this build makes no live Graph call. Live verification: ${runbook}`
      )
    );
  }
}
