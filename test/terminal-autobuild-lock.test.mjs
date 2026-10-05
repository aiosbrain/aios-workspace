// The dist/terminal build lock, signal handling and staged publication
// (scripts/ensure-terminal-built.mjs, scripts/build-terminal.mjs): an interrupted or
// crashed build never stalls the next command, a termination signal is never swallowed,
// and concurrent commands share one compile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  ensureTerminalBuilt,
  reclaimLock,
  staleLock,
  terminalBuildState,
} from "../scripts/ensure-terminal-built.mjs";
import { createPresenter } from "../scripts/ui.mjs";
import {
  checkout,
  cli,
  lockPath,
  posix,
  root,
  tmp,
  tty,
  waitFor,
} from "./helpers/terminal-checkout.mjs";

// ── the build lock (review F1/F8) ──────────────────────────────────────────
const SLOW_BUILD = "await new Promise((resolve) => setTimeout(resolve, 30000));\n";
/** Start the CLI entry in its own process group with a build that hangs until killed. */
async function startHungBuild() {
  const dir = checkout();
  writeFileSync(path.join(dir, "scripts", "build-terminal.mjs"), SLOW_BUILD);
  const child = spawn(process.execPath, cli(dir, ["--quiet"]), { detached: true, stdio: "ignore" });
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal }))
  );
  await waitFor(() => existsSync(lockPath(dir)));
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the build spawn
  const restore = () =>
    cpSync(
      path.join(root, "scripts", "build-terminal.mjs"),
      path.join(dir, "scripts", "build-terminal.mjs")
    );
  return { dir, child, exited, restore };
}

test(
  "Ctrl-C mid-build releases the lock, and an immediate rerun builds without stalling",
  { skip: !posix },
  async () => {
    const { dir, child, exited, restore } = await startHungBuild();
    process.kill(-child.pid, "SIGINT"); // what a terminal Ctrl-C delivers: the whole group
    const { signal } = await exited;
    assert.equal(signal, "SIGINT", "Ctrl-C still ends the command");
    assert.equal(existsSync(lockPath(dir)), false, "the interrupted build released its lock");
    assert.notEqual(terminalBuildState(dir).state, "fresh");
    restore();
    const started = Date.now();
    assert.equal(ensureTerminalBuilt(dir).ok, true);
    assert.ok(Date.now() - started < 15000, `rerun took ${Date.now() - started} ms`);
    assert.equal(terminalBuildState(dir).state, "fresh");
  }
);

test(
  "a crashed builder's lock (dead owner pid) is reclaimed at once, not after the timeout",
  { skip: !posix },
  async () => {
    const { dir, child, exited, restore } = await startHungBuild();
    process.kill(-child.pid, "SIGKILL"); // uncatchable: the lock is left behind
    await exited;
    assert.ok(existsSync(lockPath(dir)), "SIGKILL leaves the lock");
    assert.ok(Date.now() - statSync(lockPath(dir)).mtimeMs < 60000, "the lock is recent");
    restore();
    const started = Date.now();
    const result = ensureTerminalBuilt(dir, { timeoutMs: 60000 });
    assert.equal(result.ok, true, result.reason);
    assert.ok(Date.now() - started < 15000, `reclaim took ${Date.now() - started} ms`);
    assert.equal(existsSync(lockPath(dir)), false);
  }
);

test("a live builder's lock bounds the presenter's wait when an older build can render", async () => {
  const dir = checkout();
  ensureTerminalBuilt(dir);
  appendFileSync(path.join(dir, "src", "terminal", "theme.tsx"), "\nexport const __later = 1;\n");
  writeFileSync(lockPath(dir), `${process.pid} ${os.hostname()}\n`); // a live owner
  const stderr = tty();
  const started = Date.now();
  const ui = await createPresenter({ stdout: tty(), stderr, env: { TERM: "xterm" }, root: dir });
  const waited = Date.now() - started;
  rmSync(lockPath(dir));
  assert.ok(ui, "the previous build renders");
  assert.ok(waited < 5000, `waited ${waited} ms`);
  assert.match(stderr.chunks.join(""), /waiting for another colour UI build/);
  assert.match(stderr.chunks.join(""), /being rebuilt by another command/);
});

test("concurrent commands on a missing build compile exactly once", async () => {
  const dir = checkout();
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, cli(dir), { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("exit", (code) => resolve({ code, out }));
    });
  const results = await Promise.all([run(), run(), run()]);
  assert.deepEqual(
    results.map((r) => r.code),
    [0, 0, 0]
  );
  const all = stripVTControlCharacters(results.map((r) => r.out).join(""));
  assert.equal(all.match(/running build:terminal/g)?.length, 1, all);
  assert.equal(terminalBuildState(dir).state, "fresh");
  assert.equal(existsSync(lockPath(dir)), false);
});

test(
  "an unwritable dist reports the real error, not a lock timeout",
  {
    skip: !posix || process.getuid?.() === 0,
  },
  () => {
    const dir = checkout();
    mkdirSync(path.join(dir, "dist"));
    spawnSync("chmod", ["555", path.join(dir, "dist")]);
    try {
      const result = ensureTerminalBuilt(dir);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "lock-EACCES");
    } finally {
      spawnSync("chmod", ["755", path.join(dir, "dist")]);
    }
  }
);

test("the CLI entry runs when invoked through a symlinked absolute path", { skip: !posix }, () => {
  const dir = checkout();
  const link = path.join(tmp(), "via-link");
  symlinkSync(dir, link, "dir");
  const r = spawnSync(process.execPath, cli(link), { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /build:terminal succeeded/);
  assert.equal(terminalBuildState(dir).state, "fresh");
});

// ── review round 2 (N1, N3–N5) ─────────────────────────────────────────────
const deadPid = () => {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(r.stdout);
};
/** A build script that takes `ms`, then compiles for real (so the build succeeds). */
function slowRealBuild(dir, ms) {
  const real = readFileSync(path.join(root, "scripts", "build-terminal.mjs"), "utf8");
  writeFileSync(
    path.join(dir, "scripts", "build-terminal.mjs"),
    `await new Promise((resolve) => setTimeout(resolve, ${ms}));\n${real}`
  );
}
const exitOf = (child) =>
  new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(
    `CLI entry: ${signal} sent to the aios pid alone mid-build ends the command, not swallowed`,
    { skip: !posix },
    async () => {
      const dir = checkout();
      slowRealBuild(dir, 1500);
      const child = spawn(process.execPath, cli(dir, ["--quiet"]), { stdio: "ignore" });
      const exited = exitOf(child);
      await waitFor(() => existsSync(lockPath(dir)));
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.kill(child.pid, signal); // the pid only: the compiler is not signalled
      const result = await exited;
      assert.deepEqual(result, { code: null, signal });
      assert.equal(existsSync(lockPath(dir)), false);
    }
  );
}

test(
  "presenter path: a pid-only SIGTERM during the build survives slow imports and poll-phase callers",
  { skip: !posix },
  async () => {
    const dir = checkout();
    slowRealBuild(dir, 1500);
    // Called from a microtask after an fs callback (poll phase), then >50 ms of synchronous
    // work standing in for the Ink import: the two cases that dropped the signal before.
    const script = `
      import { readFile } from "node:fs/promises";
      import { ensureTerminalBuilt } from ${JSON.stringify(path.join(dir, "scripts", "ensure-terminal-built.mjs"))};
      await readFile(${JSON.stringify(path.join(dir, "package.json"))});
      ensureTerminalBuilt(${JSON.stringify(dir)});
      const until = Date.now() + 300;
      while (Date.now() < until);
      await new Promise((resolve) => setTimeout(resolve, 500));
      process.stdout.write("survived");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    const exited = exitOf(child);
    await waitFor(() => existsSync(lockPath(dir)));
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.kill(child.pid, "SIGTERM");
    assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
    assert.equal(out, "", "the command must not carry on after a termination signal");
    assert.equal(terminalBuildState(dir).state, "fresh", "the finished build was kept");
  }
);

test("signal listeners are removed after a normal build", async () => {
  const dir = checkout();
  const before = ["SIGINT", "SIGTERM"].map((sig) => process.listenerCount(sig));
  ensureTerminalBuilt(dir);
  await new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))));
  assert.deepEqual(
    ["SIGINT", "SIGTERM"].map((sig) => process.listenerCount(sig)),
    before
  );
});

test("reclaiming a dead lock never deletes a live lock that replaced it", () => {
  const dir = checkout();
  mkdirSync(path.join(dir, "dist"));
  const lock = lockPath(dir);
  writeFileSync(lock, `${deadPid()} ${os.hostname()}\n`);
  const judged = staleLock(lock, 60000);
  assert.ok(judged, "a dead owner is stale");
  // Another waiter reclaims first and takes the lock before we act on our judgement.
  rmSync(lock);
  writeFileSync(lock, `${process.pid} ${os.hostname()}\n`);
  reclaimLock(lock, judged);
  assert.equal(readFileSync(lock, "utf8"), `${process.pid} ${os.hostname()}\n`);
  assert.equal(staleLock(lock, 60000), null, "the live lock is untouched");
  reclaimLock(lock, staleLock(lock, 0) ?? judged); // aged out: reclaimable
  rmSync(lock, { force: true });
  assert.deepEqual(
    readdirSync(path.join(dir, "dist")).filter((f) => f.includes("reclaim")),
    [],
    "no reclaim debris"
  );
});

test("a dead owner is reclaimed even when the hostname changed since it locked", () => {
  const dir = checkout();
  mkdirSync(path.join(dir, "dist"));
  writeFileSync(lockPath(dir), `${deadPid()} some-previous-hostname.local\n`);
  const started = Date.now();
  assert.equal(ensureTerminalBuilt(dir, { timeoutMs: 60000 }).ok, true);
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);
});

test("builds publish by swapping a staged directory: no debris, no leftovers from removed sources", () => {
  const dir = checkout();
  writeFileSync(path.join(dir, "src", "terminal", "extra.ts"), "export const extra = 1;\n");
  ensureTerminalBuilt(dir);
  assert.ok(existsSync(path.join(dir, "dist", "terminal", "extra.js")));
  rmSync(path.join(dir, "src", "terminal", "extra.ts"));
  assert.equal(ensureTerminalBuilt(dir).ok, true);
  assert.equal(existsSync(path.join(dir, "dist", "terminal", "extra.js")), false);
  assert.deepEqual(
    readdirSync(path.join(dir, "dist")).filter((f) => f !== "terminal"),
    [],
    "staging, retired and lock files are all gone"
  );
  assert.equal(terminalBuildState(dir).state, "fresh");
});
