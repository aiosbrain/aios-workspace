#!/usr/bin/env node
/**
 * test/opencode-native/scaffold.test.mjs — export-commands idempotency + spec deterministic eval.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..", "..");
const EXPORT = path.join(REPO, "scripts", "export-commands.mjs");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const CMD_DIR = path.join(REPO, "scaffold", ".opencode", "command");
const ON2 = path.join(REPO, "docs", "specs", "opencode-native", "on2-opencode-json.md");

test("export-commands --scaffold is idempotent", () => {
  const r1 = spawnSync(process.execPath, [EXPORT, "--scaffold"], { encoding: "utf8" });
  assert.equal(r1.status, 0, r1.stderr);
  const hash1 = dirHash(CMD_DIR);
  const r2 = spawnSync(process.execPath, [EXPORT, "--scaffold"], { encoding: "utf8" });
  assert.equal(r2.status, 0, r2.stderr);
  const hash2 = dirHash(CMD_DIR);
  assert.equal(hash1, hash2);
  assert.ok(readdirSync(CMD_DIR).filter((f) => f.endsWith(".md")).length >= 6);
});

test("ON2 spec passes deterministic spec eval (--no-llm)", () => {
  assert.ok(existsSync(ON2), "ON2 spec missing");
  const r = spawnSync(process.execPath, [AIOS, "spec", "eval", ON2, "--no-llm", "--repo", REPO], {
    encoding: "utf8",
  });
  assert.notEqual(r.status, 4, `rubric missing? ${r.stderr}`);
  assert.notEqual(r.status, 1, `deterministic blocker: ${r.stderr}`);
  assert.ok(r.status === 3 || r.status === 0, `unexpected exit ${r.status}`);
});

function dirHash(dir) {
  const parts = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) =>
      createHash("sha256")
        .update(readFileSync(path.join(dir, f)))
        .digest("hex")
    );
  return createHash("sha256").update(parts.join("")).digest("hex");
}
