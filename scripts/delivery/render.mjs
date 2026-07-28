/**
 * delivery/render.mjs — human table + `--json` rendering for `aios delivery status` (AIO-579).
 *
 * Pure formatting over the reconciled report entries produced by delivery/reconcile.mjs. No
 * subprocess/network calls, no mutation — this module only turns data into text.
 */

import { c } from "../cli-common.mjs";

/**
 * @param {Array<object>} reports  reconcileRepo() output, one per repo
 * @param {{now?: () => Date}} [opts]
 * @returns {string}  machine-readable JSON (stable field names, safe for cron/CI/agent parsing)
 */
export function renderJson(reports, { now = () => new Date() } = {}) {
  return JSON.stringify({ generatedAt: now().toISOString(), repos: reports }, null, 2);
}

function pad(value, width) {
  const s = String(value ?? "-");
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function prFlags(pr) {
  const flags = [];
  if (pr.isDraft) flags.push("draft");
  if (pr.headMismatch) flags.push("head-mismatch");
  if (pr.needsCleanup) flags.push("needs-cleanup");
  return flags;
}

function renderPrLine(pr) {
  const flags = prFlags(pr);
  const flagStr = flags.length ? ` [${flags.join(",")}]` : "";
  const head = `  #${pad(pr.number, 5)} ${pad(pr.state, 6)} checks=${pad(pr.checks, 7)} review=${pad(
    pr.reviewDecision || "-",
    16
  )} merge=${pad(pr.mergeStateStatus, 10)} ${pr.headRefName}${flagStr}`;
  return `${head}\n        ${pr.title}`;
}

/**
 * @param {Array<object>} reports  reconcileRepo() output, one per repo
 * @param {{now?: () => Date}} [opts]
 * @returns {string}  a terminal-oriented report; colour is automatically suppressed when
 *                     stdout is not a TTY (handled by the shared `c` palette).
 */
export function renderTable(reports, { now = () => new Date() } = {}) {
  const lines = [];
  lines.push(
    c.bold("AIOS delivery status") +
      c.dim(`  read-only reconciliation — generated ${now().toISOString()}`)
  );

  for (const r of reports) {
    lines.push("");
    lines.push(c.blue(`## ${r.slug}`) + c.dim(`  (local: ${r.localPath})`));

    if (r.localError) {
      lines.push(`  ${c.yellow("local checkout:")} ${r.localError}`);
    } else if (r.dirty === null) {
      lines.push("  primary/local checkout: unknown (git status failed — see notes)");
    } else if (r.dirty) {
      lines.push(`  primary/local checkout: ${c.yellow("DIRTY")} (reported only — never touched)`);
    } else {
      lines.push("  primary/local checkout: clean");
    }
    lines.push(`  worktrees: ${r.worktreeCount}`);

    if (!r.prs.length) {
      lines.push(`  PRs: none${r.prsError ? " (fetch failed — see notes)" : " found"}`);
    } else {
      const merged = r.prs.filter((p) => p.state === "MERGED").length;
      const open = r.prs.filter((p) => p.state === "OPEN").length;
      const closed = r.prs.filter((p) => p.state === "CLOSED").length;
      const cleanupPending = r.prs.filter((p) => p.needsCleanup).length;
      lines.push(
        `  PRs (${r.prs.length}: ${open} open, ${merged} merged, ${closed} closed` +
          (cleanupPending ? c.yellow(`, ${cleanupPending} need branch/worktree cleanup`) : "") +
          "):"
      );
      for (const pr of r.prs) lines.push(renderPrLine(pr));
    }

    if (r.orphanLocalBranches.length) {
      lines.push(`  orphan local branches (no matching PR): ${r.orphanLocalBranches.join(", ")}`);
    }
    if (r.orphanWorktrees.length) {
      lines.push(
        `  orphan worktrees (no matching PR): ${r.orphanWorktrees
          .map((w) => `${w.branch} (${w.path})`)
          .join(", ")}`
      );
    }
    for (const note of r.notes) lines.push(`  ${c.yellow("!")} ${note}`);
  }

  lines.push("");
  lines.push(c.dim("Read-only: this report never merges, deploys, tags, or deletes anything."));
  return lines.join("\n") + "\n";
}
