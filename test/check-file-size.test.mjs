// AIO-320 — file-size gate (scripts/check-file-size.mjs).
// Runs the real gate against a temp cwd with a synthetic size-caps.json, proving it passes under the
// cap and fails (naming the file) over it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-file-size.mjs");

function runWithCap(lineCount, cap) {
  const dir = mkdtempSync(path.join(tmpdir(), "sizegate-"));
  try {
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "big.txt"), `${"line\n".repeat(lineCount)}`);
    writeFileSync(path.join(dir, "scripts", "size-caps.json"), JSON.stringify({ caps: { "big.txt": cap } }));
    try {
      const stdout = execFileSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
      return { code: 0, out: stdout };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("passes when the file is at/under its cap", () => {
  const r = runWithCap(10, 100);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /clean/);
});

test("fails and names the file when over cap", () => {
  const r = runWithCap(10, 5);
  assert.equal(r.code, 1);
  assert.match(r.out, /big\.txt/);
  assert.match(r.out, /over by 5/);
});
