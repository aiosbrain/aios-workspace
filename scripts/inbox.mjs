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
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
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
 * The STABLE reconcile marker for a command. Embedded in the message BODY (not the subject), so a
 * later subject edit never breaks reconcile-first. gog full-text search over Sent finds it. The
 * token is distinctive so it cannot collide with ordinary prose.
 */
export function commandMarker(commandId) {
  return `aios-outbox-cmd:${commandId}`;
}

/**
 * Build the canonical outbound bytes checked by `checkPreSend` AND sent, verbatim, by gog. The bytes
 * contain ONLY the fields gog actually transmits — To/Cc/Bcc/Subject headers + body — so the checked
 * bytes equal the sent content (no fabricated `From`/`Message-Id` headers gog would replace). The
 * stable command marker is appended as a body footer line. Recipients are the PDP-approved addresses.
 */
export function buildOutboundBytes({ commandId, to, cc = [], bcc = [], subject, body }) {
  const headers = [`To: ${to.join(", ")}`];
  if (cc.length) headers.push(`Cc: ${cc.join(", ")}`);
  if (bcc.length) headers.push(`Bcc: ${bcc.join(", ")}`);
  headers.push(`Subject: ${subject}`);
  const footer = `\n\n-- \n${commandMarker(commandId)}`;
  return headers.join("\n") + "\n\n" + body + footer + "\n";
}

/** Default gog runner: shells the `gog` binary and returns stdout. Injected in tests. A bounded
 *  timeout means a hung send surfaces as a timeout error (→ outcome_unknown, reconcile-first). */
function defaultRunGog(args) {
  return execFileSync("gog", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

/** True when an exec error looks like a timeout/kill (unknown outcome) rather than a clean failure. */
function isTimeoutError(e) {
  return Boolean(e && (e.code === "ETIMEDOUT" || e.killed === true || e.signal === "SIGTERM"));
}

/**
 * A real gog-backed outbox send client (I-11). It honors the `OutboxSendClient` contract:
 *   • `querySent` is RECONCILE-FIRST + FAIL-CLOSED: it searches Sent for the stable body marker; on
 *     ANY exec/parse error it throws `OutboxReconcileError` (never returns `{found:false}` on error,
 *     which would risk a duplicate send). Robust to subject edits (marker lives in the body).
 *   • `send` sends EXACTLY the checked bytes: it parses `exact_outbound_bytes` via the loop's
 *     `parseOutboundMessage` and passes those recipients/subject/body to `gog gmail send` — no
 *     separate message object can diverge from what `checkPreSend` validated.
 * Credential/claim scope (G5): gog holds its own OS-keyring OAuth token — this wraps the send behind
 * the loop; it does not yet make the ambient CLI un-bypassable (that is G6b/I-15).
 */
export function createGogSendClient(loop, { account, commandId, runGog = defaultRunGog } = {}) {
  const acct = account ? ["-a", account] : [];
  const marker = commandMarker(commandId);
  return {
    querySent() {
      let out;
      try {
        out = runGog([
          "gmail",
          "search",
          `in:sent "${marker}"`,
          "--json",
          "--results-only",
          "--max",
          "1",
          ...acct,
        ]);
      } catch (e) {
        // Search outage: we do NOT know whether a prior send landed. Fail closed.
        throw new loop.OutboxReconcileError(`gog Sent search failed: ${e.message}`);
      }
      let arr;
      try {
        arr = JSON.parse(out);
      } catch (e) {
        throw new loop.OutboxReconcileError(`gog Sent search returned non-JSON: ${e.message}`);
      }
      if (Array.isArray(arr) && arr.length > 0) {
        return { found: true, message_id: arr[0].id, thread_id: arr[0].threadId || arr[0].id };
      }
      return { found: false };
    },
    send(exactOutboundBytes) {
      // Parse the EXACT checked bytes → the fields gog transmits. Checked bytes === sent content.
      const msg = loop.parseOutboundMessage(exactOutboundBytes);
      const args = ["gmail", "send", "--to", msg.to.join(",")];
      if (msg.cc.length) args.push("--cc", msg.cc.join(","));
      if (msg.bcc.length) args.push("--bcc", msg.bcc.join(","));
      args.push("--subject", msg.subject, "--body", msg.body, "--json", "--results-only", ...acct);
      let out;
      try {
        out = runGog(args);
      } catch (e) {
        // A timeout/kill is an UNKNOWN outcome (the message may have landed) → reconcile-first on the
        // next attempt. A clean failure means no message was created.
        if (isTimeoutError(e))
          throw new loop.OutboxTimeoutError(`gog send timed out: ${e.message}`);
        throw new loop.OutboxSendError(`gog send failed: ${e.message}`);
      }
      let r = {};
      try {
        r = JSON.parse(out);
      } catch {
        throw new loop.OutboxSendError("gog send returned non-JSON output");
      }
      const message_id = r.id || r.messageId || r.message_id || "";
      const thread_id = r.threadId || r.thread_id || message_id;
      if (!message_id) throw new loop.OutboxSendError("gog send returned no message id");
      return { message_id, thread_id };
    },
  };
}

/** Candidate gog config.json locations (macOS + XDG linux). First readable one wins. */
function gogConfigCandidates() {
  const home = os.homedir();
  return [
    path.join(home, "Library", "Application Support", "gogcli", "config.json"),
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "gogcli", "config.json"),
    path.join(home, ".config", "gog", "config.json"),
  ];
}

/**
 * Resolve how the gog send credential is stored, so the send path can apply the right gate:
 *   • `{ mode:"file", tokenPath }` — an explicit on-disk token file (env override, or a file-backend
 *     config). This is what `assertGatewayTokenSecurity` guards; missing/insecure → fail closed.
 *   • `{ mode:"keyring", reason }` — the token lives in the OS keyring (gog default `auto`). There is
 *     NO plaintext file to chmod; the file-mode gate is inapplicable and the OS keyring ACL is the
 *     boundary. Honest named skip, not a false pass.
 * Never reads the secret itself — only the config's backend field + an explicit file path.
 */
export function resolveGogCredential(env = process.env) {
  const override = env.AIOS_GOG_TOKEN_FILE;
  if (override && override.trim()) {
    return { mode: "file", tokenPath: override.trim(), source: "AIOS_GOG_TOKEN_FILE" };
  }
  for (const cfgPath of gogConfigCandidates()) {
    let raw;
    try {
      raw = readFileSync(cfgPath, "utf8");
    } catch {
      continue;
    }
    let cfg = {};
    try {
      cfg = JSON.parse(raw);
    } catch {
      /* unreadable config → fall through to the keyring default with a reason */
      return {
        mode: "keyring",
        reason: `gog config at ${cfgPath} is unparseable — assuming OS-keyring backend (no token file to guard)`,
      };
    }
    const backend = String(cfg.keyring_backend ?? "auto").toLowerCase();
    if (backend === "file" || backend === "plaintext") {
      const tokenPath = cfg.token_file || cfg.credentials_file || cfg.token_path || null;
      if (tokenPath) return { mode: "file", tokenPath: String(tokenPath), source: `${cfgPath}` };
      // File backend declared but path not discoverable → treat as an insecure/missing credential.
      return {
        mode: "file-unknown",
        reason: `gog config declares a file backend but no token path is discoverable in ${cfgPath}`,
      };
    }
    return {
      mode: "keyring",
      reason: `gog credential is OS-keyring-backed (keyring_backend=${backend}) — file mode/uid gate N/A; OS keyring ACL is the boundary`,
    };
  }
  return {
    mode: "keyring",
    reason: "no gog config found — assuming OS-keyring backend (no token file to guard)",
  };
}

/**
 * The pre-send credential gate: wire `assertGatewayTokenSecurity` into the real send path.
 * Returns `{ ok, skipped, reason }`. FAIL CLOSED on a supported POSIX platform when a token FILE is
 * in play and it is missing/insecure. A keyring-backed credential is a named skip (the OS keyring is
 * the boundary). The unsupported-platform (win32) skip from `assertGatewayTokenSecurity` is preserved.
 */
export function gogTokenSecurityGate(loop, { env = process.env, platform } = {}) {
  const cred = resolveGogCredential(env);
  if (cred.mode === "keyring") {
    return { ok: true, skipped: true, reason: cred.reason };
  }
  if (cred.mode === "file-unknown") {
    // A file backend we cannot locate is treated as missing → fail closed on POSIX.
    const r = loop.assertGatewayTokenSecurity(
      "/nonexistent-gog-token",
      platform ? { platform } : {}
    );
    if (r.skipped) return { ok: true, skipped: true, reason: r.reason };
    return { ok: false, skipped: false, reason: cred.reason };
  }
  // mode === "file": strictly assert the on-disk token.
  const r = loop.assertGatewayTokenSecurity(cred.tokenPath, platform ? { platform } : {});
  if (r.skipped) return { ok: true, skipped: true, reason: `${r.reason} (${cred.tokenPath})` };
  if (!r.ok) return { ok: false, skipped: false, reason: `${r.reason} (${cred.tokenPath})` };
  return { ok: true, skipped: false, reason: `${r.reason} (${cred.tokenPath})` };
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

    // 2) Recipients are DERIVED from the PDP-approved request — never free-typed. The bytes contain
    //    ONLY the fields gog transmits (To/Cc/Bcc/Subject + body); the stable reconcile marker lives
    //    in the BODY (robust to subject edits). These exact bytes are what `send` parses + transmits.
    const to = draft.request.recipients.map((r) => r.address);
    const bytes = buildOutboundBytes({
      commandId: draft.command_id,
      to,
      subject: String(draft.message.subject ?? ""),
      body: String(draft.message.body ?? ""),
    });

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
    const priorEvents = events
      .filter((e) => OUTBOX_EVENT_KINDS.has(e.kind))
      .map(journalToOutboxEvent);
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
      "       aios inbox --overdue [--window <minutes>] [--json]\n" +
      "       aios inbox rebuild [--db <path>] [--json]\n" +
      "       aios inbox compact [--boundary-seq <n>] [--json]\n" +
      "       aios inbox outbox [--json]\n" +
      "       aios inbox send --draft <draft.json> [--confirm] [--account <email>] [--json]"
  );
}
