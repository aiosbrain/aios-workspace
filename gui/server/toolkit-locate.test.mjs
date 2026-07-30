// toolkit-locate.test.mjs — the toolkit-location contract (AIO-600 C5).
// Pins the resolution order (--toolkit-dir > AIOS_TOOLKIT_DIR > adjacent fallback), the
// hard-error rules for explicit-but-invalid and present-but-valueless sources, and the
// marker validation. See docs/gui-toolkit-contract.md §C5.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { locateToolkit, TOOLKIT_MARKERS } from "./toolkit-locate.mjs";

// This repo IS a valid toolkit (scripts/aios.mjs + scaffold/ + package.json).
const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("resolution order: --toolkit-dir wins over env; env wins over fallback", () => {
  const viaArg = locateToolkit({
    argv: ["--repo", "/x", "--toolkit-dir", TOOLKIT],
    env: { AIOS_TOOLKIT_DIR: "/nonexistent" },
  });
  assert.equal(viaArg.source, "--toolkit-dir");
  assert.equal(viaArg.dir, realpathSync(TOOLKIT));

  const viaEnv = locateToolkit({ argv: [], env: { AIOS_TOOLKIT_DIR: TOOLKIT } });
  assert.equal(viaEnv.source, "AIOS_TOOLKIT_DIR");

  const viaFallback = locateToolkit({ argv: [], env: {}, fallbackDir: TOOLKIT });
  assert.equal(viaFallback.source, "adjacent-checkout");
});

test("a present-but-valueless --toolkit-dir is a hard, actionable error (no silent fallback)", () => {
  // Trailing flag with no value.
  assert.throws(
    () => locateToolkit({ argv: ["--repo", "/x", "--toolkit-dir"], env: {}, fallbackDir: TOOLKIT }),
    /--toolkit-dir requires a path argument/
  );
  // Another option where the path should be.
  assert.throws(
    () => locateToolkit({ argv: ["--toolkit-dir", "--port"], env: {}, fallbackDir: TOOLKIT }),
    /--toolkit-dir requires a path argument \(got '--port'\)/
  );
});

test("an explicit source pointing at a non-toolkit dir hard-fails, naming source and markers", () => {
  const notAToolkit = mkdtempSync(path.join(tmpdir(), "toolkit-locate-"));
  try {
    for (const [argv, env, source] of [
      [["--toolkit-dir", notAToolkit], {}, "--toolkit-dir"],
      [[], { AIOS_TOOLKIT_DIR: notAToolkit }, "AIOS_TOOLKIT_DIR"],
    ]) {
      assert.throws(
        () => locateToolkit({ argv, env, fallbackDir: TOOLKIT }),
        (e) =>
          e.message.includes(source) &&
          TOOLKIT_MARKERS.every((m) => e.message.includes(m)) &&
          /cannot locate the AIOS toolkit/.test(e.message),
        `${source} should hard-fail, not fall back`
      );
    }
  } finally {
    rmSync(notAToolkit, { recursive: true, force: true });
  }
});

test("an invalid fallback (no explicit source) fails actionably too", () => {
  assert.throws(
    () => locateToolkit({ argv: [], env: {}, fallbackDir: "/nonexistent-toolkit" }),
    /cannot locate the AIOS toolkit: \/nonexistent-toolkit \(via adjacent-checkout\)/
  );
});
