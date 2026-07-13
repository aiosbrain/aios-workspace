/**
 * asks.mjs — `aios asks` (AIO-167): non-blocking escalation queue, plus the hook-wiring
 * helpers (`aios asks wire`). Offline + local-first: an append-only NDJSON store folded to
 * state (`.aios/loop/asks/`, admin-tier, never synced). Subcommands: list / show / resolve /
 * drain / add / harvest / auto-approve / wire. Extracted from scripts/aios.mjs (AIO-315);
 * behaviour-preserving. All ask-store logic lives in the compiled operator loop.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { c, die } from "./cli-common.mjs";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";

// This toolkit's own hooks dir, resolved from aios.mjs's own location (works whether invoked
// from the main checkout or an npm-linked global `aios` — either way this file lives inside the
// one real toolkit checkout). `aios asks wire` (AIO-167 follow-up) uses ABSOLUTE paths into this
// dir rather than `${CLAUDE_PROJECT_DIR}`-relative ones, so capture keeps working in a worktree
// even when that worktree's own checked-out branch predates the hooks being added to main —
// the same pattern already used to wire capture into john-workspace (a repo with no copy of
// these hooks at all).
const TOOLKIT_HOOKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks");
const COMMS_CONFIG_REL = ".aios/comms-config.json";
const COMMS_CONFIG_DOCS = "docs/v1-operator-loop/domains/comms-config.example.json";
const missingCommsConfigNotice = `0 delivered — \`${COMMS_CONFIG_REL}\` missing, see ${COMMS_CONFIG_DOCS}`;

// `git worktree list --porcelain` → absolute paths of every worktree of `repo` (including
// `repo` itself). Best-effort: a repo with no `.git` or git not on PATH returns just `[repo]`.
function discoverWorktreePaths(repo) {
  try {
    const out = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    const paths = out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
    return paths.length ? paths : [repo];
  } catch {
    return [repo];
  }
}

// Idempotently ensure `target`'s .claude/settings.json has the Notification/Stop asks-capture
// hook and the PostToolUse decision-capture hook, pointed at THIS toolkit's absolute hook paths.
// Merge-only: every other key (permissions, other hook events, other hooks on the same event) is
// left byte-for-byte alone. Detection is a substring match on the hook script's basename, so a
// hook already wired via `${CLAUDE_PROJECT_DIR}`-relative path (the in-tree convention once a
// branch has the hooks merged) still counts as wired and is never duplicated.
function wireAsksHooksInto(target, { dryRun = false } = {}) {
  const settingsPath = path.join(target, ".claude", "settings.json");
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      return {
        repo: target,
        ok: false,
        error: "settings.json exists but is not valid JSON — skipped",
      };
    }
  }
  settings.hooks ??= {};
  if (
    typeof settings.hooks !== "object" ||
    settings.hooks === null ||
    Array.isArray(settings.hooks)
  ) {
    return {
      repo: target,
      ok: false,
      error: "settings.json has an unexpected 'hooks' shape — skipped",
    };
  }

  const hasHook = (event, matcher, basename) =>
    (settings.hooks[event] ?? []).some(
      (group) =>
        (matcher === undefined || group.matcher === matcher) &&
        (group.hooks ?? []).some((h) => String(h.command ?? "").includes(basename))
    );
  const addHook = (event, basename, matcher) => {
    settings.hooks[event] ??= [];
    const entry = { hooks: [{ type: "command", command: path.join(TOOLKIT_HOOKS_DIR, basename) }] };
    if (matcher !== undefined) entry.matcher = matcher;
    settings.hooks[event].push(entry);
  };

  const wanted = [
    ["Notification", undefined, "asks-capture.mjs"],
    ["Stop", undefined, "asks-capture.mjs"],
    ["UserPromptSubmit", undefined, "asks-capture.mjs"],
    ["PostToolUse", "AskUserQuestion|ExitPlanMode", "decision-capture.mjs"],
  ];
  const added = [];
  for (const [event, matcher, basename] of wanted) {
    if (!hasHook(event, matcher, basename)) {
      addHook(event, basename, matcher);
      added.push(`${event}${matcher ? `(${matcher})` : ""} → ${basename}`);
    }
  }

  if (!added.length) return { repo: target, ok: true, changed: false };
  if (!dryRun) {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return { repo: target, ok: true, changed: true, added };
}

// ── aios asks (AIO-167): non-blocking escalation queue ───────────────────────
// Offline + local-first. An append-only NDJSON store folded to state (`.aios/loop/asks/`,
// admin-tier, never synced). Mirrors cmdTime: dist import, `--repo` respected, friendly die if
// the loop isn't built. Subcommands: list / show / resolve / drain / add / harvest / wire.
export async function cmdAsks(repo, cfg, args) {
  const sub = args[0];
  const rest = args.slice(1);
  const flags = new Set(rest);
  const asJson = flags.has("--json");
  const argVal = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  // `wire` is pure settings.json bookkeeping — no ask-store access — so it runs before the
  // operator-loop dist check below, unlike every other subcommand here.
  if (sub === "wire") {
    const dryRun = flags.has("--dry-run");
    const targets = flags.has("--all-worktrees") ? discoverWorktreePaths(repo) : [repo];
    const results = targets.map((t) => wireAsksHooksInto(t, { dryRun }));
    if (asJson) {
      console.log(JSON.stringify({ results }, null, 2));
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      return;
    }
    console.log(
      c.blue("aios asks wire") +
        c.dim(`  ${targets.length} target(s)`) +
        (dryRun ? c.dim("  (dry-run)") : "")
    );
    for (const r of results) {
      if (!r.ok) console.log(`  ${c.dim(r.repo)}  ${c.dim("error: " + r.error)}`);
      else if (!r.changed) console.log(`  ${c.dim(r.repo)}  ${c.dim("already wired")}`);
      else {
        console.log(`  ${r.repo}  ${dryRun ? "would add" : "added"}:`);
        for (const a of r.added) console.log(c.dim(`    ${a}`));
      }
    }
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  const loop = await loadOperatorLoop();
  const warnNote = (warnings) => {
    if (warnings?.length && !asJson)
      console.error(c.dim(`  (${warnings.length} malformed line(s) skipped)`));
  };
  const resolveId = (asks, given) => {
    const exact = asks.find((a) => a.id === given);
    if (exact) return exact;
    const prefixed = asks.filter((a) => a.id.startsWith(given));
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1) die(`ambiguous id prefix: ${given}`);
    return null;
  };

  if (sub === "list") {
    const status = argVal("--status") ?? "open";
    const valid = ["open", "resolved", "orphaned", "all"];
    if (!valid.includes(status)) die(`--status must be one of ${valid.join("|")}`);
    const { asks, warnings } = loop.readAsks(repo);
    const filtered = (status === "all" ? asks : asks.filter((a) => a.status === status)).sort(
      (a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")
    );
    if (asJson) {
      console.log(JSON.stringify({ asks: filtered, warnings }, null, 2));
      return;
    }
    console.log(c.blue("aios asks") + c.dim(`  ${status} · ${filtered.length}`));
    for (const a of filtered)
      console.log(
        `  ${a.id.slice(0, 8)}  [${a.severity}] ${a.kind.padEnd(16)} ${a.title}` +
          (a.ref ? c.dim(`  ↳ ${a.ref}`) : "")
      );
    if (!filtered.length) console.log(c.dim("  (none)"));
    warnNote(warnings);
    return;
  }

  if (sub === "show") {
    const given = rest.find((a) => !a.startsWith("--"));
    if (!given) die("usage: aios asks show <id> [--json]");
    const { asks } = loop.readAsks(repo);
    const ask = resolveId(asks, given);
    if (!ask) die(`ask not found: ${given}`);
    if (asJson) {
      console.log(JSON.stringify(ask, null, 2));
      return;
    }
    console.log(c.blue(`aios asks show`) + c.dim(`  ${ask.id}`));
    console.log(`  status:    ${ask.status}`);
    console.log(`  severity:  ${ask.severity}`);
    console.log(`  kind:      ${ask.kind}`);
    console.log(`  title:     ${ask.title}`);
    if (ask.body) console.log(`  body:      ${ask.body}`);
    if (ask.ref) console.log(`  ref:       ${ask.ref}`);
    console.log(`  source:    ${ask.source}`);
    console.log(`  created:   ${ask.createdAt}`);
    if (ask.resolvedAt) console.log(`  closed:    ${ask.resolvedAt}`);
    return;
  }

  if (sub === "resolve") {
    const given = rest.filter((a) => !a.startsWith("--"));
    if (!given.length) die("usage: aios asks resolve <id...> [--json]");
    const { asks } = loop.readAsks(repo);
    // Validate ALL ids before any write — an unknown id dies before touching the store.
    const ids = given.map((g) => {
      const match = resolveId(asks, g);
      if (!match) die(`ask not found: ${g}`);
      return match.id;
    });
    const now = new Date().toISOString();
    for (const id of ids) loop.appendOp(repo, "resolve", id, now);
    if (asJson) {
      console.log(JSON.stringify({ resolved: ids }));
      return;
    }
    console.log(c.blue("aios asks resolve") + c.dim(`  ${ids.length} resolved`));
    return;
  }

  if (sub === "drain") {
    const keepOpen = flags.has("--keep-open");
    const nowArg = argVal("--now");
    const now = nowArg ? new Date(nowArg) : new Date();
    if (nowArg && Number.isNaN(now.getTime())) die(`--now is not a valid date: ${nowArg}`);
    const nowIso = now.toISOString();
    // (1) orphan-detect BEFORE resolve so orphaning is effective.
    const orphanIds = loop.detectOrphans(
      loop.readAsks(repo).asks.filter((a) => a.status === "open"),
      now
    );
    for (const id of orphanIds) loop.appendOp(repo, "orphan", id, nowIso);
    // (2) remaining open.
    const remaining = loop.readAsks(repo).asks.filter((a) => a.status === "open");
    // (3) auto-resolve (unless --keep-open).
    let drained = 0;
    if (!keepOpen)
      for (const a of remaining) {
        loop.appendOp(repo, "resolve", a.id, nowIso);
        drained++;
      }
    // (4) GC under the lock.
    const gc = loop.compact(repo, now);
    const summary = {
      drained,
      orphaned: orphanIds.length,
      gcRemoved: gc.removed,
      gcSkipped: Boolean(gc.skipped),
      remainingOpen: keepOpen ? remaining.length : 0,
    };
    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(c.blue("aios asks drain") + c.dim(keepOpen ? "  (--keep-open)" : ""));
    if (remaining.length) {
      console.log(c.dim(`  ${keepOpen ? "open" : "resolving"} (${remaining.length}):`));
      for (const a of remaining) console.log(`    ${a.id.slice(0, 8)}  [${a.severity}] ${a.title}`);
    }
    console.log(
      `  drained: ${drained}   orphaned: ${orphanIds.length}   gc-removed: ${gc.removed}` +
        (gc.skipped ? c.dim("   (gc skipped: lock contention — rerun drain)") : "")
    );
    return;
  }

  if (sub === "add") {
    const kind = argVal("--kind");
    const severity = argVal("--severity");
    const title = argVal("--title");
    if (!kind || !severity || !title)
      die(
        "usage: aios asks add --kind <k> --severity <blocker|decision|fyi> --title <t> [--body <b>] [--ref <r>] [--json]"
      );
    if (!["blocker", "decision", "fyi"].includes(severity))
      die("--severity must be one of blocker|decision|fyi");
    const openCount = loop.readAsks(repo).asks.filter((a) => a.status === "open").length;
    if (openCount >= loop.OPEN_SOFT_CAP && !asJson)
      console.error(
        c.dim(
          `  warning: ${openCount} open asks (soft cap ${loop.OPEN_SOFT_CAP}) — run \`aios asks drain\``
        )
      );
    const rec = loop.appendCreate(repo, {
      kind,
      severity,
      title,
      body: argVal("--body") ?? "",
      ref: argVal("--ref") ?? null,
      source: "cli",
    });
    if (asJson) {
      console.log(JSON.stringify({ id: rec.id }));
      return;
    }
    console.log(c.blue("aios asks add") + c.dim(`  ${rec.id}`));
    return;
  }

  if (sub === "harvest") {
    const cadence = argVal("--cadence") ?? "daily";
    if (!["daily", "weekly"].includes(cadence)) die("--cadence must be daily|weekly");
    const nowArg = argVal("--now");
    const now = nowArg ? new Date(nowArg) : null;
    if (now && Number.isNaN(now.getTime())) die(`--now is not a valid date: ${nowArg}`);
    const configMissing = !existsSync(path.join(repo, COMMS_CONFIG_REL));
    const res = await loop.harvestAsks(repo, {
      cadence,
      ...(now ? { now } : {}),
    });
    if (asJson) {
      console.log(
        JSON.stringify(configMissing ? { ...res, notice: missingCommsConfigNotice } : res, null, 2)
      );
      return;
    }
    console.log(c.blue("aios asks harvest") + c.dim(`  ${cadence}`));
    console.log(
      `  events: ${res.events}   delivered: ${res.delivered}   rejected: ${res.rejected}   noop: ${res.noop}   suppressed: ${res.suppressed}`
    );
    if (configMissing) console.log(`  ${missingCommsConfigNotice}`);
    return;
  }

  if (sub === "auto-approve") {
    const watch = flags.has("--watch");
    const intervalIdx = rest.indexOf("--interval");
    const interval = intervalIdx >= 0 ? parseInt(rest[intervalIdx + 1], 10) || 5 : 5;
    const scriptPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "asks-auto-approve.mjs"
    );
    if (!existsSync(scriptPath)) die("asks-auto-approve.mjs not found — run from repo root");

    // Reuse the store read/write functions that are already loaded.
    const knownIds = new Set();
    const roots = [repo];

    function tick() {
      let resolved = 0;
      let skipped = 0;
      let found = 0;
      for (const r of roots) {
        const { asks } = loop.readAsks(r);
        const open = asks.filter((a) => a.status === "open" && !knownIds.has(a.id));
        found += open.length;
        for (const ask of open) {
          const { severity, kind, title } = ask;
          let note = "";
          if (severity === "blocker" && kind === "idle") {
            note = "auto-approved: agent waiting for input";
            loop.appendOp(r, "resolve", ask.id);
            resolved++;
          } else if (severity === "fyi") {
            note = "auto-resolved: FYI status update";
            loop.appendOp(r, "resolve", ask.id);
            resolved++;
          } else if (severity === "decision" || severity === "blocker") {
            note = `auto-approved ${severity}: "${title.slice(0, 80)}"`;
            loop.appendOp(r, "resolve", ask.id);
            resolved++;
          } else {
            skipped++;
            note = "unknown type — skipping";
          }
          if (resolved + skipped > 0) {
            console.log(
              `${c.dim(new Date().toISOString())} ${severity === "blocker" ? "!" : severity === "decision" ? "?" : "i"} [${severity}] ${title.slice(0, 70)} — ${note}`
            );
          }
        }
      }
      if (found === 0 && resolved === 0) process.stdout.write(".");
      return { resolved, skipped, found };
    }

    if (watch) {
      console.log(
        c.blue("aios asks auto-approve") +
          c.dim(`  watching ${roots.length} root(s), polling every ${interval}s`)
      );
      tick();
      const timer = setInterval(tick, interval * 1000);
      process.on("SIGINT", () => {
        clearInterval(timer);
        console.log(c.dim("\nstopped"));
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        clearInterval(timer);
        console.log(c.dim("\nstopped"));
        process.exit(0);
      });
      return; // keep alive
    }

    const result = tick();
    console.log(
      c.blue("aios asks auto-approve") +
        c.dim(`  ${result.resolved} resolved, ${result.skipped} skipped, ${result.found} open`)
    );
    return;
  }

  die(
    "usage: aios asks list [--status open|resolved|orphaned|all] [--json]\n" +
      "       aios asks show <id> [--json]\n" +
      "       aios asks resolve <id...> [--json]\n" +
      "       aios asks drain [--keep-open] [--json]\n" +
      "       aios asks auto-approve [--watch] [--interval N]\n" +
      "       aios asks add --kind <k> --severity <blocker|decision|fyi> --title <t> [--body <b>] [--ref <r>] [--json]\n" +
      "       aios asks harvest [--cadence daily|weekly] [--json]\n" +
      "       aios asks wire [--all-worktrees] [--dry-run] [--json]"
  );
}
