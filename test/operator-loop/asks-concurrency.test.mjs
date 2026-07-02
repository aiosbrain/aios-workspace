// Asks concurrency (AIO-167) — the issue's acceptance under load: 2 sessions × 50 parallel appends
// from separate processes produce zero corrupt lines, the exact count, and dedupeKeys distinct per
// session (the lock serializes writers across processes).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { foldLines, ASKS_STORE_REL } from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST_INDEX = pathToFileURL(path.join(ROOT, "dist", "operator-loop", "index.js")).href;

function runAppender(root, session, n) {
  return new Promise((resolve, reject) => {
    const script = `const { appendCreate } = await import(${JSON.stringify(DIST_INDEX)});
const [root, session, n] = [process.argv[2], process.argv[3], Number(process.argv[4])];
for (let i = 0; i < n; i++)
  appendCreate(root, { kind: "c", severity: "fyi", title: session + "-" + i, source: "test", sessionId: session, dedupeKey: session + "|" + i });
`;
    const file = path.join(root, `appender-${session}.mjs`);
    writeFileSync(file, script);
    const p = spawn("node", [file, root, session, String(n)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`appender ${session} exited ${code}: ${err}`))
    );
  });
}

test("2 sessions × 50 concurrent appends: no corruption, exact count, dedupeKeys distinct per session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "asks-conc-"));
  try {
    const N = 50;
    await Promise.all([runAppender(root, "S1", N), runAppender(root, "S2", N)]);

    const raw = readFileSync(path.join(root, ASKS_STORE_REL), "utf8");
    for (const line of raw.split(/\r?\n/).filter(Boolean))
      assert.doesNotThrow(() => JSON.parse(line), `corrupt line: ${line}`);

    const { asks, warnings } = foldLines(raw.split(/\r?\n/));
    assert.equal(warnings.length, 0, "no malformed/duplicate lines under contention");
    assert.equal(asks.length, 2 * N, "every append landed");

    const s1 = new Set(asks.filter((a) => a.sessionId === "S1").map((a) => a.dedupeKey));
    const s2 = new Set(asks.filter((a) => a.sessionId === "S2").map((a) => a.dedupeKey));
    assert.equal(s1.size, N, "S1 has 50 distinct dedupeKeys");
    assert.equal(s2.size, N, "S2 has 50 distinct dedupeKeys");
    for (const k of s1) assert.ok(!s2.has(k), "no dedupeKey collision across sessions");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
