// AIO-320 — domain-isolation validator (scripts/check-domain-isolation.mjs).
// Runs the real validator against synthetic src/operator-loop trees in a temp cwd, proving it flags
// cross-domain VALUE imports and allows `import type` + loop-core imports (not passing vacuously).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-domain-isolation.mjs");

function runIn(asksImport, extraFiles = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "domiso-"));
  try {
    mkdirSync(path.join(dir, "src", "operator-loop", "asks"), { recursive: true });
    mkdirSync(path.join(dir, "src", "operator-loop", "comms"), { recursive: true });
    writeFileSync(
      path.join(dir, "src", "operator-loop", "asks", "x.ts"),
      `${asksImport}\nexport const x = 1;\n`
    );
    writeFileSync(
      path.join(dir, "src", "operator-loop", "comms", "y.ts"),
      `export const v = 1;\nexport type T = number;\n`
    );
    for (const [rel, body] of Object.entries(extraFiles)) {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), body);
    }
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

test("flags a cross-domain VALUE import", () => {
  const r = runIn(`import { v } from "../comms/y.js";`);
  assert.equal(r.code, 1);
  assert.match(r.out, /asks → comms/);
  assert.match(r.out, /asks\/x\.ts/);
});

test("allows a cross-domain `import type`", () => {
  const r = runIn(`import type { T } from "../comms/y.js";`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /clean/);
});

test("flags a mixed value+type import (a value slips in)", () => {
  const r = runIn(`import { v, type T } from "../comms/y.js";`);
  assert.equal(r.code, 1);
  assert.match(r.out, /asks → comms/);
});

test("allows a loop-core value import (../signal.js)", () => {
  const r = runIn(`import { resolveTier } from "../signal.js";`);
  assert.equal(r.code, 0, r.out);
});

test("allows a same-domain value import (./store.js)", () => {
  const r = runIn(`import { sha256 } from "./store.js";`);
  assert.equal(r.code, 0, r.out);
});
