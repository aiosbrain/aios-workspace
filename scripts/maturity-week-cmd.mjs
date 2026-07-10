/**
 * maturity-week-cmd.mjs — `aios maturity-week`: the local weekly AEM report + belts
 * (AM6, AIO-231). A read-only consumer of AM1's maturity session store; renders the
 * week's trajectory and writes an admin-tier file under 3-log/. The report/render
 * helpers live in ./maturity-week.mjs; this is just the CLI handler, extracted from
 * scripts/aios.mjs (AIO-315). Behaviour-preserving.
 */

import { statSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { c } from "./cli-common.mjs";
import { projectSlug, STORE_SIZE_CAP } from "./analyze/maturity-fold.mjs";
import { foldSessions, storePath } from "./analyze/maturity-store.mjs";
import { buildWeekReport, renderWeekReport, splitWeeks } from "./maturity-week.mjs";

const MATURITY_WEEK_HELP = `aios maturity-week [--json] [--out <path>] [--project <slug>]
  Weekly agentic-maturity trajectory: Spine level delta, per-axis gains, and the
  next-belt criteria (belts: White→Black + Ninja Master at a perfect L5).
  Reads .aios/loop/maturity/sessions.ndjson (AM1). Needs ≥ 5 sessions this week for
  the project; the prior week is optional (its absence just leaves deltas blank).
  Default → 3-log/maturity/week-<ISO-MONDAY>.md (admin tier, never synced).
  --json → machine shape on stdout · --out <path> → write elsewhere.
  --project <slug> overrides the project filter (default: this cwd's basename slug).
  Cadence: run weekly (cron / a Claude routine):  npm run aios -- maturity-week`;

// aios maturity-week — local weekly AEM report + belts (AM6, AIO-231). Read-only
// consumer of AM1's session store; writes an admin-tier file under 3-log/. The
// project filter mirrors AM2's brief: sessions are tagged by the SESSION cwd's
// basename slug, so we filter by projectSlug(process.cwd()) (or --project), NOT by
// the workspace-root basename (`repo` is only the store + output root).
export function cmdMaturityWeek(repo, rest) {
  if (rest.includes("-h") || rest.includes("--help")) {
    console.log(MATURITY_WEEK_HELP);
    return;
  }
  const valOf = (flag) => {
    const i = rest.indexOf(flag);
    return i !== -1 ? rest[i + 1] : null;
  };
  const project = valOf("--project") || projectSlug(process.cwd());
  const sp = storePath(repo);

  let text;
  try {
    if (statSync(sp).size > STORE_SIZE_CAP) {
      console.log(
        c.yellow(
          `maturity store is oversized (> ${Math.round(STORE_SIZE_CAP / 1024 / 1024)} MB) — skipping. It self-compacts; try again later.`
        )
      );
      return;
    }
    text = readFileSync(sp, "utf8");
  } catch {
    console.log(
      c.dim(
        `no maturity sessions yet at ${path.relative(repo, sp)} — the AM1 capture hook writes them as you work.`
      )
    );
    return;
  }

  const { sessions } = foldSessions(text);
  const forProject = [...sessions.values()].filter((s) => s && s.counts && s.project === project);
  const now = new Date();
  const { thisWeek, prevWeek } = splitWeeks(forProject, now);
  const report = buildWeekReport({ sessions: thisWeek, prevWeekSessions: prevWeek, now });

  if (rest.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const md = renderWeekReport(report);
  const out = valOf("--out") || path.join(repo, "3-log", "maturity", `week-${report.weekOf}.md`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, md);
  console.log(c.green(`Wrote ${path.relative(repo, out)}`));
  if (!report.sufficient) {
    console.log(
      c.dim(
        `  (${report.insufficient.have} of ${report.insufficient.need} sessions this week for '${project}' — capture more for a trajectory read)`
      )
    );
  }
}
