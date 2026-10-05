#!/usr/bin/env node
// ensure-terminal-built.mjs — keep dist/terminal (the compiled Ink presentation, built
// from src/terminal by scripts/build-terminal.mjs) current in SOURCE CHECKOUTS without a
// manual step. Sibling of ensure-loop-built.mjs, with the same three call sites:
//   1. `npm install` (package.json postinstall)
//   2. worktree hydration (scripts/link-worktree-env.sh)
//   3. the lazy self-heal in scripts/ui/presenter.mjs createPresenter(), reached only
//      after canPresent() has accepted a human TTY context — JSON, porcelain, plain,
//      piped and CI paths never get here and pay nothing.
//
// Staleness is a content fingerprint, not mtimes: npm extracts dependencies with a fixed
// 1985 mtime, and branch switches rewrite mtimes without changing content. The fingerprint
// covers every file under src/terminal (including vendor notices), the tsconfig pair, the
// build script, package.json's module type, and the installed versions of the packages
// the sources compile against.
// build-terminal.mjs writes it to dist/terminal/.build-inputs.sha256 after a successful
// compile; a mismatch means stale.
//
// Installed-package layout (npm i -g @aiosbrain/aios): src/ is not in package.json
// `files`, so the first existsSync() short-circuits — one stat, no hashing, no TypeScript.
//
// Contract: nothing here throws. A failed build records its fingerprint so an in-progress
// edit with type errors is not recompiled on every invocation; the next source change
// retries. Concurrent CLI invocations serialise on dist/.terminal-build.lock.
//
// Usage: node scripts/ensure-terminal-built.mjs [repoRoot] [--quiet]

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STAMP_FILE = path.join("dist", "terminal", ".build-inputs.sha256");
const FAILED_FILE = path.join("dist", ".terminal-build-failed.sha256");
const LOCK_FILE = path.join("dist", ".terminal-build.lock");
const ENTRIES = ["report.js", "session.js"].map((f) => path.join("dist", "terminal", f));
const CONFIG_INPUTS = ["tsconfig.terminal.json", "tsconfig.json", "scripts/build-terminal.mjs"];
const DEP_INPUTS = [
  "typescript",
  "ink",
  "react",
  "@types/react",
  "@types/node",
  "string-width",
  "cli-spinners",
];
const BUILD_TIMEOUT_MS = 120_000;

const read = (file) => {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
};

/** Content fingerprint of every input that can change dist/terminal. */
export function terminalFingerprint(root = PACKAGE_ROOT) {
  const hash = createHash("sha256");
  const add = (label, data) => {
    hash.update(`${label}\0${data === null ? "<absent>" : data.length}\0`);
    if (data !== null) hash.update(data);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) add(path.relative(root, p).split(path.sep).join("/"), read(p));
    }
  };
  walk(path.join(root, "src", "terminal"));
  for (const file of CONFIG_INPUTS) add(file, read(path.join(root, file)));
  // Only package.json's module type changes compiler output (ESM vs CommonJS); its version
  // and scripts churn on every release and must not force a rebuild.
  let moduleType = null;
  try {
    moduleType = Buffer.from(
      String(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).type)
    );
  } catch {
    /* absent manifest is part of the fingerprint */
  }
  add("package.json#type", moduleType);
  for (const dep of DEP_INPUTS) {
    let version = null;
    try {
      const manifest = path.join(root, "node_modules", dep, "package.json");
      version = Buffer.from(String(JSON.parse(readFileSync(manifest, "utf8")).version));
    } catch {
      /* absent dependency is itself part of the fingerprint */
    }
    add(`dep:${dep}`, version);
  }
  return hash.digest("hex");
}

/**
 * Classify dist/terminal for `root`:
 *   installed   — no src/terminal (published package): never build, never hash
 *   no-compiler — checkout without devDependencies: cannot build
 *   missing | stale | fresh
 */
export function terminalBuildState(root = PACKAGE_ROOT) {
  try {
    if (!existsSync(path.join(root, "src", "terminal"))) return { state: "installed" };
    const built = ENTRIES.every((f) => existsSync(path.join(root, f)));
    if (!existsSync(path.join(root, "node_modules", "typescript", "package.json")))
      return { state: "no-compiler", built };
    const fingerprint = terminalFingerprint(root);
    if (!built) return { state: "missing", built, fingerprint };
    const stamp = read(path.join(root, STAMP_FILE));
    const fresh = stamp !== null && stamp.toString("utf8").trim() === fingerprint;
    return { state: fresh ? "fresh" : "stale", built, fingerprint };
  } catch (error) {
    return { state: "unknown", built: false, error };
  }
}

/** Written by build-terminal.mjs after a successful compile. */
export function writeTerminalStamp(root, fingerprint) {
  writeFileSync(path.join(root, STAMP_FILE), `${fingerprint}\n`);
  rmSync(path.join(root, FAILED_FILE), { force: true });
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function acquireLock(lockPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") return false;
      try {
        // A crashed builder leaves its lock behind; anything older than a full build is dead.
        if (Date.now() - statSync(lockPath).mtimeMs > timeoutMs) rmSync(lockPath, { force: true });
      } catch {
        /* lock vanished between open and stat: retry */
      }
      sleep(100);
    }
  }
  return false;
}

/**
 * Build dist/terminal when missing or stale. Synchronous, never throws.
 * Returns { state, built, ok, reason? } where `state` is the state found before building.
 * `onBuild(state)` is called just before a compile starts (for a one-line notice).
 */
export function ensureTerminalBuilt(
  root = PACKAGE_ROOT,
  { onBuild, timeoutMs = BUILD_TIMEOUT_MS } = {}
) {
  const initial = terminalBuildState(root);
  if (!["missing", "stale"].includes(initial.state))
    return { ...initial, ok: initial.state !== "unknown" && initial.built !== false };
  const failedPath = path.join(root, FAILED_FILE);
  const failedBefore = read(failedPath)?.toString("utf8").trim();
  if (failedBefore === initial.fingerprint)
    return { ...initial, ok: false, reason: "previous-build-failed" };
  const lockPath = path.join(root, LOCK_FILE);
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    return { ...initial, ok: false, reason: "dist-unwritable" };
  }
  if (!acquireLock(lockPath, timeoutMs)) return { ...initial, ok: false, reason: "lock-timeout" };
  try {
    // Another invocation may have finished the build while we waited for the lock.
    const now = terminalBuildState(root);
    if (now.state === "fresh") return { ...initial, built: true, ok: true };
    try {
      onBuild?.(now.state);
    } catch {
      /* notice failure cannot block the build */
    }
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-terminal.mjs")], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    if (result.status === 0) return { ...initial, built: true, ok: true };
    try {
      writeFileSync(failedPath, `${now.fingerprint}\n`);
    } catch {
      /* best effort */
    }
    return {
      ...initial,
      built: ENTRIES.every((f) => existsSync(path.join(root, f))),
      ok: false,
      reason: result.error?.code === "ETIMEDOUT" ? "build-timeout" : "build-failed",
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  } catch (error) {
    return { ...initial, ok: false, reason: "build-error", error };
  } finally {
    rmSync(lockPath, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // postinstall / worktree-hydration entry point: best-effort, always exits 0.
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet");
  const root = args.find((a) => !a.startsWith("--")) || PACKAGE_ROOT;
  const note = (msg) => quiet || console.log(`\x1b[2m${msg}\x1b[0m`);
  const result = ensureTerminalBuilt(root, {
    onBuild: (state) => note(`terminal UI: ${state} — running build:terminal…`),
  });
  if (result.state === "installed") process.exit(0);
  if (result.state === "fresh")
    note("terminal UI: dist/terminal is up to date — nothing to build.");
  else if (result.state === "no-compiler")
    note("terminal UI: typescript not installed (devDependencies) — skipping automatic build.");
  else if (result.ok) note("terminal UI: build:terminal succeeded.");
  else
    console.log(
      `\x1b[1;33mterminal UI: automatic build skipped (${result.reason}) — run: npm run build:terminal\x1b[0m`
    );
  process.exit(0);
}
