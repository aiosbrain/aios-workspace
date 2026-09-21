/**
 * Harness plumbing for the MCP host acceptance journey. Node builtins only: nothing here
 * imports toolkit code, so every product behaviour the journey observes comes from the
 * INSTALLED package, driven through `node <pkg>/scripts/aios.mjs`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { gunzipSync } from "node:zlib";
import { registerSecretSentinel } from "../../helpers/scrubbed-env.mjs";
import { SENTINELS } from "./context.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = pathToFileURL(path.join(HERE, "mcp-fixture-preload.mjs")).href;
const BRAIN_FIXTURE = path.join(HERE, "mcp-brain-fixture.mjs");

/** Synthetic Brain keys. The team key is a cell sentinel; the external one is registered too. */
export const KEYS = Object.freeze({
  team: SENTINELS.aiosKey,
  external: "aios_k_sentinel_aio1112_external_never_print_5e0b7a",
  denied: "aios_k_sentinel_aio1112_denied_never_print_91c3f2",
});
for (const value of Object.values(KEYS)) registerSecretSentinel(value);
export const leaks = (text) => Object.values(KEYS).filter((key) => String(text).includes(key));

/** Processes that must NOT block anything: unrelated apps and documented lookalikes. */
export const UNRELATED_PROCESSES = Object.freeze([
  "/usr/bin/acceptance-editor --wait",
  "/Applications/Claude.app/Contents/Helpers/chrome-native-host",
  "/opt/acceptance/cursor-helper-not-cursor",
]);

export const sri = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** bytes + mode + mtime of everything under `root`, keyed by relative path. */
export function tree(root) {
  const rows = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const stat = lstatSync(file);
      rows[path.relative(root, file)] = [
        stat.mtimeMs,
        stat.mode,
        entry.isDirectory() ? "directory" : sri(readFileSync(file)),
      ];
      if (entry.isDirectory()) walk(file);
    }
  };
  walk(root);
  return rows;
}

/**
 * Elevated Windows runners create files owned by Administrators; the installer (rightly)
 * refuses foreign ownership. Fixtures model a user-owned profile — production checks are
 * never relaxed. Mirrors test/lib/mcp-host-fixture.mjs without importing toolkit code.
 */
export function own(target) {
  if (process.platform !== "win32") return;
  const script =
    "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; $p=$env:AIOS_TEST_OWNER_PATH; $a=Get-Acl -LiteralPath $p; $a.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User); Set-Acl -LiteralPath $p -AclObject $a";
  const powershell = path.win32.join(
    ...[process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"]
  );
  execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, AIOS_TEST_OWNER_PATH: target },
    stdio: "pipe",
    timeout: 30000,
  });
}

/** Independently inspect native ACLs; this oracle imports no installer ACL helper. */
export function assertOwnerOnlyAcl(ctx, home, files) {
  assert.equal(process.platform, "win32");
  const powershell = path.win32.join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const script = `
$ErrorActionPreference='Stop'
$env:PSModulePath=$PSHOME+'\\Modules'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rows=@(foreach ($p in (ConvertFrom-Json $env:AIOS_TEST_ACL_PATHS)) {
  $acl=Get-Acl -LiteralPath $p
  $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $allowed=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Value})
  [PSCustomObject]@{owner=$owner;current=$sid;allowed=$allowed}
})
ConvertTo-Json -InputObject $rows -Compress
`;
  const result = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: isolatedEnv(ctx, home, { AIOS_TEST_ACL_PATHS: JSON.stringify(files) }),
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30000,
  });
  const rows = JSON.parse(result.replace(/^\uFEFF/, ""));
  assert.equal(rows.length, files.length, "every sensitive path has ACL evidence");
  for (const row of rows) {
    assert.equal(row.owner === row.current, true, "current user owns sensitive path");
    assert.equal(row.allowed.includes(row.current), true, "current user retains access");
    assert.equal(
      row.allowed.every((sid) => [row.current, "S-1-5-18", "S-1-5-32-544"].includes(sid)),
      true,
      "no unrelated identity can access the sensitive path"
    );
  }
  return rows;
}

/** Provision the disposable Windows profile before PowerShell can create cache parents. */
export function prepareProfile(ctx, home) {
  if (process.platform !== "win32") return;
  const dirs = ["Roaming", "Local"].map((name) =>
    makeDir(path.join(home, "AppData", name), home)
  );
  const paths = [home, path.join(home, "AppData"), ...dirs];
  const owners = assertOwnerOnlyAcl(ctx, home, paths);
  ctx.record(`windows-profile-${path.basename(path.dirname(home))}`, {
    paths,
    owners,
  });
}

/** Create a user-owned directory chain below `root` (0700 on POSIX). */
export function makeDir(dir, root = dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let at = dir; at.startsWith(root); at = path.dirname(at)) {
    own(at);
    if (at === root) break;
  }
  return dir;
}

export function put(file, text, root) {
  makeDir(path.dirname(file), root);
  writeFileSync(file, text, { mode: 0o600 });
  own(file);
}

/** Independent minimal tar reader: the oracle for "the pinned bytes are what got installed". */
export function untar(compressed) {
  const tar = gunzipSync(compressed);
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, end) => {
      const bytes = header.subarray(start, end);
      const stop = bytes.indexOf(0);
      return bytes.subarray(0, stop < 0 ? bytes.length : stop).toString("utf8");
    };
    const size = Number.parseInt(text(124, 136).trim(), 8);
    files.set(
      text(0, 100).replace(/^package\//, ""),
      tar.subarray(offset + 512, offset + 512 + size)
    );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * Start the synthetic Brain as its own process. Startup is bounded and fails closed: a
 * timeout, an early exit or any line outside the fixture protocol kills the child and
 * rejects. `drain()` is the ONLY sound way to read `requests` after a blocking CLI run —
 * request lines arrive over a pipe and are not yet processed when spawnSync returns.
 */
export function startBrain(
  ctx,
  { startupMs = 15000, drainMs = 15000, stopMs = 5000, fixture = BRAIN_FIXTURE } = {}
) {
  const child = spawn(process.execPath, [fixture], {
    env: ctx.env({ AIOS_FIXTURE_TEAM_KEY: KEYS.team, AIOS_FIXTURE_EXTERNAL_KEY: KEYS.external }),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const requests = [];
  const waiting = new Map();
  let closed = false;
  let failure = null;
  const fail = (error) => {
    failure ??= error;
    for (const { reject } of waiting.values()) reject(failure);
    waiting.clear();
    if (!closed) child.kill("SIGKILL");
  };
  const stop = () =>
    new Promise((done, reject) => {
      if (closed) return done();
      const deadline = setTimeout(
        () => reject(new Error("synthetic Brain did not close after kill")),
        stopMs * 2
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), stopMs);
      child.once("close", () => {
        clearTimeout(timer);
        clearTimeout(deadline);
        done();
      });
      child.stdin.end();
    });
  let sequence = 0;
  const drain = () =>
    new Promise((resolve, reject) => {
      if (failure || closed) return reject(failure ?? new Error("synthetic Brain has exited"));
      const nonce = `n${++sequence}`;
      const timer = setTimeout(() => fail(new Error("synthetic Brain drain timed out")), drainMs);
      waiting.set(nonce, {
        resolve: () => (clearTimeout(timer), resolve(requests)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      child.stdin.write(`sync ${nonce}\n`);
    });
  return new Promise((resolve, reject) => {
    let buffer = "";
    let started = false;
    const timer = setTimeout(() => {
      fail(new Error(`synthetic Brain did not start within ${startupMs} ms`));
      reject(failure);
    }, startupMs);
    child.stdin.on("error", () => {});
    child.on("error", (error) => (fail(error), reject(error)));
    child.on("close", (status) => {
      closed = true;
      clearTimeout(timer);
      if (!started) reject(failure ?? new Error(`synthetic Brain exited early (${status})`));
      else if (waiting.size) fail(new Error(`synthetic Brain exited mid-run (${status})`));
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        fail(new Error("synthetic Brain protocol buffer exceeded limit"));
        if (!started) reject(failure);
        return;
      }
      for (let at; (at = buffer.indexOf("\n")) !== -1; buffer = buffer.slice(at + 1)) {
        let line = null;
        try {
          line = JSON.parse(buffer.slice(0, at));
        } catch {
          /* handled as a protocol violation below */
        }
        if (
          line?.request &&
          started &&
          typeof line.request.path === "string" &&
          Number.isInteger(line.request.status)
        )
          requests.push(line.request);
        else if (typeof line?.sync === "string" && waiting.has(line.sync)) {
          waiting.get(line.sync).resolve();
          waiting.delete(line.sync);
        } else if (
          Number.isInteger(line?.port) &&
          line.port > 0 &&
          line.port <= 65535 &&
          !started
        ) {
          started = true;
          clearTimeout(timer);
          resolve({ origin: `http://127.0.0.1:${line.port}`, requests, drain, stop });
        } else {
          fail(new Error("synthetic Brain spoke outside its protocol"));
          if (!started) reject(failure);
        }
      }
    });
  });
}

/** Isolated HOME/USERPROFILE/APPDATA + synthetic credentials on top of the cell allowlist. */
export function isolatedEnv(ctx, home, extra = {}) {
  return ctx.cliEnv({
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    ...extra,
  });
}

/**
 * Run the INSTALLED public CLI: absolute node + installed scripts/aios.mjs (never a .bin
 * shim), with the process-discovery fixture preloaded. `processes` is the whole simulated
 * process table for this invocation.
 */
export function cli(ctx, state, args, { home, cwd, env = {}, processes, label, expectFailure }) {
  writeFileSync(state.processList, JSON.stringify(processes));
  return ctx.run(process.execPath, ["--import", PRELOAD, state.entry, ...args], {
    cwd,
    label,
    expectFailure,
    timeout: 300000,
    env: isolatedEnv(ctx, home, {
      AIOS_ACCEPTANCE_PROCESS_LIST: state.processList,
      AIOS_ACCEPTANCE_PROCESS_LOG: state.processLog,
      ...env,
    }),
  });
}

/**
 * Drive the installed CLI's REAL interactive prompts expect-style: wait for a rendered
 * prompt, then send keys. An unmet expectation, an early exit or a timeout is a failure —
 * so deleting a prompt from the product (e.g. the MCP offer) turns the case red.
 */
export function drive(
  ctx,
  state,
  args,
  { home, cwd, processes, label, steps, timeoutMs = 240000 }
) {
  writeFileSync(state.processList, JSON.stringify(processes));
  const started = Date.now();
  const argv = ["--import", PRELOAD, state.entry, ...args];
  const child = spawn(process.execPath, argv, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: isolatedEnv(ctx, home, {
      AIOS_ACCEPTANCE_PROCESS_LIST: state.processList,
      AIOS_ACCEPTANCE_PROCESS_LOG: state.processLog,
      AIOS_ACCEPTANCE_SCRIPTED_TTY: "1",
    }),
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let cursor = 0;
    let index = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    // An `optional` step (a prompt that depends on the install layout) is skipped once a
    // later step's prompt is on screen; a required step is never skipped.
    const advance = () => {
      const screen = stripVTControlCharacters(stdout);
      while (index < steps.length) {
        let at = index;
        let match = steps[at].expect.exec(screen.slice(cursor));
        while (!match && steps[at].optional && at + 1 < steps.length)
          match = steps[++at].expect.exec(screen.slice(cursor));
        if (!match) return;
        cursor += match.index + match[0].length;
        index = at + 1;
        if (steps[at].send !== undefined) child.stdin.write(steps[at].send);
      }
      // The script is complete: close the "terminal" so the CLI can exit on its own.
      child.stdin.end();
    };
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      advance();
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      ctx.recordCommand({
        ...{ cmd: process.execPath, args: argv, status: status ?? 1, stdout, stderr, label },
        ...{ started, spawnError: null },
      });
      const screen = stripVTControlCharacters(stdout);
      if (index < steps.length)
        return reject(
          new Error(
            `${label}: prompt never appeared: ${steps[index].expect} (exit ${status})\n` +
              screen.slice(-1500)
          )
        );
      resolve({ status, screen, stderr });
    });
  });
}

/** Speak MCP to a recorded server command, independently of the installer's own verifier. */
export function rpc(entry, { cwd, env, calls = [] }) {
  const child = spawn(entry.command, entry.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [
    {
      ...{ jsonrpc: "2.0", id: 1, method: "initialize" },
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "aios-package-acceptance", version: "1" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ...calls.map((params, at) => ({ jsonrpc: "2.0", id: 3 + at, method: "tools/call", params })),
  ];
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      clearTimeout(timer);
      try {
        assert.equal(leaks(stdout + stderr).length, 0, "server output carries no credential");
        assert.equal(status, 0, `recorded MCP command exited ${status}: ${stderr.slice(-400)}`);
        const messages = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        resolve((id) => messages.find((message) => message.id === id)?.result);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
  });
}
