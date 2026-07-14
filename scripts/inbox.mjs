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
 *   • `aios inbox rebuild` — I-02: deterministically re-projects the read model from
 *     asks.ndjson ∪ activity.jsonl ∪ inbox-events.ndjson.
 *   • `aios inbox compact` — I-02: collapses superseded transition events into a snapshot while
 *     keeping consumed-tombstones + receipts.
 *
 * No mutation of asks/journal happens here; all logic lives in the compiled operator loop
 * (src/operator-loop/inbox/*).
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { c, die } from "./cli-common.mjs";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";

const INBOX_SUBCOMMANDS = ["list", "rebuild", "compact", "outbox", "send"];

// The I-02 journal event kinds the I-11 outbox emits (subset of INBOX_EVENT_KINDS).
const OUTBOX_EVENT_KINDS = new Set(["action-attempt", "outcome", "native-receipt"]);

/** Map a durable I-02 journal event ({correlation_id, ts, payload}) onto the outbox seam's
 *  {command_id, at, data} shape so `foldOutboxState` can derive lifecycle state. */
function journalToOutboxEvent(ev) {
  return { kind: ev.kind, command_id: ev.correlation_id, at: ev.ts, data: ev.payload ?? {} };
}

/**
 * A real gog-backed outbox send client (I-11). `send` shells `gog gmail send` on the EXACT approved
 * recipients + subject/body; `querySent` is reconcile-first — it searches Sent for the command
 * marker token embedded in the subject. Credential note (claim scope, G5): gog holds its own OAuth
 * token — this wraps the send behind the loop, it does not yet make the ambient CLI un-bypassable
 * (that is G6b/I-15).
 */
function createGogSendClient(loop, { account, message } = {}) {
  const acct = account ? ["-a", account] : [];
  return {
    querySent(commandId) {
      try {
        const out = execFileSync(
          "gog",
          [
            "gmail",
            "search",
            `in:sent subject:${commandId}`,
            "--json",
            "--results-only",
            "--max",
            "1",
            ...acct,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        const arr = JSON.parse(out);
        if (Array.isArray(arr) && arr.length > 0) {
          return { found: true, message_id: arr[0].id, thread_id: arr[0].id };
        }
      } catch {
        /* a failed Sent query is treated as not-found; the caller then attempts a first send */
      }
      return { found: false };
    },
    send(exactOutboundBytes) {
      // The recipients + subject/body are taken from the validated `message` (derived from the
      // PDP-approved recipient set), NOT re-parsed from free text — the bytes are the audit record.
      void exactOutboundBytes;
      const args = ["gmail", "send", "--to", message.to.join(","), "--subject", message.subject];
      if (message.cc?.length) args.push("--cc", message.cc.join(","));
      if (message.bcc?.length) args.push("--bcc", message.bcc.join(","));
      args.push("--body", message.body, "--json", "--results-only", ...acct);
      let out;
      try {
        out = execFileSync("gog", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        throw new loop.OutboxSendError(`gog send failed: ${e.message}`);
      }
      let r = {};
      try {
        r = JSON.parse(out);
      } catch {
        /* gog printed non-JSON — surface as a send error rather than a false success */
        throw new loop.OutboxSendError("gog send returned non-JSON output");
      }
      const message_id = r.id || r.messageId || r.message_id || "";
      const thread_id = r.threadId || r.thread_id || message_id;
      if (!message_id) throw new loop.OutboxSendError("gog send returned no message id");
      return { message_id, thread_id };
    },
  };
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
    const outboxEvents = events
      .filter((e) => OUTBOX_EVENT_KINDS.has(e.kind))
      .map(journalToOutboxEvent);
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
      const idShort = r.native_message_id ? c.dim(` ${r.native_message_id}`) : "";
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
    const sink = loop.createMemoryJournalSink();
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

    // 2) Recipients are DERIVED from the PDP-approved request — never free-typed.
    const to = draft.request.recipients.map((r) => r.address);
    const message = {
      to,
      cc: [],
      bcc: [],
      subject: String(draft.message.subject ?? ""),
      body: String(draft.message.body ?? ""),
    };
    // Embed the command marker in the subject so reconcile-first can find the message in Sent.
    const markedSubject = `${message.subject} [aio:${draft.command_id}]`;
    message.subject = markedSubject;
    const bytes =
      [
        `To: ${to.join(", ")}`,
        `Subject: ${markedSubject}`,
        `X-AIOS-Command-Id: ${draft.command_id}`,
      ].join("\n") +
      "\n\n" +
      message.body +
      "\n";

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

    // 4) Confirmed: one reconcile-first, at-most-once gog send through the durable outbox journal.
    const { events } = loop.readJournalSegments(repo);
    const priorEvents = events
      .filter((e) => OUTBOX_EVENT_KINDS.has(e.kind))
      .map(journalToOutboxEvent);
    const client = createGogSendClient(loop, { account, message });
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
    }
    return;
  }

  const suggestion = nearestSubcommand(sub);
  die(
    (suggestion
      ? `unknown inbox subcommand: ${sub} — did you mean \`aios inbox ${suggestion}\`?\n`
      : "") +
      "usage: aios inbox [list] [--raw] [--json]\n" +
      "       aios inbox rebuild [--db <path>] [--json]\n" +
      "       aios inbox compact [--boundary-seq <n>] [--json]\n" +
      "       aios inbox outbox [--json]\n" +
      "       aios inbox send --draft <draft.json> [--confirm] [--account <email>] [--json]"
  );
}
