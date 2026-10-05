// Source checkouts must never be silently plain or stale: dist/terminal is rebuilt from
// src/terminal on demand (scripts/ensure-terminal-built.mjs), installed packages pay one
// stat, and the plain fallback says why — once, and only to a human terminal.
// Lock, signal and publication behaviour: test/terminal-autobuild-lock.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ensureTerminalBuilt, terminalBuildState } from "../scripts/ensure-terminal-built.mjs";
import { createPresenter } from "../scripts/ui.mjs";
import { breakSources, checkout, root, tmp, tty } from "./helpers/terminal-checkout.mjs";

test("installed-package layout is a no-op: no hashing, no build, nothing written", () => {
  const dir = tmp();
  mkdirSync(path.join(dir, "dist", "terminal"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "terminal", "report.js"), "export {};\n");
  const before = readdirSync(path.join(dir, "dist")).sort();
  let builds = 0;
  assert.equal(terminalBuildState(dir).state, "installed");
  const result = ensureTerminalBuilt(dir, { onBuild: () => builds++ });
  assert.equal(result.state, "installed");
  assert.equal(builds, 0);
  assert.deepEqual(readdirSync(path.join(dir, "dist")).sort(), before);
  assert.equal(terminalBuildState(tmp()).state, "installed");
});

test("missing and stale builds are detected and rebuilt; a fresh build is left alone", () => {
  const dir = checkout();
  const builds = [];
  const onBuild = (state) => builds.push(state);
  assert.equal(terminalBuildState(dir).state, "missing");

  assert.equal(ensureTerminalBuilt(dir, { onBuild }).ok, true);
  assert.deepEqual(builds, ["missing"]);
  assert.equal(terminalBuildState(dir).state, "fresh");
  assert.equal(ensureTerminalBuilt(dir, { onBuild }).ok, true);
  assert.deepEqual(builds, ["missing"], "fresh build must not recompile");

  appendFileSync(path.join(dir, "src", "terminal", "theme.tsx"), "\nexport const __probe = 7;\n");
  assert.equal(terminalBuildState(dir).state, "stale");
  assert.equal(ensureTerminalBuilt(dir, { onBuild }).ok, true);
  assert.deepEqual(builds, ["missing", "stale"]);
  assert.match(readFileSync(path.join(dir, "dist", "terminal", "theme.js"), "utf8"), /__probe/);

  appendFileSync(path.join(dir, "tsconfig.terminal.json"), "\n");
  assert.equal(terminalBuildState(dir).state, "stale", "build config is an input");
  appendFileSync(path.join(dir, "src", "terminal", "vendor", "LICENSE"), "\n");
  ensureTerminalBuilt(dir);
  assert.equal(terminalBuildState(dir).state, "fresh");
  assert.equal(
    readFileSync(path.join(dir, "dist", "terminal", "vendor", "LICENSE"), "utf8"),
    readFileSync(path.join(dir, "src", "terminal", "vendor", "LICENSE"), "utf8"),
    "vendor notices are inputs too"
  );
});

test("a failed auto-build never throws, is not retried until sources change, and keeps the last good build", async () => {
  const dir = checkout();
  ensureTerminalBuilt(dir);
  breakSources(dir);
  const failed = ensureTerminalBuilt(dir);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "build-failed");
  assert.equal(failed.built, true);
  let builds = 0;
  const again = ensureTerminalBuilt(dir, { onBuild: () => builds++ });
  assert.equal(again.reason, "previous-build-failed");
  assert.equal(builds, 0, "an unchanged broken tree must not recompile on every command");

  const stderr = tty();
  for (let i = 0; i < 2; i++) {
    const ui = await createPresenter({ stdout: tty(), stderr, env: { TERM: "xterm" }, root: dir });
    assert.ok(ui, "the last good build still renders");
  }
  assert.equal(stderr.chunks.length, 1, stderr.chunks.join(""));
  assert.match(stderr.chunks[0], /out of date.*npm run build:terminal/);

  rmSync(path.join(dir, "src", "terminal", "broken.ts"));
  assert.equal(ensureTerminalBuilt(dir).ok, true, "fixing the source retries");
});

test("a checkout that cannot build falls back with exactly one hint", async () => {
  for (const [dir, remedy] of [
    [checkout({ compiler: false }), /install devDependencies \(`npm install`\), then run `npm/],
    [
      (() => {
        const broken = checkout();
        breakSources(broken);
        return broken;
      })(),
      /colour UI not built — run `npm run build:terminal`/,
    ],
  ]) {
    assert.doesNotThrow(() => ensureTerminalBuilt(dir));
    const stderr = tty();
    const stdout = tty();
    for (let i = 0; i < 3; i++)
      assert.equal(
        await createPresenter({ stdout, stderr, env: { TERM: "xterm" }, root: dir }),
        null
      );
    assert.deepEqual(stdout.chunks, [], "the hint never touches stdout");
    assert.equal(stderr.chunks.length, 1, stderr.chunks.join(""));
    assert.match(stderr.chunks[0], remedy);
  }
});

test("the hint is suppressed for plain, NO_COLOR, CI, machine modes and redirected streams", async () => {
  const missing = tmp(); // installed layout with no dist: the import fails
  for (const options of [
    { env: { TERM: "xterm", NO_COLOR: "1" } },
    { env: { TERM: "xterm", AIOS_UI_TIER: "plain" } },
    { env: { TERM: "xterm", CI: "true" } },
    { env: { TERM: "dumb" } },
    { env: { TERM: "xterm" }, mode: "json" },
    { env: { TERM: "xterm" }, mode: "porcelain" },
    { env: { TERM: "xterm" }, stdout: tty({ isTTY: false }) },
    { env: { TERM: "xterm" }, stderr: tty({ isTTY: false }) },
  ]) {
    const stderr = options.stderr ?? tty();
    const stdout = options.stdout ?? tty();
    assert.equal(await createPresenter({ stdout, stderr, root: missing, ...options }), null);
    assert.deepEqual([...stdout.chunks, ...stderr.chunks], [], JSON.stringify(options));
  }
});

const python = spawnSync("python3", ["--version"]).status === 0;
const ptyRun = (dir, extraEnv = {}) => {
  const r = spawnSync(
    "python3",
    [
      "test/helpers/terminal-pty.py",
      process.execPath,
      "test/fixtures/terminal-autobuild.mjs",
      "message",
      "80",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        NO_COLOR: "",
        COLORTERM: "truecolor",
        AIOS_TEST_TERMINAL_ROOT: dir,
        ...extraEnv,
      },
    }
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test(
  "real PTY: a checkout with no dist renders truecolor on first run with no manual build",
  { skip: process.platform === "win32" || !python },
  () => {
    const dir = checkout();
    const { code, output } = ptyRun(dir);
    assert.equal(code, 0, output);
    assert.ok(output.includes("\x1b[38;2"), `expected truecolor output: ${JSON.stringify(output)}`);
    assert.match(stripVTControlCharacters(output), /Autobuild fixture rendered/);
    assert.doesNotMatch(output, /not built/);
    assert.equal(terminalBuildState(dir).state, "fresh");
  }
);

test(
  "real PTY: an unbuildable checkout prints the hint once and keeps its exit code",
  { skip: process.platform === "win32" || !python },
  () => {
    const dir = checkout();
    breakSources(dir);
    const { code, output } = ptyRun(dir);
    assert.equal(code, 0, output);
    const plain = stripVTControlCharacters(output);
    assert.equal(plain.match(/colour UI not built/g)?.length, 1, plain);
    assert.match(plain, /Autobuild fixture plain/);
  }
);

test("piped output stays escape-free, hint-free, and never triggers a build", () => {
  const dir = checkout();
  const r = spawnSync(process.execPath, ["test/fixtures/terminal-autobuild.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, NO_COLOR: "", COLORTERM: "truecolor", AIOS_TEST_TERMINAL_ROOT: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Autobuild fixture plain\n");
  assert.equal(r.stderr, "");
  assert.equal(existsSync(path.join(dir, "dist")), false, "machine paths pay nothing");
});

test("a partially deleted build reads as stale and self-heals instead of hinting", async () => {
  const dir = checkout();
  ensureTerminalBuilt(dir);
  rmSync(path.join(dir, "dist", "terminal", "theme.js"));
  assert.equal(terminalBuildState(dir).state, "stale");
  const stderr = tty();
  const ui = await createPresenter({ stdout: tty(), stderr, env: { TERM: "xterm" }, root: dir });
  assert.ok(ui, "the presenter rebuilt the missing output and rendered");
  assert.ok(existsSync(path.join(dir, "dist", "terminal", "theme.js")));
  assert.doesNotMatch(stderr.chunks.join(""), /not built|out of date/);
});
