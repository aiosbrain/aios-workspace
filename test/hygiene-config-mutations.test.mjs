import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test(
  "size config selection and validation mutations fail their regression tests",
  { timeout: 30_000 },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "size-config-mutants-"));
    try {
      for (const file of [
        "scripts/check-file-size.mjs",
        "scripts/git-files.mjs",
        "packages/foundation/src/git-files.mjs",
        "validation/agent-readiness-lib.mjs",
        "test/check-file-size.test.mjs",
      ]) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        copyFileSync(path.join(root, file), path.join(dir, file));
      }
      const script = path.join(dir, "scripts/check-file-size.mjs");
      const source = readFileSync(script, "utf8");
      const run = () =>
        spawnSync(
          process.execPath,
          ["--test", "--test-reporter=tap", "test/check-file-size.test.mjs"],
          {
            cwd: dir,
            encoding: "utf8",
            timeout: 10_000,
            env: Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST_"))
            ),
          }
        );
      let result = run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      for (const [before, after] of [
        ["CONFIG_PATH = path.resolve(ROOT, args[++i]);", "i++; // ignore explicit configuration"],
        ["Number.isSafeInteger(n) && n >= 0", "true"],
        [
          "throw new Error(`Invalid file-size configuration: ${CONFIG_PATH}`);",
          "return { defaultCap: 99999, include: [], exclude: [] };",
        ],
      ]) {
        assert.ok(source.includes(before));
        writeFileSync(script, source.replace(before, after));
        result = run();
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, /not ok/);
        writeFileSync(script, source);
      }
      assert.equal(run().status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
