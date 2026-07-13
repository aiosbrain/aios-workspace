/**
 * time.mjs — `aios time` (AIO-139): native agent-session runtime capture.
 *
 * Offline + local-first. Reads ~/.claude session logs, scopes strictly by realpath
 * allowlist (unknown repos never up-scoped), and writes an admin-tier
 * `<spine.log>/time-log.md` that never syncs. `report` is read-only; `reconcile`
 * targets rows by opaque id. Extracted from scripts/aios.mjs (AIO-315);
 * behaviour-preserving. All runtime logic lives in the compiled operator loop.
 */

import { c, die } from "./cli-common.mjs";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";

export async function cmdTime(repo, cfg, args) {
  const sub = args[0];
  const flags = new Set(args.slice(1));
  const loop = await loadOperatorLoop();
  const argVal = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };

  if (sub === "capture") {
    const configPath = argVal("--config");
    const reposArg = argVal("--repos");
    const extraTeamRepos = reposArg
      ? reposArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const dryRun = flags.has("--dry-run");
    const projectsDir = argVal("--projects-dir"); // testing/override hook for ~/.claude/projects
    const nowArg = argVal("--now"); // testing/override hook for "now"
    const summary = loop.capture({
      root: repo,
      configPath,
      extraTeamRepos,
      dryRun,
      ...(projectsDir ? { projectsDir } : {}),
      ...(nowArg ? { now: new Date(nowArg) } : {}),
    });
    if (flags.has("--json")) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(c.blue("aios time capture") + c.dim(dryRun ? "  (dry-run — no write)" : ""));
    console.log(
      `  blocks: ${summary.totalBlocks}   captured: ${summary.captured}   excluded (unlisted): ${summary.excludedUnlisted}`
    );
    console.log(
      `  rows ${dryRun ? "would change" : "changed"}: ${summary.written}   store → ${summary.rel}`
    );
    if (summary.excludedUnlisted > 0)
      console.log(c.dim("  tip: allowlist repos in .aios/time-config.json to capture them"));
    return;
  }

  if (sub === "report") {
    const window = argVal("--window") === "daily" ? "daily" : "weekly";
    const days = window === "daily" ? 1 : 7;
    const asJson = flags.has("--json");
    const read = loop.readStore(repo);
    const nowArg = argVal("--now"); // testing/override hook
    const now = nowArg ? new Date(nowArg).getTime() : Date.now();
    const fromMs = now - days * 86_400_000;
    const inWin = read.rows.filter((r) => {
      const t = Date.parse(r.startIso);
      return Number.isFinite(t) && t >= fromMs && t <= now;
    });
    const totals = loop.runtimeByTag(inWin.map((r) => ({ tag: r.tag, durationMin: r.runtimeMin })));
    const totalMin = totals.reduce((a, t) => a + t.durationMin, 0);
    if (asJson) {
      console.log(JSON.stringify({ window, byTag: totals, totalMin, rows: inWin }, null, 2));
      return;
    }
    console.log(
      c.blue("aios time report") + c.dim(`  ${window} · ${loop.formatHours(totalMin)} total`)
    );
    for (const t of totals) console.log(`  ${t.tag.padEnd(14)} ${loop.formatHours(t.durationMin)}`);
    if (!totals.length)
      console.log(c.dim("  no runtime in window — run `aios time capture` first"));
    return;
  }

  if (sub === "reconcile") {
    const idArg = argVal("--id");
    const ids = idArg
      ? idArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (!ids.length)
      die(
        "usage: aios time reconcile --id <id,...> [--set-tag <tag>] [--set-tier <tier>] [--confirm] [--dry-run] [--json]\n" +
          "hint: run `aios time report --json` to list captured row ids"
      );
    const result = loop.reconcile({
      root: repo,
      ids,
      setTag: argVal("--set-tag") ?? undefined,
      setTier: argVal("--set-tier") ?? undefined,
      confirm: flags.has("--confirm"),
      dryRun: flags.has("--dry-run"),
    });
    if (flags.has("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      c.blue("aios time reconcile") + c.dim(flags.has("--dry-run") ? "  (dry-run — no write)" : "")
    );
    console.log(`  updated: ${result.updated.join(", ") || "(none)"}`);
    return;
  }

  die(
    "usage: aios time capture [--config <path>] [--repos <realpath,...>] [--dry-run] [--json]\n" +
      "       aios time report [--window daily|weekly] [--json]\n" +
      "       aios time reconcile --id <id,...> [--set-tag <tag>] [--set-tier <tier>] [--confirm] [--dry-run] [--json]"
  );
}
