import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createPresenter, canPresent } from "../scripts/ui.mjs";
import { renderStatus, safeText } from "../dist/terminal/report.js";
import { startProgress } from "../dist/terminal/session.js";
import { terminalTheme } from "../dist/terminal/theme.js";

const root = fileURLToPath(new URL("../", import.meta.url));
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
