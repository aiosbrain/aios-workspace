// test/loop-install.test.mjs — `aios loop install` (AIO-367): environment detection, launchd
// plist / crontab-entry generation, and idempotency. Exercises the pure planning/rendering
// functions directly (mocked platform, temp paths, stubbed exec) — never touches the real
// ~/Library/LaunchAgents or the real crontab.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectScheduler,
  resolveAiosInvocation,
  buildInstallPlan,
  buildLaunchdPlist,
  renderLaunchdPlan,
  applyLaunchdInstall,
  applyLaunchdUninstall,
  cronMarkers,
  buildCronBlock,
  mergeCronBlock,
  applyCronInstall,
  applyCronUninstall,
  pinnedRuntimeFromPlist,
  pinnedRuntimesFromCrontab,
  checkPinnedRuntimes,
  WIN32_UNSUPPORTED_MESSAGE,
} from "../scripts/loop-install.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

function tmpWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "loop-install-"));
  writeFileSync(path.join(dir, "aios.yaml"), "brain_url: https://brain.example\nteam_id: t\n");
  return dir;
}

// ── environment detection ───────────────────────────────────────────────────────────────────

test("detectScheduler: darwin -> launchd", () => {
  assert.equal(detectScheduler("darwin"), "launchd");
});

test("detectScheduler: linux -> cron", () => {
  assert.equal(detectScheduler("linux"), "cron");
});

test("detectScheduler: other unixes (freebsd, ...) -> cron", () => {
  assert.equal(detectScheduler("freebsd"), "cron");
});

test("detectScheduler: native win32 is refused with WSL guidance (AIO-451)", () => {
  assert.throws(() => detectScheduler("win32"), /WSL/);
  assert.throws(() => detectScheduler("win32"), /AIO-451/);
  assert.match(WIN32_UNSUPPORTED_MESSAGE, /docs\/loop-install\.md/);
});

test("buildInstallPlan: native win32 is refused even with a --scheduler override", () => {
  const dir = tmpWorkspace();
  try {
    assert.throws(() => buildInstallPlan({ repo: dir, platform: "win32" }), /WSL/);
    assert.throws(
      () => buildInstallPlan({ repo: dir, platform: "win32", scheduler: "cron" }),
      /AIO-451/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CLI invocation resolution pins Node for non-interactive scheduler environments.

test("resolveAiosInvocation: bypasses bin/aios and pins the installing Node runtime", () => {
  const dir = tmpWorkspace();
  try {
    mkdirSync(path.join(dir, "bin"), { recursive: true });
    writeFileSync(
      path.join(dir, "bin", "aios"),
      '#!/bin/sh\nexec node "$PWD/scripts/aios.mjs" "$@"\n'
    );
    const { command, baseArgs } = resolveAiosInvocation(dir, {
      execPath: "/nvm/node-v22/bin/node",
    });
    assert.equal(command, "/nvm/node-v22/bin/node");
    assert.deepEqual(baseArgs, [path.join(dir, "scripts", "aios.mjs")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAiosInvocation: uses node + scripts/aios.mjs when bin/aios is absent", () => {
  const dir = tmpWorkspace();
  try {
    const { command, baseArgs } = resolveAiosInvocation(dir, { execPath: "/usr/bin/node" });
    assert.equal(command, "/usr/bin/node");
    assert.deepEqual(baseArgs, [path.join(dir, "scripts", "aios.mjs")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── install plan ─────────────────────────────────────────────────────────────────────────────

test("buildInstallPlan: three jobs (daily/weekly/analyze), scheduler follows platform", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const plan = buildInstallPlan({
      repo: dir,
      platform: "darwin",
      home,
      execPath: "/nvm/node-v22/bin/node",
    });
    assert.equal(plan.scheduler, "launchd");
    assert.deepEqual(
      plan.jobs.map((j) => j.key),
      ["daily", "weekly", "analyze"]
    );
    const daily = plan.jobs.find((j) => j.key === "daily");
    assert.match(daily.commandLine, /^\/nvm\/node-v22\/bin\/node /);
    assert.match(daily.commandLine, /loop.*daily/);
    const weekly = plan.jobs.find((j) => j.key === "weekly");
    // The weekly job bundles the AM6 maturity report so its own "run weekly" nag has a real home.
    assert.match(weekly.commandLine, /loop.*weekly/);
    assert.match(weekly.commandLine, /maturity-week/);
    const analyze = plan.jobs.find((j) => j.key === "analyze");
    assert.match(analyze.commandLine, /analyze/);
    // analyze now uses StartCalendarInterval (Minute: 0 = fires once per hour, at :00) instead of
    // plain StartInterval, so it gets the same launchd catch-up-on-wake behavior as daily/weekly
    // (StartInterval's elapsed-time timer can silently stop advancing across sleep/DarkWake).
    assert.equal(analyze.startInterval, null);
    assert.ok(analyze.calendar && typeof analyze.calendar.Minute === "number");
    assert.equal(analyze.calendar.Minute, 0);
    assert.ok(daily.calendar && typeof daily.calendar.Hour === "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildInstallPlan: threads an injected envPath through to the plan (bug 1 — missing PATH)", () => {
  const dir = tmpWorkspace();
  try {
    const plan = buildInstallPlan({
      repo: dir,
      platform: "linux",
      envPath: "/opt/homebrew/bin:/Users/demo/.local/bin:/usr/bin:/bin",
    });
    assert.equal(plan.envPath, "/opt/homebrew/bin:/Users/demo/.local/bin:/usr/bin:/bin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildInstallPlan: defaults envPath from process.env.PATH when not injected", () => {
  const dir = tmpWorkspace();
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "linux" });
    assert.equal(plan.envPath, process.env.PATH || "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderLaunchdPlan: threads plan.envPath into every rendered plist's PATH", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const plan = buildInstallPlan({
      repo: dir,
      platform: "darwin",
      home,
      envPath: "/opt/homebrew/bin:/usr/bin:/bin",
    });
    const rendered = renderLaunchdPlan(plan);
    assert.equal(rendered.length, 3);
    for (const r of rendered) {
      assert.match(r.content, /<key>EnvironmentVariables<\/key>/);
      assert.match(r.content, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildCronBlock: prefixes each job's subshell with `export PATH=...;` scoped to that job only", () => {
  const dir = tmpWorkspace();
  try {
    const plan = buildInstallPlan({
      repo: dir,
      platform: "linux",
      envPath: "/opt/homebrew/bin:/usr/bin:/bin",
    });
    const block = buildCronBlock(plan);
    const lines = block.split("\n").filter((l) => !l.startsWith("#"));
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.match(line, /&& \{ export PATH='\/opt\/homebrew\/bin:\/usr\/bin:\/bin'; /);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCronBlock: omits the PATH prefix entirely when plan.envPath is empty", () => {
  const dir = tmpWorkspace();
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "linux", envPath: "" });
    const block = buildCronBlock(plan);
    assert.doesNotMatch(block, /export PATH=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildInstallPlan: --scheduler override wins over platform detection", () => {
  const dir = tmpWorkspace();
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "darwin", scheduler: "cron" });
    assert.equal(plan.scheduler, "cron");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── launchd plist rendering ──────────────────────────────────────────────────────────────────

test("buildLaunchdPlist: contains Label, ProgramArguments, WorkingDirectory, and no eager run", () => {
  const xml = buildLaunchdPlist({
    label: "com.aios.demo.loop-daily",
    programArguments: ["/bin/sh", "-c", "/usr/bin/node /repo/scripts/aios.mjs loop daily"],
    workingDirectory: "/repo",
    startCalendarInterval: { Hour: 8, Minute: 0 },
    stdoutPath: "/repo/.aios/loop/logs/daily.log",
    stderrPath: "/repo/.aios/loop/logs/daily.log",
  });
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.aios\.demo\.loop-daily<\/string>/);
  assert.match(xml, /<key>ProgramArguments<\/key>/);
  assert.match(xml, /<string>\/bin\/sh<\/string>/);
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/repo<\/string>/);
  assert.doesNotMatch(xml, /<key>RunAtLoad<\/key>/);
  // StartCalendarInterval is the catch-up-on-wake mechanism (launchd runs a missed job on wake).
  assert.match(xml, /<key>StartCalendarInterval<\/key>/);
  assert.match(xml, /<key>Hour<\/key>\s*<integer>8<\/integer>/);
});

// launchd's default env for a LaunchAgent (no EnvironmentVariables key) is just
// /usr/bin:/bin:/usr/sbin:/sbin, so connector child processes spawned by bare name (gog, slack,
// granola, ...) can't find user-installed CLIs. buildLaunchdPlist must emit an explicit
// EnvironmentVariables/PATH block when an envPath is supplied.
test("buildLaunchdPlist: emits EnvironmentVariables/PATH when envPath is supplied", () => {
  const xml = buildLaunchdPlist({
    label: "com.aios.demo.loop-daily",
    programArguments: ["/bin/sh", "-c", "/usr/bin/node /repo/scripts/aios.mjs loop daily"],
    workingDirectory: "/repo",
    startCalendarInterval: { Hour: 8, Minute: 0 },
    stdoutPath: "/repo/.aios/loop/logs/daily.log",
    stderrPath: "/repo/.aios/loop/logs/daily.log",
    envPath: "/opt/homebrew/bin:/Users/demo/.local/bin:/usr/bin:/bin",
  });
  assert.match(xml, /<key>EnvironmentVariables<\/key>/);
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:.*<\/string>/);
});

test("buildLaunchdPlist: omits EnvironmentVariables entirely when no envPath is supplied", () => {
  const xml = buildLaunchdPlist({
    label: "com.aios.demo.loop-daily",
    programArguments: ["/bin/sh", "-c", "/usr/bin/node /repo/scripts/aios.mjs loop daily"],
    workingDirectory: "/repo",
    startCalendarInterval: { Hour: 8, Minute: 0 },
    stdoutPath: "/repo/.aios/loop/logs/daily.log",
    stderrPath: "/repo/.aios/loop/logs/daily.log",
  });
  assert.doesNotMatch(xml, /<key>EnvironmentVariables<\/key>/);
});

test("buildLaunchdPlist: xml-escapes an envPath containing special characters", () => {
  const xml = buildLaunchdPlist({
    label: "com.aios.demo.loop-daily",
    programArguments: ["/bin/sh", "-c", "cmd"],
    workingDirectory: "/repo",
    startCalendarInterval: { Hour: 8, Minute: 0 },
    stdoutPath: "/repo/log",
    stderrPath: "/repo/log",
    envPath: "/a&b/bin:/c<d>/bin",
  });
  assert.match(xml, /<string>\/a&amp;b\/bin:\/c&lt;d&gt;\/bin<\/string>/);
});

// StartInterval is kept as a still-valid lower-level rendering primitive in buildLaunchdPlist
// (some caller could conceivably want a pure elapsed-time timer), but no JOB_DEFS entry uses it
// any more — see the "analyze job now uses StartCalendarInterval" test below for why.
test("buildLaunchdPlist: startInterval option still renders plain StartInterval (seconds), not StartCalendarInterval", () => {
  const xml = buildLaunchdPlist({
    label: "com.aios.demo.analyze",
    programArguments: ["/bin/sh", "-c", "aios analyze"],
    workingDirectory: "/repo",
    startInterval: 3600,
    stdoutPath: "/repo/.aios/loop/logs/analyze.log",
    stderrPath: "/repo/.aios/loop/logs/analyze.log",
  });
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  assert.doesNotMatch(xml, /StartCalendarInterval/);
});

// StartInterval's elapsed-time timer has been observed (in production) to silently stop
// advancing across repeated sleep/DarkWake cycles on macOS — the analyze job went stale for
// ~63 hours this way, while the StartCalendarInterval-based daily/weekly jobs kept firing
// normally in the same window. Moving analyze to StartCalendarInterval (fire every hour, at :00)
// gets it the same wake-catch-up guarantee daily/weekly already have.
test("buildLaunchdPlist: hourly job (Minute: 0) renders StartCalendarInterval, not StartInterval", () => {
  const xml = buildLaunchdPlist({
    label: "com.aios.demo.analyze",
    programArguments: ["/bin/sh", "-c", "aios analyze"],
    workingDirectory: "/repo",
    startCalendarInterval: { Minute: 0 },
    stdoutPath: "/repo/.aios/loop/logs/analyze.log",
    stderrPath: "/repo/.aios/loop/logs/analyze.log",
  });
  assert.match(xml, /<key>StartCalendarInterval<\/key>/);
  assert.match(xml, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.doesNotMatch(xml, /<key>StartInterval<\/key>/);
});

test("buildInstallPlan + renderLaunchdPlan: the analyze job renders StartCalendarInterval (Minute: 0)", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "darwin", home });
    const analyzeJob = plan.jobs.find((j) => j.key === "analyze");
    assert.equal(analyzeJob.startInterval, null);
    assert.deepEqual(analyzeJob.calendar, { Minute: 0 });
    const rendered = renderLaunchdPlan(plan).find((r) => r.label === analyzeJob.label);
    assert.match(rendered.content, /<key>StartCalendarInterval<\/key>/);
    assert.match(rendered.content, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
    assert.doesNotMatch(rendered.content, /<key>StartInterval<\/key>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("renderLaunchdPlan: one rendered plist per job, all wrapped in valid-looking plist XML", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "darwin", home });
    const rendered = renderLaunchdPlan(plan);
    assert.equal(rendered.length, 3);
    for (const r of rendered) {
      assert.match(r.content, /<!DOCTYPE plist/);
      assert.match(r.content, /<key>Label<\/key>/);
      assert.equal(r.path, path.join(home, "Library", "LaunchAgents", `${r.label}.plist`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── launchd install/uninstall (idempotent; stubbed launchctl) ───────────────────────────────

test("applyLaunchdInstall: writes exactly 3 plists, idempotent across two installs", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "darwin", home });
    const execCalls = [];
    const stubExec = (cmd, args) => {
      execCalls.push([cmd, args]);
      return "";
    };
    const first = applyLaunchdInstall(plan, { exec: stubExec, load: true });
    assert.equal(first.length, 3);
    for (const f of first) assert.ok(existsSync(f.path));

    const lagDir = path.join(home, "Library", "LaunchAgents");
    const filesAfterFirst = existsSync(lagDir) ? readdirSync(lagDir) : [];
    const second = applyLaunchdInstall(plan, { exec: stubExec, load: true });
    assert.equal(second.length, 3);
    // Same 3 labeled plists, not 6 — overwritten in place, no duplication.
    assert.deepEqual(second.map((r) => r.label).sort(), first.map((r) => r.label).sort());
    assert.equal(filesAfterFirst.length, 3);
    // launchctl was invoked (bootout + bootstrap) for each of the 3 jobs, both runs.
    assert.ok(execCalls.some(([cmd, args]) => cmd === "launchctl" && args[0] === "bootout"));
    assert.ok(execCalls.some(([cmd, args]) => cmd === "launchctl" && args[0] === "bootstrap"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("applyLaunchdInstall: reports a job that neither launchctl path could load", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "darwin", home });
    const results = applyLaunchdInstall(plan, {
      exec: () => {
        throw new Error("launchctl unavailable");
      },
    });
    assert.equal(results.length, 3);
    assert.ok(results.every((result) => result.loaded === false));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("applyLaunchdUninstall: removes the plist files this plan installed", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "darwin", home });
    const stubExec = () => "";
    applyLaunchdInstall(plan, { exec: stubExec, load: false });
    for (const j of plan.jobs) assert.ok(existsSync(j.plistPath));
    applyLaunchdUninstall(plan, { exec: stubExec });
    for (const j of plan.jobs) assert.ok(!existsSync(j.plistPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── cron block generation + idempotent merge ─────────────────────────────────────────────────

test("buildCronBlock: one line per job, marker-delimited", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "linux", home });
    const block = buildCronBlock(plan);
    const { begin, end } = cronMarkers(plan.slug);
    assert.ok(block.startsWith(begin));
    assert.ok(block.endsWith(end));
    assert.equal(block.split("\n").length, 5); // begin + 3 jobs + end
    assert.match(block, /0 8 \* \* \*/); // daily
    assert.match(block, /15 8 \* \* 1/); // weekly (Monday)
    assert.match(block, /0 \* \* \* \*/); // analyze (hourly)
    const weekly = block.split("\n").find((line) => line.startsWith("15 8 * * 1"));
    assert.match(weekly, /&& \{ .*loop weekly; .*maturity-week; \} >> .* 2>&1$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("mergeCronBlock: appends to an existing crontab, preserving unrelated lines", () => {
  const dir = tmpWorkspace();
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "linux" });
    const block = buildCronBlock(plan);
    const existing = "# some other job\n0 0 * * * /usr/bin/backup.sh\n";
    const merged = mergeCronBlock(existing, block, plan.slug);
    assert.match(merged, /some other job/);
    assert.match(merged, /backup\.sh/);
    const { begin, end } = cronMarkers(plan.slug);
    assert.ok(merged.includes(begin));
    assert.ok(merged.includes(end));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeCronBlock: idempotent — merging twice yields exactly one block, no duplicate jobs", () => {
  const dir = tmpWorkspace();
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "linux" });
    const block = buildCronBlock(plan);
    const once = mergeCronBlock("# unrelated\n", block, plan.slug);
    const twice = mergeCronBlock(once, block, plan.slug);
    const { begin } = cronMarkers(plan.slug);
    const beginCount = twice.split(begin).length - 1;
    assert.equal(beginCount, 1, "exactly one aios-loop-install block after merging twice");
    // Exactly 3 job lines (daily/weekly/analyze), not 6.
    const jobLineCount = twice
      .split("\n")
      .filter((l) => /loop (daily|weekly)|analyze/.test(l)).length;
    assert.equal(jobLineCount, 3);
    assert.match(twice, /unrelated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyCronInstall + applyCronUninstall: idempotent install (stubbed crontab)", () => {
  const dir = tmpWorkspace();
  try {
    const plan = buildInstallPlan({ repo: dir, platform: "linux" });
    let stored = "# pre-existing line\n";
    const stubExec = (cmd, args, opts) => {
      assert.equal(cmd, "crontab");
      if (args[0] === "-l") return stored;
      if (args[0] === "-") {
        stored = opts.input;
        return "";
      }
      throw new Error(`unexpected crontab args: ${args}`);
    };
    applyCronInstall(plan, { exec: stubExec });
    const { begin } = cronMarkers(plan.slug);
    assert.equal(stored.split(begin).length - 1, 1);
    assert.match(stored, /pre-existing line/);

    // Installing again must not duplicate the block.
    applyCronInstall(plan, { exec: stubExec });
    assert.equal(stored.split(begin).length - 1, 1);

    applyCronUninstall(plan, { exec: stubExec });
    assert.equal(stored.split(begin).length - 1, 0);
    assert.match(stored, /pre-existing line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── pinned-runtime health (status surfaces a vanished install-time Node) ────────────────────

test("pinnedRuntimeFromPlist: extracts the pinned Node from the /bin/sh -c command line", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const plan = buildInstallPlan({
      repo: dir,
      platform: "darwin",
      home,
      execPath: "/nvm/node-v22/bin/node",
    });
    for (const r of renderLaunchdPlan(plan)) {
      assert.equal(pinnedRuntimeFromPlist(r.content), "/nvm/node-v22/bin/node");
    }
    assert.equal(pinnedRuntimeFromPlist("<plist></plist>"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("pinnedRuntimesFromCrontab: extracts pinned runtimes only from this slug's block", () => {
  const dir = tmpWorkspace();
  try {
    const plan = buildInstallPlan({
      repo: dir,
      platform: "linux",
      execPath: "/nvm/node-v20/bin/node",
    });
    const merged = mergeCronBlock(
      "0 0 * * * /usr/bin/backup.sh\n",
      buildCronBlock(plan),
      plan.slug
    );
    assert.deepEqual(pinnedRuntimesFromCrontab(merged, plan.slug), ["/nvm/node-v20/bin/node"]);
    assert.deepEqual(pinnedRuntimesFromCrontab(merged, "other-slug"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPinnedRuntimes: launchd — flags a pinned runtime that no longer exists", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const gone = "/nvm/versions/node/v20.0.0/bin/node";
    const plan = buildInstallPlan({ repo: dir, platform: "darwin", home, execPath: gone });
    applyLaunchdInstall(plan, { exec: () => "", load: false });
    assert.deepEqual(checkPinnedRuntimes(plan), [gone]);

    // A runtime that does exist (this test's own Node) reports clean.
    const healthy = buildInstallPlan({
      repo: dir,
      platform: "darwin",
      home,
      execPath: process.execPath,
    });
    applyLaunchdInstall(healthy, { exec: () => "", load: false });
    assert.deepEqual(checkPinnedRuntimes(healthy), []);

    // No plists installed at all → nothing to flag.
    applyLaunchdUninstall(healthy, { exec: () => "" });
    assert.deepEqual(checkPinnedRuntimes(healthy), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("checkPinnedRuntimes: cron — flags a vanished runtime from the crontab block", () => {
  const dir = tmpWorkspace();
  try {
    const gone = "/nvm/versions/node/v18.0.0/bin/node";
    const plan = buildInstallPlan({ repo: dir, platform: "linux", execPath: gone });
    const crontab = mergeCronBlock("", buildCronBlock(plan), plan.slug);
    const stubExec = (cmd, args) => {
      assert.equal(cmd, "crontab");
      assert.deepEqual(args, ["-l"]);
      return crontab;
    };
    assert.deepEqual(checkPinnedRuntimes(plan, { exec: stubExec }), [gone]);

    const healthy = buildInstallPlan({ repo: dir, platform: "linux", execPath: process.execPath });
    const healthyTab = mergeCronBlock("", buildCronBlock(healthy), healthy.slug);
    assert.deepEqual(checkPinnedRuntimes(healthy, { exec: () => healthyTab }), []);

    // No crontab at all (crontab -l fails) → nothing to flag.
    assert.deepEqual(
      checkPinnedRuntimes(plan, {
        exec: () => {
          throw new Error("no crontab for user");
        },
      }),
      []
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --status prints the runtime-missing nudge when the pinned Node is gone", () => {
  const dir = tmpWorkspace();
  const home = mkdtempSync(path.join(tmpdir(), "loop-install-home-"));
  try {
    const gone = "/nvm/versions/node/v19.9.9/bin/node";
    const plan = buildInstallPlan({ repo: dir, platform: "darwin", home, execPath: gone });
    applyLaunchdInstall(plan, { exec: () => "", load: false });
    const res = spawnSync(
      process.execPath,
      [CLI, "loop", "install", "--status", "--scheduler", "launchd"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home } }
    );
    assert.equal(res.status, 0);
    assert.match(res.stdout, /runtime missing/);
    assert.match(res.stdout, /re-run `aios loop install`/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI rejects a missing --scheduler value and unknown options", () => {
  const dir = tmpWorkspace();
  try {
    const missing = spawnSync(process.execPath, [CLI, "loop", "install", "--scheduler"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--scheduler requires launchd\|cron/);

    const unknown = spawnSync(process.execPath, [CLI, "loop", "install", "--surprise"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown loop install option: --surprise/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
