import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createPresenter, canPresent } from "../scripts/ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Sharded CI invokes test:node directly, without test:prepare. Build before imports.
const terminalBuild = spawnSync(process.execPath, ["scripts/build-terminal.mjs"], {
  cwd: root,
  encoding: "utf8",
  timeout: 30000,
});
assert.equal(terminalBuild.status, 0, terminalBuild.stderr);
const { renderStatus, safeText } = await import("../dist/terminal/report.js");
const { startProgress } = await import("../dist/terminal/session.js");
const { terminalTheme } = await import("../dist/terminal/theme.js");

const ctx = {
  mode: "human",
  width: 80,
  colorDepth: 0,
  motion: false,
  tier: "rich",
  glyphs: "ascii",
  background: "dark",
};
const report = {
  project: "fixture",
  destination: "Offline / standalone",
  fresh: [
    {
      rel: "2-work/a-long-path-that-must-not-be-truncated-or-disappear-in-a-narrow-terminal.md",
      kind: "deliverable",
      tier: "team",
    },
  ],
  modified: [],
  held: [{ rel: "5-personal/notes.md", reason: "admin tier" }],
  clean: 3,
};
test("status wraps complete paths and retains held reasons at every supported width", () => {
  for (const width of [60, 80, 120]) {
    const output = renderStatus({ ...ctx, width }, report);
    assert.ok(output.replace(/\s/g, "").includes(report.fresh[0].rel));
    assert.match(output, /admin tier/);
    assert.match(output, /Held locally/);
    assert.match(output, /aios push --dry-run/);
    assert.equal(stripVTControlCharacters(output), output);
    assert.ok(
      [...output].every((char) => char.codePointAt(0) < 128),
      "ASCII fixture must remain ASCII"
    );
    if (width < 80) assert.doesNotMatch(output, /\+---/);
  }
});
test("untrusted output cannot inject ANSI or OSC controls", () => {
  assert.equal(safeText("\x1b[31mred\x1b[0m\x1b]0;bad\x07"), "red");
});
test("themes inherit canvas and text, and use ANSI fallbacks without colors in monochrome", () => {
  for (const background of ["light", "dark"]) {
    const colors = terminalTheme({ ...ctx, background }).colors;
    assert.equal(colors.foreground, undefined);
    assert.equal(colors.background, undefined);
    assert.equal(colors.success, undefined);
    assert.equal(terminalTheme({ ...ctx, background, colorDepth: 4 }).colors.error, "red");
  }
});
test("basic and reduced-motion tiers never open a live animation", () => {
  const stream = {
    write() {
      throw new Error("unexpected live output");
    },
  };
  for (const options of [
    { tier: "basic", motion: true },
    { tier: "rich", motion: false },
  ]) {
    assert.doesNotThrow(() =>
      startProgress({ ...ctx, ...options }, { label: "Quiet" }, stream).stop()
    );
  }
});
test("machine, plain, dumb, CI and redirected streams never activate the renderer", async () => {
  for (const options of [
    { mode: "json" },
    { mode: "porcelain" },
    { env: { AIOS_UI_TIER: "plain" } },
    { env: { TERM: "dumb" } },
    { env: { CI: "true" } },
    { stdout: { isTTY: false } },
  ]) {
    assert.equal(await createPresenter({ stdout: { isTTY: true }, env: {}, ...options }), null);
  }
  assert.equal(canPresent({ stream: { isTTY: true }, env: { TERM: "xterm" } }), true);
});
test("presentation failure never retries an operation or changes its return/error", async () => {
  const stream = {
    isTTY: true,
    columns: 80,
    write() {
      throw new Error("broken display");
    },
  };
  const ui = await createPresenter({
    stdout: stream,
    stderr: stream,
    env: { AIOS_UI_MOTION: "0" },
  });
  assert.ok(ui);
  let calls = 0;
  assert.equal(
    await ui.run({ label: "Synthetic" }, async () => {
      calls++;
      return 17;
    }),
    17
  );
  await assert.rejects(
    ui.run({ label: "Synthetic" }, async () => {
      calls++;
      throw new Error("operation failed");
    }),
    /operation failed/
  );
  assert.equal(calls, 2);
  assert.doesNotThrow(() => ui.message("Completed"));
});
const python = spawnSync("python3", ["--version"]).status === 0;
for (const width of [60, 80, 120]) {
  test(
    `real PTY restores input and masks a pasted secret at ${width} columns`,
    { skip: process.platform === "win32" || !python },
    () => {
      const r = spawnSync(
        "python3",
        [
          "test/helpers/terminal-pty.py",
          process.execPath,
          "test/fixtures/terminal-session.mjs",
          "secret",
          String(width),
        ],
        { cwd: root, encoding: "utf8", timeout: 20000 }
      );
      assert.equal(r.status, 0, r.stderr);
      const { code, output } = JSON.parse(r.stdout);
      assert.equal(code, 0, output);
      assert.doesNotMatch(output, /fixture-secret-123/);
      assert.match(output, /Stored 18 characters/);
      assert.match(output, /RAW_MODE=false/);
      assert.ok(output.includes("\x1b[?25h"), "cursor is restored");
      assert.ok(!output.includes("\x1b[?1049h"));
    }
  );
}
for (const [scenario, expected, code] of [
  ["confirm", /Answer false/, 0],
  ["confirm-batch", /Answer true/, 0],
  ["text", /Answer "Example"/, 0],
  ["multi", /Answer \["b"\]/, 0],
  ["cancel", /Completed steps remain saved/, 1],
  ["interrupt", /Completed steps remain saved/, 1],
  ["terminate", /Completed steps remain saved/, 1],
  ["progress", /Completed synthetic sync/, 0],
]) {
  test(`real PTY: ${scenario}`, { skip: process.platform === "win32" || !python }, () => {
    const r = spawnSync(
      "python3",
      [
        "test/helpers/terminal-pty.py",
        process.execPath,
        "test/fixtures/terminal-session.mjs",
        scenario,
        "80",
      ],
      { cwd: root, encoding: "utf8", timeout: 20000 }
    );
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.code, code, result.output);
    assert.match(stripVTControlCharacters(result.output), expected);
    assert.match(result.output, /RAW_MODE=false/);
  });
}
test("help and disabled presenters run with React and Ink imports blocked", () => {
  const options = { cwd: root, encoding: "utf8" };
  const base = [
    "--no-warnings",
    "--experimental-loader",
    "./test/fixtures/block-terminal-loader.mjs",
  ];
  const help = spawnSync(process.execPath, [...base, "scripts/aios.mjs", "help"], options);
  assert.equal(help.status, 0, help.stderr);
  const probe = spawnSync(
    process.execPath,
    [
      ...base,
      "--input-type=module",
      "-e",
      `
    import {createPresenter} from './scripts/ui.mjs';
    for(const mode of ['json','porcelain']) {
      if(await createPresenter({mode,stdout:{isTTY:true},env:{FORCE_COLOR:'3'}})) throw new Error('loaded');
    }
    if(await createPresenter({stdout:{isTTY:true},env:{AIOS_UI_TIER:'plain'}})) throw new Error('loaded');
  `,
    ],
    options
  );
  assert.equal(probe.status, 0, probe.stderr);
});

test("MCP JSON with no target stays noninteractive even on a TTY", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-loader",
      "./test/fixtures/block-terminal-loader.mjs",
      "--input-type=module",
      "-e",
      `
      import { cmdMcpHost } from './scripts/mcp-host-command.mjs';
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      try { await cmdMcpHost(['install', '--json']); throw new Error('unexpected success'); }
      catch (error) { if (!error.message.startsWith('Use --host')) throw error; }
    `,
    ],
    { cwd: root, encoding: "utf8", timeout: 5000 }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("rich command engines retain partial results and tolerate failed progress observers", () => {
  const result = spawnSync(process.execPath, ["test/fixtures/terminal-engine.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /ENGINE_CONTRACTS_OK/);
  assert.match(result.stdout, /Pushed 1\/2/);
  assert.match(result.stdout, /Pull stopped after writing 1 item/);
  assert.match(result.stdout, /invalid_key/);
});

test("terminal build emits directly importable ESM and retains vendor notices", () => {
  const result = spawnSync(process.execPath, ["scripts/build-terminal.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {readFileSync} from 'node:fs';
    await import('./dist/terminal/report.js');
    for (const file of ['LICENSE', 'provenance.json']) {
      if (readFileSync('./dist/terminal/vendor/'+file,'utf8') !== readFileSync('./src/terminal/vendor/'+file,'utf8')) throw new Error('missing vendor notice');
    }
  `,
    ],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(probe.status, 0, probe.stderr);
});

test("cursor editing and table padding respect combining characters and wide graphemes", async () => {
  const text = await import("../dist/terminal/vendor/lib/terminal-text.js");
  const value = "Ae\u0301界";
  assert.equal(text.graphemeLength(value), 3);
  assert.equal(text.terminalWidth(value), 4);
  assert.equal(text.cursorCellOffset(value, 3), 4);
  assert.deepEqual(text.removeGraphemeBefore(value, 2), { value: "A界", cursor: 1 });
  assert.deepEqual(text.removeGraphemeBefore(value, 0), { value, cursor: 0 });
  assert.deepEqual(text.removeGraphemeAt(value, 1), { value: "A界", cursor: 1 });
  assert.deepEqual(text.removeGraphemeAt(value, 3), { value, cursor: 3 });
  assert.equal(text.truncateToTerminalWidth(value, 3), "Ae\u0301…");
  assert.equal(text.truncateToTerminalWidth(value, 1), "…");
  assert.equal(text.truncateToTerminalWidth(value, 0), "");
  assert.equal(text.truncateToTerminalWidth(value, 1, ".."), "");
  assert.equal(text.padToTerminalWidth("界", 4), "界  ");
  assert.equal(text.padToTerminalWidth("界", 4, "right"), "  界");
});
