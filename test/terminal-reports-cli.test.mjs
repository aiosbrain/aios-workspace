// CLI paths for the colour reports (`aios analyze`, `aios context-health`,
// `aios codebase-health`). Piped and machine output must stay the exact plain report and
// never import Ink; a real PTY must select the presenter and honour every UI switch.
// Synthetic example workspace and an empty HOME only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { computeContextHealth, renderContextHealth } from "../scripts/context-health.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const ESC = "\u001b";
const build = spawnSync(process.execPath, ["scripts/build-terminal.mjs"], {
  cwd: root,
  encoding: "utf8",
  timeout: 60000,
});
assert.equal(build.status, 0, build.stderr);
const visibleWidth = (line) => [...stripVTControlCharacters(line)].length;

// ── Plain and machine paths: unchanged bytes, no Ink ─────────────────────────────────

const example = path.join(root, "examples", "sample-engagement");
const cleanEnv = (extra = {}) => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
  return env;
};

test("piped context-health and codebase-health print exactly the plain render, with Ink blocked", () => {
  const loader = [
    "--no-warnings",
    "--experimental-loader",
    "./test/fixtures/block-terminal-loader.mjs",
  ];
  const ch = spawnSync(
    process.execPath,
    [...loader, "scripts/aios.mjs", "context-health", example],
    {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv({ COLORTERM: "truecolor" }),
    }
  );
  assert.equal(ch.status, 0, ch.stderr);
  assert.equal(ch.stdout, `${renderContextHealth(computeContextHealth(example), example, {})}\n`);
  const json = spawnSync(
    process.execPath,
    [...loader, "scripts/aios.mjs", "context-health", example, "--json"],
    {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv(),
    }
  );
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(
    JSON.parse(json.stdout),
    JSON.parse(JSON.stringify(computeContextHealth(example)))
  );
  const cb = spawnSync(
    process.execPath,
    [...loader, "scripts/aios.mjs", "codebase-health", example],
    {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv(),
    }
  );
  assert.equal(cb.status, 0, cb.stderr);
  assert.match(cb.stdout, /^Codebase health: /);
  assert.doesNotMatch(cb.stdout, /AIOS · codebase health/);
  assert.ok(!cb.stdout.includes(ESC));
});

test("piped analyze keeps the legacy report and never imports Ink", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aios-analyze-pipe-"));
  try {
    const r = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-loader",
        pathToFileURL(path.join(root, "test/fixtures/block-terminal-loader.mjs")).href,
        path.join(root, "scripts/aios.mjs"),
        "analyze",
      ],
      { cwd: example, encoding: "utf8", env: cleanEnv({ HOME: home }) }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^AIOS analyze — \d{4}-\d{2}-\d{2} → /);
    assert.doesNotMatch(r.stdout, /AIOS · analyze/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Real PTY: the CLI picks the presenter on a capable terminal and honours every switch ──

const python = spawnSync("python3", ["--version"]).status === 0;
function pty(cols, cwd, args, env, nodeFlags = []) {
  const r = spawnSync(
    "python3",
    [
      "test/helpers/pty-run.py",
      String(cols),
      cwd,
      "--",
      process.execPath,
      ...nodeFlags,
      path.join(root, "scripts/aios.mjs"),
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 90000,
      env: cleanEnv({ TERM: "xterm-256color", ...env }),
    }
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const ptyOpts = { skip: process.platform === "win32" || !python };

test(
  "real PTY: analyze at 112 columns renders truecolor within the width; --json stays pure",
  ptyOpts,
  () => {
    const home = mkdtempSync(path.join(tmpdir(), "aios-analyze-pty-"));
    try {
      const env = { HOME: home, COLORTERM: "truecolor" };
      const rich = pty(112, example, ["analyze"], env);
      assert.equal(rich.code, 0, rich.output);
      assert.match(stripVTControlCharacters(rich.output), /^AIOS · analyze/);
      assert.ok(rich.output.split(`${ESC}[38;2;`).length > 11, "truecolor ink");
      for (const line of rich.output.replace(/\r/g, "").split("\n"))
        assert.ok(visibleWidth(line) <= 112, line);
      const json = pty(112, example, ["analyze", "--json"], env);
      assert.equal(json.code, 0, json.output);
      assert.ok(!json.output.includes(ESC));
      assert.equal(typeof JSON.parse(json.output).placement.spine, "string");
      const plain = pty(112, example, ["analyze"], { ...env, AIOS_UI_TIER: "plain" });
      assert.match(plain.output, /^AIOS analyze — /);
      const narrow = pty(112, example, ["analyze", "--report"], {
        ...env,
        AIOS_UI_WIDTH: "60",
        AIOS_UI_GLYPHS: "ascii",
        AIOS_UI_MOTION: "0",
      });
      for (const line of narrow.output.replace(/\r/g, "").split("\n"))
        assert.ok(visibleWidth(line) <= 60, line);
      assert.match(stripVTControlCharacters(narrow.output), /AIOS \| analyze[\s\S]*Deep dive/);
      const mono = pty(112, example, ["analyze"], { ...env, NO_COLOR: "1" });
      assert.match(mono.output, /^AIOS · analyze/);
      assert.ok(!mono.output.includes(`${ESC}[`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
);

test(
  "real PTY: health commands present on a TTY, fall back under plain, and honour light/ANSI",
  ptyOpts,
  () => {
    const truecolor = pty(112, root, ["context-health", example], { COLORTERM: "truecolor" });
    assert.match(stripVTControlCharacters(truecolor.output), /^AIOS · context health/);
    assert.ok(truecolor.output.includes(`${ESC}[38;2;`));
    const light = pty(112, root, ["context-health", example], {
      COLORTERM: "truecolor",
      AIOS_UI_BG: "light",
    });
    assert.notEqual(light.output, truecolor.output);
    const ansi = pty(112, root, ["codebase-health", example], {});
    assert.match(stripVTControlCharacters(ansi.output), /^AIOS · codebase health/);
    assert.ok(!ansi.output.includes(`${ESC}[38;2;`));
    const plain = pty(112, root, ["codebase-health", example], { AIOS_UI_TIER: "plain" });
    assert.match(plain.output, /Codebase health\S*: /);
    assert.doesNotMatch(plain.output, /AIOS · codebase health/);
  }
);

test(
  "real PTY: a colour render failure prints exactly the plain path's output, colours included",
  ptyOpts,
  () => {
    const home = mkdtempSync(path.join(tmpdir(), "aios-analyze-fallback-"));
    const throwing = [
      "--no-warnings",
      "--experimental-loader",
      pathToFileURL(path.join(root, "test/fixtures/throwing-report-loader.mjs")).href,
    ];
    try {
      const env = { HOME: home, COLORTERM: "truecolor" };
      for (const [cwd, args] of [
        [example, ["analyze", "--report"]],
        [root, ["context-health", example]],
        [root, ["codebase-health", example]],
      ]) {
        const failed = pty(112, cwd, args, env, throwing);
        const plain = pty(112, cwd, args, { ...env, AIOS_UI_TIER: "plain" });
        assert.equal(failed.code, 0, failed.output);
        assert.equal(
          failed.output,
          plain.output,
          `${args[0]} fallback differs from the plain path`
        );
        assert.ok(plain.output.includes(ESC), `${args[0]} plain path is coloured on a TTY`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
);
