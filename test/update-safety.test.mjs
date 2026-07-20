import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

// Safety guarantees for `aios update`, each exercised through a spawned CLI/module because
// they end in process.exit: (1) re-exec the freshly-pulled code before vendoring, (2) resolve
// only a workspace/toolkit root — never a bare README dir, (3) abort on a conflicted autostash,
// (4) never vendor from a conflicted toolkit, (5) --check never greens while behind.

const CLI = fileURLToPath(new URL("../scripts/aios.mjs", import.meta.url));
const PULL_MODULE = pathToFileURL(
  fileURLToPath(new URL("../scripts/toolkit-pull.mjs", import.meta.url))
).href;
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

function initRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
}

// ---- #2 root resolution -----------------------------------------------------

test("update refuses a bare README directory (never re-vendors into an unrelated repo)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-readme-"));
  try {
    writeFileSync(path.join(dir, "README.md"), "not a workspace\n");
    const res = spawnSync(process.execPath, [CLI, "update", "--check", "--no-pull"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0, "should refuse to run");
    assert.match(res.stderr, /must run in a workspace .* or the toolkit checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update run from a toolkit subdir (gui/) resolves UP to the toolkit, not the subdir", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-"));
  try {
    mkdirSync(path.join(tk, "scaffold"), { recursive: true });
    mkdirSync(path.join(tk, "scripts"), { recursive: true });
    mkdirSync(path.join(tk, "gui"), { recursive: true });
    writeFileSync(path.join(tk, "scripts", "aios.mjs"), "// entry\n");
    // From gui/: no markers there, so it walks up to the toolkit root and self-updates
    // (never treats gui/ as a workspace to re-vendor into).
    const res = spawnSync(process.execPath, [CLI, "update", "--check", "--no-pull"], {
      cwd: path.join(tk, "gui"),
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /toolkit checkout/, "resolved UP to the toolkit root");
  } finally {
    rmSync(tk, { recursive: true, force: true });
  }
});

test("update refuses an explicit --repo that is neither a workspace nor the toolkit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-badrepo-"));
  try {
    // An arbitrary empty directory passed via --repo must NOT be accepted as an update target.
    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--check", "--no-pull", "--repo", dir],
      {
        encoding: "utf8",
      }
    );
    assert.notEqual(res.status, 0, "explicit --repo must be validated too");
    assert.match(res.stderr, /must run in a workspace .* or the toolkit checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- #1 re-exec the pulled code before vendoring ----------------------------

test("update re-execs the freshly-pulled CLI (vendor runs pulled code, not stale in-memory)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-reexec-"));
  try {
    const origin = path.join(root, "origin");
    const clone = path.join(root, "toolkit");
    const workspace = path.join(root, "workspace");
    const marker = path.join(root, "MARKER");
    mkdirSync(origin, { recursive: true });
    initRepo(origin);
    // A toolkit-shaped source whose scripts/aios.mjs is a STUB that just proves it ran.
    mkdirSync(path.join(origin, "scaffold"), { recursive: true });
    mkdirSync(path.join(origin, "scripts"), { recursive: true });
    writeFileSync(path.join(origin, "scaffold", ".keep"), ""); // git won't track an empty dir
    writeFileSync(
      path.join(origin, "scripts", "aios.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.MARKER, "vendored by the pulled stub\\n");\n`
    );
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "init");
    execFileSync("git", ["clone", "-q", origin, clone]);
    git(clone, "config", "user.email", "t@t.t");
    git(clone, "config", "user.name", "t");
    // Advance origin so the clone is 1 behind → the pull moves HEAD → re-exec must fire.
    writeFileSync(path.join(origin, "note.txt"), "advance\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "advance");
    // Minimal workspace target.
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const res = spawnSync(process.execPath, [CLI, "update", "--from", clone, "--repo", workspace], {
      env: { ...process.env, MARKER: marker },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(marker), "the pulled stub CLI ran the vendor phase (re-exec happened)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- #3 abort on a conflicted autostash -------------------------------------

test("pullToolkitCheckout --stash aborts when the stash cannot be restored cleanly", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-stashconflict-"));
  try {
    const origin = path.join(root, "origin");
    const clone = path.join(root, "clone");
    mkdirSync(origin, { recursive: true });
    initRepo(origin);
    writeFileSync(path.join(origin, "f.txt"), "base\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "init");
    execFileSync("git", ["clone", "-q", origin, clone]);
    git(clone, "config", "user.email", "t@t.t");
    git(clone, "config", "user.name", "t");
    // Upstream changes f.txt; the clone has a conflicting uncommitted edit to the same line.
    writeFileSync(path.join(origin, "f.txt"), "upstream change\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "upstream");
    writeFileSync(path.join(clone, "f.txt"), "local change\n");

    const code =
      `import { pullToolkitCheckout } from ${JSON.stringify(PULL_MODULE)};\n` +
      `pullToolkitCheckout(${JSON.stringify(clone)}, { stash: true }, {});\n`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0, "should abort, not report success");
    assert.match(res.stderr, /hit a conflict/);
    // The stash is preserved for the user to recover.
    assert.match(git(clone, "stash", "list"), /aios update autostash/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- #4 never vendor from a conflicted toolkit ------------------------------

/** A toolkit clone left with an UNMERGED index — exactly what a conflicted `stash pop` leaves. */
function makeConflictedToolkit(root) {
  const origin = path.join(root, "origin");
  const clone = path.join(root, "toolkit");
  mkdirSync(origin, { recursive: true });
  initRepo(origin);
  mkdirSync(path.join(origin, "scaffold"), { recursive: true });
  mkdirSync(path.join(origin, "scripts"), { recursive: true });
  writeFileSync(path.join(origin, "scaffold", ".keep"), "");
  writeFileSync(path.join(origin, "scripts", "aios.mjs"), "// entry\n");
  writeFileSync(path.join(origin, "f.txt"), "base\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "init");
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, "config", "user.email", "t@t.t");
  git(clone, "config", "user.name", "t");
  writeFileSync(path.join(origin, "f.txt"), "upstream\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "upstream");
  // Reproduce the real sequence: stash a conflicting local edit, fast-forward, pop → conflict.
  writeFileSync(path.join(clone, "f.txt"), "local\n");
  git(clone, "stash", "push", "--include-untracked", "-m", "aios update autostash");
  git(clone, "fetch", "--quiet");
  git(clone, "merge", "--ff-only", "@{u}");
  try {
    git(clone, "stash", "pop");
  } catch {
    /* expected: conflict leaves the index unmerged */
  }
  assert.ok(
    git(clone, "diff", "--name-only", "--diff-filter=U").includes("f.txt"),
    "fixture really is left unmerged"
  );
  return clone;
}

test("update --no-pull refuses to vendor from a toolkit left conflicted by a failed stash restore", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-conflicted-"));
  try {
    const clone = makeConflictedToolkit(root);
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    // --no-pull skips the git half entirely — the vendor guard must still catch this.
    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--no-pull", "--from", clone, "--repo", workspace],
      { encoding: "utf8" }
    );
    assert.notEqual(res.status, 0, "must refuse, not vendor conflict markers");
    assert.match(res.stderr, /unresolved conflict/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- #5 --check verdict folds in the git behind-count ------------------------

test("update --check never reports green 'up to date' while the toolkit is behind its remote", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-checkverdict-"));
  try {
    const origin = path.join(root, "origin");
    const clone = path.join(root, "toolkit");
    const workspace = path.join(root, "workspace");
    mkdirSync(origin, { recursive: true });
    initRepo(origin);
    mkdirSync(path.join(origin, "scaffold"), { recursive: true });
    mkdirSync(path.join(origin, "scripts"), { recursive: true });
    writeFileSync(path.join(origin, "scaffold", ".keep"), "");
    writeFileSync(path.join(origin, "scripts", "aios.mjs"), "// entry\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "init");
    execFileSync("git", ["clone", "-q", origin, clone]);
    // Advance origin → the local toolkit is 1 behind (check mode never fast-forwards it).
    writeFileSync(path.join(origin, "note.txt"), "advance\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "advance");
    // Workspace is stamped at the toolkit's CURRENT local sha → the vendor side "matches".
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    writeFileSync(
      path.join(workspace, ".aios-toolkit-version"),
      `${git(clone, "rev-parse", "HEAD")}\ntoolkit-version 0.7.0\n`
    );

    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--check", "--from", clone, "--repo", workspace],
      { encoding: "utf8" }
    );
    assert.equal(res.status, 0, res.stderr);
    // Read-only check no longer fetches (ls-remote only), so the remote object may be absent
    // and the exact count unavailable — but it must still detect the divergence, never green.
    assert.match(res.stdout, /behind|differs/, "git half reports behind/differs");
    assert.doesNotMatch(res.stdout, /up to date/, "must NOT green-light while behind");
    assert.match(res.stdout, /Run `aios update`/, "tells the user to act");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- #6 --preview is safe as a library call (onboarding calls it mid-flow) ---

const UPDATE_MODULE = pathToFileURL(
  fileURLToPath(new URL("../scripts/update.mjs", import.meta.url))
).href;

/** Toolkit origin+clone where the clone is 1 behind and the pulled CLI is a marker stub. */
function makeBehindToolkit(root) {
  const origin = path.join(root, "origin");
  const clone = path.join(root, "toolkit");
  mkdirSync(origin, { recursive: true });
  initRepo(origin);
  mkdirSync(path.join(origin, "scaffold"), { recursive: true });
  mkdirSync(path.join(origin, "scripts"), { recursive: true });
  writeFileSync(path.join(origin, "scaffold", ".keep"), "");
  writeFileSync(
    path.join(origin, "scripts", "aios.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.MARKER, "re-exec happened\\n");\n`
  );
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "init");
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, "config", "user.email", "t@t.t");
  git(clone, "config", "user.name", "t");
  writeFileSync(path.join(origin, "note.txt"), "advance\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "advance");
  return { origin, clone };
}

test("cmdUpdate --preview never pulls, never re-execs, never exits (onboarding-safe)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-preview-"));
  try {
    const { clone } = makeBehindToolkit(root);
    const workspace = path.join(root, "workspace");
    const marker = path.join(root, "MARKER");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    // Stamp at the toolkit's current HEAD so the vendor half has a valid merge base.
    const headBefore = git(clone, "rev-parse", "HEAD");
    writeFileSync(
      path.join(workspace, ".aios-toolkit-version"),
      `${headBefore}\ntoolkit-version 0.7.0\n`
    );

    // Call cmdUpdate as a LIBRARY (exactly how onboard-command.mjs does) — code after the
    // call must still run: preview must not process.exit(), and must return a 0 status.
    const code =
      `import { cmdUpdate } from ${JSON.stringify(UPDATE_MODULE)};\n` +
      `const status = await cmdUpdate(${JSON.stringify(workspace)}, {}, ` +
      `["--preview", "--from", ${JSON.stringify(clone)}]);\n` +
      `console.log("SURVIVED status=" + status);\n`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, MARKER: marker },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /SURVIVED status=0/, "caller survived and got a success status");
    assert.equal(git(clone, "rev-parse", "HEAD"), headBefore, "preview must NOT pull the toolkit");
    assert.ok(!existsSync(marker), "preview must NOT re-exec the pulled CLI");
    assert.match(res.stdout, /preview only/, "still prints the preview classification");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- #7 unknown flags are refused, never silently dropped --------------------

test("update refuses an unknown flag instead of silently dropping it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-unknownflag-"));
  try {
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    const res = spawnSync(process.execPath, [CLI, "update", "--frobnicate", "--repo", workspace], {
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0, "unknown flag must be an error");
    assert.match(res.stderr, /unknown flag --frobnicate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- #8 the re-exec child's exit status propagates through the CLI -----------

test("interactive CLI still self-updates and propagates the re-exec child's failure status", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-reexec-status-"));
  try {
    const { clone } = makeBehindToolkit(root);
    // Make the PULLED stub CLI fail with a distinctive status: cmdUpdate now RETURNS it
    // (instead of process.exit) and the dispatcher must map it onto the CLI's exit code.
    const workspace = path.join(root, "workspace");
    const marker = path.join(root, "MARKER");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    const origin = path.join(root, "origin");
    writeFileSync(
      path.join(origin, "scripts", "aios.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.MARKER, "ran\\n");\nprocess.exit(7);\n`
    );
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "failing stub");

    const res = spawnSync(process.execPath, [CLI, "update", "--from", clone, "--repo", workspace], {
      env: { ...process.env, MARKER: marker },
      encoding: "utf8",
    });
    assert.ok(existsSync(marker), "the pulled stub CLI ran (self-update re-exec happened)");
    assert.equal(res.status, 7, "child's exit status surfaces as the CLI exit status");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- #9 the unconditional hand-off can't loop (base case: same source, twice in a row) -----

test("update against an already-current same source runs twice in a row without hanging or looping", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-norecurse-"));
  try {
    // A REAL toolkit checkout (this repo itself), not a stub — exercises the actual recursive
    // spawn (parent sets AIOS_UPDATE_VENDOR_CHILD, the child inherits it and must not spawn
    // again) rather than a synthetic aios.mjs that just writes a marker and exits.
    const toolkitRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    // First run: nothing synced yet, so this vendors for real. Bounded timeout — a
    // reintroduced infinite-recursion bug must fail loudly and fast, never hang CI.
    const first = spawnSync(
      process.execPath,
      [CLI, "update", "--no-install", "--from", toolkitRoot, "--repo", workspace],
      { encoding: "utf8", timeout: 30_000 }
    );
    assert.notEqual(first.signal, "SIGTERM", "first run must not time out (no infinite loop)");
    assert.equal(first.status, 0, first.stderr);

    // Second run: workspace is now current — the exact "already-current, same source" case
    // that used to run in-process. Under the unconditional design it still spawns a child,
    // but that child must recognize itself as the vendor child and NOT spawn a grandchild.
    const second = spawnSync(
      process.execPath,
      [CLI, "update", "--no-install", "--from", toolkitRoot, "--repo", workspace],
      { encoding: "utf8", timeout: 30_000 }
    );
    assert.notEqual(second.signal, "SIGTERM", "second run must not time out (no infinite loop)");
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already up to date|synced to/, "completed normally, not stuck");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
