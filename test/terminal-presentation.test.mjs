import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createPresenter, canPresent } from "../scripts/ui.mjs";
import { renderStatus, safeText } from "../dist/terminal/report.js";
import { startProgress } from "../dist/terminal/session.js";
import { terminalTheme } from "../dist/terminal/theme.js";

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
