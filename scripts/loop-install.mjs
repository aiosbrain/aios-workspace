/**
 * loop-install.mjs — `aios loop install` (AIO-367): environment-aware scheduler install for
 * daily + weekly + an `aios analyze` self-refresh.
 *
 * Kills the phantom-cron nag in hooks/session-pulse.mjs + scripts/maturity-week-cmd.mjs, which
 * pointed at a cron/install path that never existed. This module IS that path.
 *
 * Environment heuristic (kept deliberately simple — see docs/loop-install.md):
 *   macOS  → launchd LaunchAgent (StartCalendarInterval gives free catch-up-on-wake: a job
 *            missed while the laptop was asleep runs as soon as the system wakes, unlike cron).
 *   other  → cron (the realistic 24/7-box case for this toolkit's users; cron has no catch-up,
 *            which is fine — a server isn't expected to sleep).
 * `--scheduler launchd|cron` overrides detection for testing / an atypical setup.
 *
 * Three jobs are installed:
 *   daily    aios loop daily      — every morning (08:00)
 *   weekly   aios loop weekly; aios maturity-week — Monday morning (08:15); bundles the AM6
 *            weekly maturity report into the same slot so its own cron nag is satisfied too
 *   analyze  aios analyze         — hourly; cheap (~3.7s) so it just self-refreshes instead of
 *            asking a human to remember a cron that doesn't exist
 *
 * Idempotent: launchd installs overwrite the same labeled plist; cron installs replace a single
 * marker-delimited block (mirrors scripts/install-aios-shell.sh's strip-then-append pattern) so
 * running `install` twice never duplicates entries.
 *
 * Side-effecting functions accept an injectable `{ fs, exec }` so tests can drive real logic
 * (plan building, plist/cron-line generation, idempotent merge) without touching the real
 * ~/Library/LaunchAgents or the real crontab.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { c, die, slugify } from "./cli-common.mjs";
import { resolveLoopIdentity } from "./loop-config.mjs";

const nodeFs = { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync };

// ── environment detection ───────────────────────────────────────────────────────────────────

/** macOS → launchd (gets catch-up-on-wake for free); everything else → cron (24/7-box case). */
export function detectScheduler(platform = process.platform) {
  return platform === "darwin" ? "launchd" : "cron";
}

// ── CLI invocation resolution (reuses the existing bin/aios + scripts/aios.mjs shim chain —
//    the same resolution install-aios-shell.sh's aios() function and the npm "aios" script
//    already rely on; no new mechanism) ──────────────────────────────────────────────────────

export function resolveAiosInvocation(repo, { execPath = process.execPath, fs = nodeFs } = {}) {
  const binAios = path.join(repo, "bin", "aios");
  if (fs.existsSync(binAios)) return { command: binAios, baseArgs: [] };
  const cliScript = path.join(repo, "scripts", "aios.mjs");
  return { command: execPath, baseArgs: [cliScript] };
}

function shellQuote(s) {
  return /^[A-Za-z0-9_\-./]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── install plan (pure — everything below is deterministic given repo/platform/home) ────────

const JOB_DEFS = [
  {
    key: "daily",
    label: (slug) => `com.aios.${slug}.loop-daily`,
    argsList: [["loop", "daily"]],
    calendar: { Hour: 8, Minute: 0 },
    cronSchedule: "0 8 * * *",
  },
  {
    key: "weekly",
    label: (slug) => `com.aios.${slug}.loop-weekly`,
    // Bundles the AM6 weekly maturity report into the same slot (see file header) so
    // maturity-week-cmd.mjs's "run weekly" cadence note has one real installed home too.
    argsList: [["loop", "weekly"], ["maturity-week"]],
    calendar: { Weekday: 1, Hour: 8, Minute: 15 },
    cronSchedule: "15 8 * * 1",
  },
  {
    key: "analyze",
    label: (slug) => `com.aios.${slug}.analyze`,
    argsList: [["analyze"]],
    startInterval: 3600,
    cronSchedule: "0 * * * *",
  },
];

/** Build the full, deterministic install plan for `repo`. Never touches disk or the system. */
export function buildInstallPlan({
  repo,
  platform = process.platform,
  home = os.homedir(),
  scheduler,
} = {}) {
  const { project } = resolveLoopIdentity(repo);
  const slug = project || slugify(path.basename(repo)) || "workspace";
  const chosenScheduler = scheduler || detectScheduler(platform);
  const { command, baseArgs } = resolveAiosInvocation(repo);
  const logsDir = path.join(repo, ".aios", "loop", "logs");

  const buildCommandLine = (argsList) =>
    argsList
      .map((jobArgs) => [command, ...baseArgs, ...jobArgs].map(shellQuote).join(" "))
      .join("; ");

  const jobs = JOB_DEFS.map((def) => {
    const label = def.label(slug);
    // A single job may run more than one CLI invocation (the weekly bundle) — always wrap in
    // /bin/sh -c so both launchd (single ProgramArguments exec) and cron (already a shell) run
    // the same command line.
    const commandLine = buildCommandLine(def.argsList);
    const programArguments = ["/bin/sh", "-c", commandLine];
    return {
      key: def.key,
      label,
      commandLine,
      programArguments,
      calendar: def.calendar || null,
      startInterval: def.startInterval || null,
      cronSchedule: def.cronSchedule,
      workingDirectory: repo,
      logPath: path.join(logsDir, `${def.key}.log`),
      plistPath: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    };
  });

  return { repo, slug, scheduler: chosenScheduler, jobs, logsDir, home };
}

// ── launchd ──────────────────────────────────────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render one launchd LaunchAgent plist. StartCalendarInterval is what gives catch-up-on-wake:
 * launchd runs a missed calendar-interval job as soon as the system is next awake, rather than
 * silently skipping it (unlike cron, which has no such mechanism). */
export function buildLaunchdPlist({
  label,
  programArguments,
  workingDirectory,
  startCalendarInterval,
  startInterval,
  stdoutPath,
  stderrPath,
}) {
  const argsXml = programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  let scheduleXml = "";
  if (startCalendarInterval) {
    const entries = Array.isArray(startCalendarInterval)
      ? startCalendarInterval
      : [startCalendarInterval];
    const dictFor = (e) =>
      `    <dict>\n${Object.entries(e)
        .map(([k, v]) => `      <key>${k}</key>\n      <integer>${v}</integer>`)
        .join("\n")}\n    </dict>`;
    scheduleXml =
      entries.length === 1
        ? `  <key>StartCalendarInterval</key>\n${dictFor(entries[0])}\n`
        : `  <key>StartCalendarInterval</key>\n  <array>\n${entries.map(dictFor).join("\n")}\n  </array>\n`;
  } else if (startInterval) {
    scheduleXml = `  <key>StartInterval</key>\n  <integer>${startInterval}</integer>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDirectory)}</string>
${scheduleXml}  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

export function renderLaunchdPlan(plan) {
  return plan.jobs.map((j) => ({
    label: j.label,
    path: j.plistPath,
    content: buildLaunchdPlist({
      label: j.label,
      programArguments: j.programArguments,
      workingDirectory: j.workingDirectory,
      startCalendarInterval: j.calendar,
      startInterval: j.startInterval,
      stdoutPath: j.logPath,
      stderrPath: j.logPath,
    }),
  }));
}

function launchctlUid() {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/** Write + (re)load each LaunchAgent. Idempotent: same label ⇒ same file path, overwritten in
 * place; a prior load is booted out first so launchctl never reports a duplicate. `load: false`
 * skips the actual launchctl calls (used by tests / --dry-run-adjacent callers). */
export function applyLaunchdInstall(plan, { fs = nodeFs, exec = execFileSync, load = true } = {}) {
  fs.mkdirSync(plan.logsDir, { recursive: true });
  const rendered = renderLaunchdPlan(plan);
  const results = [];
  for (const r of rendered) {
    fs.mkdirSync(path.dirname(r.path), { recursive: true });
    if (load) {
      try {
        exec("launchctl", ["bootout", `gui/${launchctlUid()}/${r.label}`], { stdio: "ignore" });
      } catch {
        /* not currently loaded — fine */
      }
    }
    fs.writeFileSync(r.path, r.content);
    let loaded = !load;
    if (load) {
      try {
        exec("launchctl", ["bootstrap", `gui/${launchctlUid()}`, r.path], { stdio: "ignore" });
        loaded = true;
      } catch {
        try {
          exec("launchctl", ["load", "-w", r.path], { stdio: "ignore" });
          loaded = true;
        } catch {
          loaded = false;
        }
      }
    }
    results.push({ label: r.label, path: r.path, loaded });
  }
  return results;
}

export function applyLaunchdUninstall(plan, { fs = nodeFs, exec = execFileSync } = {}) {
  const removed = [];
  for (const j of plan.jobs) {
    try {
      exec("launchctl", ["bootout", `gui/${launchctlUid()}/${j.label}`], { stdio: "ignore" });
    } catch {
      /* not loaded — fine */
    }
    if (fs.existsSync(j.plistPath)) {
      fs.unlinkSync(j.plistPath);
      removed.push(j.plistPath);
    }
  }
  return removed;
}

// ── cron ─────────────────────────────────────────────────────────────────────────────────────

export function cronMarkers(slug) {
  return {
    begin: `# >>> aios-loop-install (${slug}) begin >>>`,
    end: `# <<< aios-loop-install (${slug}) end <<<`,
  };
}

export function buildCronBlock(plan) {
  const { begin, end } = cronMarkers(plan.slug);
  const lines = plan.jobs.map(
    (j) =>
      `${j.cronSchedule} cd ${shellQuote(j.workingDirectory)} && { ${j.commandLine}; } >> ${shellQuote(j.logPath)} 2>&1`
  );
  return [begin, ...lines, end].join("\n");
}

function stripCronBlock(existingCrontab, slug) {
  const { begin, end } = cronMarkers(slug);
  const lines = existingCrontab.split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line === begin) {
      skipping = true;
      continue;
    }
    if (line === end) {
      skipping = false;
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Idempotent merge: strip any prior aios-loop-install block for this slug, then append the
 * current one. Calling this twice with the same plan yields the same single block — no
 * duplicate entries build up (mirrors install-aios-shell.sh's strip_block()). */
export function mergeCronBlock(existingCrontab, block, slug) {
  const stripped = stripCronBlock(existingCrontab, slug).replace(/\n+$/, "");
  return stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
}

export function applyCronInstall(plan, { exec = execFileSync, fs = nodeFs } = {}) {
  fs.mkdirSync(plan.logsDir, { recursive: true });
  let existing = "";
  try {
    existing = exec("crontab", ["-l"], { encoding: "utf8" });
  } catch {
    existing = ""; // no crontab yet — fine
  }
  const block = buildCronBlock(plan);
  const merged = mergeCronBlock(existing, block, plan.slug);
  exec("crontab", ["-"], { input: merged, encoding: "utf8" });
  return { crontab: merged };
}

export function applyCronUninstall(plan, { exec = execFileSync } = {}) {
  let existing = "";
  try {
    existing = exec("crontab", ["-l"], { encoding: "utf8" });
  } catch {
    return { crontab: "" };
  }
  const stripped = stripCronBlock(existing, plan.slug);
  exec("crontab", ["-"], { input: stripped, encoding: "utf8" });
  return { crontab: stripped };
}

export function readCronStatus(plan, { exec = execFileSync } = {}) {
  let existing = "";
  try {
    existing = exec("crontab", ["-l"], { encoding: "utf8" });
  } catch {
    existing = "";
  }
  return existing.includes(cronMarkers(plan.slug).begin);
}

// ── CLI surface ──────────────────────────────────────────────────────────────────────────────

const INSTALL_HELP = `aios loop install [--dry-run] [--uninstall] [--status] [--scheduler launchd|cron]
  Detects the environment and installs a real scheduler for the operator loop:
    macOS       → launchd LaunchAgent per job (catch-up-on-wake via StartCalendarInterval)
    Linux/other → crontab entries (a single marker-delimited, idempotent block)
  Installs three jobs: \`aios loop daily\` (morning), \`aios loop weekly\` + \`aios maturity-week\`
  (Monday morning), and \`aios analyze\` (hourly self-refresh — it's ~3.7s, so it just runs
  instead of nagging a human to remember a cron). Re-running is idempotent (no duplicates).
  --dry-run        print the plan; write nothing
  --uninstall      remove the installed job(s) for this workspace
  --status         report whether the job(s) are currently installed
  --scheduler ...  override environment detection
  See docs/loop-install.md for the auth recipe (F-C6): a scheduled run authenticates via
  .env.keys (dotenvx) with no direnv needed, as long as .env.keys exists next to .env.`;

function printPlan(plan, { installed = false } = {}) {
  const verb = installed ? "Installed" : "Plan";
  console.log(
    c.blue(`aios loop install`) + c.dim(`  scheduler: ${plan.scheduler} · workspace: ${plan.slug}`)
  );
  for (const j of plan.jobs) {
    const where = plan.scheduler === "launchd" ? j.plistPath : `crontab (${j.cronSchedule})`;
    console.log(
      `  ${c.green(verb === "Installed" ? "wrote" : "would write")} ${c.bold(j.key).padEnd(16)} ${j.commandLine}`
    );
    console.log(c.dim(`         → ${where}`));
  }
  console.log(c.dim(`  logs → ${plan.logsDir}`));
}

function printStatus(plan) {
  console.log(
    c.blue(`aios loop install — status`) +
      c.dim(`  scheduler: ${plan.scheduler} · workspace: ${plan.slug}`)
  );
  if (plan.scheduler === "launchd") {
    for (const j of plan.jobs) {
      const installed = existsSync(j.plistPath);
      console.log(
        `  ${installed ? c.green("installed") : c.dim("missing  ")}  ${j.key.padEnd(8)} ${j.plistPath}`
      );
    }
  } else {
    const installed = readCronStatus(plan);
    console.log(
      installed
        ? c.green(`  installed — crontab has the aios-loop-install (${plan.slug}) block`)
        : c.dim(`  missing — no aios-loop-install (${plan.slug}) block in crontab`)
    );
  }
}

export function cmdLoopInstall(repo, args) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(INSTALL_HELP);
    return;
  }
  const schedIdx = args.indexOf("--scheduler");
  if (schedIdx >= 0 && (!args[schedIdx + 1] || args[schedIdx + 1].startsWith("--"))) {
    die("--scheduler requires launchd|cron");
  }
  const schedulerOverride = schedIdx >= 0 ? args[schedIdx + 1] : null;
  if (schedulerOverride && !["launchd", "cron"].includes(schedulerOverride)) {
    die("--scheduler must be launchd|cron");
  }
  const consumedSchedulerValue = schedIdx >= 0 ? schedIdx + 1 : -1;
  const unknown = args.find(
    (arg, idx) =>
      idx !== consumedSchedulerValue &&
      !["--dry-run", "--uninstall", "--status", "--scheduler"].includes(arg)
  );
  if (unknown) die(`unknown loop install option: ${unknown}`);
  const dryRun = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");
  const status = args.includes("--status");
  if ([dryRun, uninstall, status].filter(Boolean).length > 1) {
    die("choose only one of --dry-run / --uninstall / --status");
  }

  const plan = buildInstallPlan({ repo, scheduler: schedulerOverride });

  if (status) return printStatus(plan);
  if (dryRun) return printPlan(plan, { installed: false });

  if (uninstall) {
    if (plan.scheduler === "launchd") applyLaunchdUninstall(plan);
    else applyCronUninstall(plan);
    console.log(c.green(`Removed the aios loop scheduler (${plan.scheduler}) for '${plan.slug}'.`));
    return;
  }

  if (plan.scheduler === "launchd") {
    const results = applyLaunchdInstall(plan);
    const failed = results.filter((result) => !result.loaded);
    if (failed.length) {
      die(
        `wrote ${failed.length} LaunchAgent plist(s), but launchctl could not load them: ` +
          failed.map((result) => result.label).join(", ")
      );
    }
  } else applyCronInstall(plan);
  printPlan(plan, { installed: true });
  console.log(
    c.yellow(
      "  auth: a scheduled run decrypts $AIOS_API_KEY from .env via .env.keys automatically " +
        "(F-C6) — no direnv needed, as long as .env.keys sits next to .env. See docs/loop-install.md."
    )
  );
}
