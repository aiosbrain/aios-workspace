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
// The stamp also lists every emitted file, so a partially deleted dist/terminal reads as
// stale (and self-heals) rather than fresh.
//
// Contract: nothing here throws. A failed build records its fingerprint so an in-progress
// edit with type errors is not recompiled on every invocation; the next source change
// retries. Concurrent CLI invocations serialise on dist/.terminal-build.lock, which holds
// the owner's pid and host: a lock whose owner is dead (Ctrl-C, crash, OOM kill) is
// reclaimed at once, and the mtime rule only covers owners on another host. SIGINT,
// SIGTERM and SIGHUP during a build remove the lock before the signal is re-raised.
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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
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
// A lock with no readable owner is only trusted for this long: its creator died between
// creating the file and writing its pid into it.
const OWNERLESS_LOCK_GRACE_MS = 2_000;

/** Code-unit order: stable across locales, unlike localeCompare. */
const byCodeUnit = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

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
      byCodeUnit(a.name, b.name)
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

/** Every file under dist/terminal, relative and slash-separated, excluding the stamp. */
function listOutputs(root) {
  const base = path.join(root, "dist", "terminal");
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(path.relative(base, p).split(path.sep).join("/"));
    }
  };
  walk(base);
  return out.filter((f) => f !== path.basename(STAMP_FILE)).sort(byCodeUnit);
}

/**
 * Classify dist/terminal for `root`:
 *   installed   — no src/terminal (published package): never build, never hash
 *   no-compiler — checkout without devDependencies: cannot build
 *   missing | stale | fresh   (stale includes a build with emitted files deleted)
 */
export function terminalBuildState(root = PACKAGE_ROOT) {
  try {
    if (!existsSync(path.join(root, "src", "terminal"))) return { state: "installed" };
    const built = ENTRIES.every((f) => existsSync(path.join(root, f)));
    if (!existsSync(path.join(root, "node_modules", "typescript", "package.json")))
      return { state: "no-compiler", built };
    const fingerprint = terminalFingerprint(root);
    if (!built) return { state: "missing", built, fingerprint };
    const [stamped, ...outputs] = (read(path.join(root, STAMP_FILE))?.toString("utf8") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const complete = outputs.every((f) => existsSync(path.join(root, "dist", "terminal", f)));
    const fresh = stamped === fingerprint && outputs.length > 0 && complete;
    return { state: fresh ? "fresh" : "stale", built, fingerprint };
  } catch (error) {
    return { state: "unknown", built: false, error };
  }
}

/** Written by build-terminal.mjs after a successful compile: fingerprint, then outputs. */
export function writeTerminalStamp(root, fingerprint) {
  const body = [fingerprint, ...listOutputs(root)].join("\n");
  writeFileSync(path.join(root, STAMP_FILE), `${body}\n`);
  rmSync(path.join(root, FAILED_FILE), { force: true });
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** True when the lock's owner can no longer release it. */
function lockIsStale(lockPath, timeoutMs) {
  let age;
  try {
    age = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return false; // already gone: the next open attempt wins it
  }
  if (age > timeoutMs) return true;
  const [pidText, host] = (read(lockPath)?.toString("utf8") ?? "").trim().split(/\s+/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return age > OWNERLESS_LOCK_GRACE_MS;
  if (host && host !== os.hostname()) return false; // cannot probe a remote pid: mtime rule
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

/** One exclusive-create attempt: "acquired", "held", or an error reason. */
function tryCreateLock(lockPath) {
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeSync(fd, `${process.pid} ${os.hostname()}\n`);
    } finally {
      closeSync(fd);
    }
    return "acquired";
  } catch (error) {
    return error?.code === "EEXIST" ? "held" : `lock-${error?.code ?? "error"}`;
  }
}

/** Returns { ok: true } or { ok: false, reason }. Waits at most `waitMs`. */
function acquireLock(lockPath, { timeoutMs, waitMs, onWait }) {
  const started = Date.now();
  let announced = false;
  for (;;) {
    const attempt = tryCreateLock(lockPath);
    if (attempt === "acquired") return { ok: true };
    if (attempt !== "held") return { ok: false, reason: attempt };
    if (lockIsStale(lockPath, timeoutMs)) {
      rmSync(lockPath, { force: true });
      continue;
    }
    const waited = Date.now() - started;
    if (waited >= waitMs) return { ok: false, reason: "lock-busy" };
    if (!announced && waited >= 1_000) {
      announced = true;
      try {
        onWait?.();
      } catch {
        /* notice only */
      }
    }
    sleep(Math.min(100, waitMs - waited));
  }
}

const SIGNALS = process.platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Run `fn` with the lock released on interruption. While a listener is installed, Node
 * defers the signal until spawnSync returns, so `finally` removes the lock; the signal is
 * then re-raised with the default disposition so Ctrl-C still ends the command.
 */
function withLock(lockPath, fn) {
  const release = () => rmSync(lockPath, { force: true });
  const detach = () => SIGNALS.forEach((sig) => process.off(sig, onSignal));
  function onSignal(sig) {
    release();
    detach();
    process.kill(process.pid, sig);
  }
  SIGNALS.forEach((sig) => process.on(sig, onSignal));
  let interrupted;
  try {
    const result = fn();
    interrupted = result?.interruptedBy;
    return result;
  } finally {
    release();
    if (interrupted) {
      detach();
      process.kill(process.pid, interrupted);
    } else {
      // A signal aimed only at this process is delivered on the next turn of the loop.
      setTimeout(detach, 50).unref();
    }
  }
}

/**
 * Build dist/terminal when missing or stale. Synchronous, never throws.
 * Returns { state, built, ok, reason? } where `state` is the state found before building.
 * Options:
 *   onBuild(state)  called just before a compile starts (for a one-line notice)
 *   onWait()        called once if another build holds the lock for over a second
 *   waitWhenBuiltMs cap on waiting for another build when an older build exists and can
 *                   be used meanwhile (the presenter passes a short cap)
 */
export function ensureTerminalBuilt(
  root = PACKAGE_ROOT,
  { onBuild, onWait, timeoutMs = BUILD_TIMEOUT_MS, waitWhenBuiltMs = timeoutMs } = {}
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
  } catch (error) {
    return { ...initial, ok: false, reason: `dist-${error?.code ?? "unwritable"}` };
  }
  const waitMs = initial.built ? Math.min(waitWhenBuiltMs, timeoutMs) : timeoutMs;
  const lock = acquireLock(lockPath, { timeoutMs, waitMs, onWait });
  if (!lock.ok) {
    // Another command may have finished while we gave up waiting.
    const now = terminalBuildState(root);
    if (now.state === "fresh")
      return { ...initial, built: true, ok: true, reason: "built-elsewhere" };
    return { ...initial, ok: false, reason: lock.reason };
  }
  try {
    return withLock(lockPath, () => build(root, initial, { onBuild, timeoutMs, failedPath }));
  } catch (error) {
    return { ...initial, ok: false, reason: "build-error", error };
  }
}

function failureReason({ interruptedBy, timedOut }) {
  if (interruptedBy) return "build-interrupted";
  return timedOut ? "build-timeout" : "build-failed";
}

function build(root, initial, { onBuild, timeoutMs, failedPath }) {
  // Another invocation may have finished the build while we waited for the lock.
  const now = terminalBuildState(root);
  if (now.state === "fresh")
    return { ...initial, built: true, ok: true, reason: "built-elsewhere" };
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
  const timedOut = result.error?.code === "ETIMEDOUT";
  // The compiler died from a terminal signal (Ctrl-C reaches the whole process group):
  // not a source failure, so do not latch it; let withLock re-raise the signal.
  const interruptedBy = !timedOut && SIGNALS.includes(result.signal) ? result.signal : undefined;
  if (!interruptedBy)
    try {
      writeFileSync(failedPath, `${now.fingerprint}\n`);
    } catch {
      /* best effort */
    }
  return {
    ...initial,
    built: ENTRIES.every((f) => existsSync(path.join(root, f))),
    ok: false,
    reason: failureReason({ interruptedBy, timedOut }),
    interruptedBy,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function isMain() {
  try {
    // argv[1] may reach this file through a symlink (~/Tessera → ~/Projects); the main
    // module's URL is already realpath'd, so compare realpaths.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (process.argv[1] && isMain()) {
  // postinstall / worktree-hydration entry point: best-effort, always exits 0.
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet");
  const root = args.find((a) => !a.startsWith("--")) || PACKAGE_ROOT;
  const note = (msg) => quiet || console.log(`\x1b[2m${msg}\x1b[0m`);
  const result = ensureTerminalBuilt(root, {
    onBuild: (state) => note(`terminal UI: ${state} — running build:terminal…`),
    onWait: () => note("terminal UI: waiting for another build:terminal…"),
  });
  if (result.state === "installed") process.exit(0);
  if (result.state === "fresh")
    note("terminal UI: dist/terminal is up to date — nothing to build.");
  else if (result.state === "no-compiler")
    note(
      "terminal UI: typescript not installed (devDependencies) — skipping automatic build.\n" +
        "  Install devDependencies (npm install), then run: npm run build:terminal"
    );
  else if (result.ok && result.reason === "built-elsewhere")
    note("terminal UI: another process finished the build.");
  else if (result.ok) note("terminal UI: build:terminal succeeded.");
  else
    console.log(
      `\x1b[1;33mterminal UI: automatic build skipped (${result.reason}) — run: npm run build:terminal\x1b[0m`
    );
  process.exit(0);
}
