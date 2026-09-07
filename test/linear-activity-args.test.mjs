import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const ROOT = path.resolve(import.meta.dirname, "..");

test("activity rejects unknown/missing arguments before credentials and provider calls; dry-run remains read-only", () => {
  const root = mkdtempSync(path.join(tmpdir(), "activity-args-"));
  try {
    writeFileSync(path.join(root, "aios.yaml"), "owner: test\npm_tool: none\n");
    const trace = path.join(root, "provider-called"),
      activity = path.join(root, "activity.jsonl");
    const preload = path.join(root, "mock.mjs");
    writeFileSync(
      preload,
      `import ${JSON.stringify(pathToFileURL(path.join(ROOT, "test/helpers/mock-linear-provider.mjs")).href)};
import { writeFileSync } from "node:fs";
const mocked = globalThis.fetch;
globalThis.fetch = (...args) => { writeFileSync(${JSON.stringify(trace)}, "called"); return mocked(...args); };`
    );
    const run = (args, configured) =>
      spawnSync(
        process.execPath,
        ["--import", preload, path.join(ROOT, "scripts/aios.mjs"), "linear", "activity", ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            HOME: root,
            PATH: process.env.PATH,
            ...(configured ? { LINEAR_API_KEY: "fixture-key" } : {}),
          },
        }
      );
    for (const configured of [false, true]) {
      for (const args of [
        ["pull", "--dry-rnu"],
        ["pull", "--repo"],
        ["--tier"],
        ["--activity-path"],
        ["push"],
        ["pull", "--tier", "invalid"],
        ["--dry-run", "--dry-run"],
      ]) {
        const r = run(args, configured);
        // The outer workspace dispatcher rejects a missing --repo before adapter dispatch.
        assert.equal(r.status, args.includes("--repo") ? 1 : 2, `${args}: ${r.stderr} ${r.stdout}`);
        assert.match(
          r.stderr + r.stdout,
          args.includes("--repo") ? /needs a path/ : /AIOS_E_USAGE/
        );
        assert.equal(existsSync(trace), false, "invalid input must never reach provider");
        assert.equal(existsSync(activity), false);
      }
    }
    const r = run(["pull", "--dry-run", "--activity-path", activity], true);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(trace), true, "positive control actually queried the mock");
    assert.equal(existsSync(activity), false, "dry-run cannot append");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
