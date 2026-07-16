import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAnalysisCache, AnalyzeTimeoutError } from "./analysis-cache.mjs";

// Two distinguishable analyze --json documents (shape doesn't matter to the cache —
// it only requires parseable JSON and hands the raw string to the reshapers).
const DOC = JSON.stringify({ placement: { overall: 2.0 } });
const DOC2 = JSON.stringify({ placement: { overall: 3.0 } });

function tmpSnapshotFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aios-analysis-cache-"));
  return path.join(dir, "gui", "analysis-snapshot.json"); // parent dir created on persist
}

/** Deferred exec: counts spawns; each call resolves/rejects when the test says so. */
function fakeExec(results) {
  const calls = [];
  const exec = (signal) =>
    new Promise((resolve, reject) => {
      const i = calls.length;
      calls.push({ signal, aborted: false });
      signal.addEventListener("abort", () => (calls[i].aborted = true), { once: true });
      const r = results[Math.min(i, results.length - 1)];
      if (r.hang) return; // never settles on its own (timeout path)
      queueMicrotask(() => (r.error ? reject(r.error) : resolve(r.value)));
    });
  return { exec, calls };
}

const settle = () => new Promise((r) => setImmediate(r));

test("concurrent cold requests spawn exactly one subprocess", async () => {
  const { exec, calls } = fakeExec([{ value: DOC }]);
  const cache = createAnalysisCache({ exec, snapshotFile: tmpSnapshotFile(), now: () => 1000 });
  const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(calls.length, 1);
  for (const r of [a, b, c]) {
    assert.equal(r.raw, DOC);
    assert.equal(r.lastError, null);
    assert.equal(r.refreshing, false);
    assert.equal(r.generatedAt, new Date(1000).toISOString());
    assert.equal(r.ageMs, 0);
  }
});

test("warm hit under the fresh window serves the cache without spawning", async () => {
  let t = 0;
  const { exec, calls } = fakeExec([{ value: DOC }]);
  const cache = createAnalysisCache({ exec, snapshotFile: tmpSnapshotFile(), now: () => t });
  await cache.get();
  assert.equal(calls.length, 1);
  t = 30_000; // still inside the 60s fresh window
  const r = await cache.get();
  assert.equal(calls.length, 1); // no new subprocess
  assert.equal(r.raw, DOC);
  assert.equal(r.ageMs, 30_000);
  assert.equal(r.refreshing, false);
});

test("stale hit returns immediately and triggers exactly one background refresh", async () => {
  let t = 0;
  const results = [{ value: DOC }, { hang: true }];
  const { exec, calls } = fakeExec(results);
  // timeoutMs kept tiny so the hanging background refresh doesn't outlive the suite
  const cache = createAnalysisCache({
    exec,
    snapshotFile: tmpSnapshotFile(),
    now: () => t,
    timeoutMs: 50,
  });
  await cache.get();
  t = 61_000; // past the fresh window
  const stale = await cache.get(); // must NOT block on the refresh
  assert.equal(stale.raw, DOC); // old data served immediately
  assert.equal(stale.ageMs, 61_000);
  assert.equal(stale.refreshing, true);
  const again = await cache.get(); // single-flight: no second spawn while inflight
  assert.equal(again.refreshing, true);
  assert.equal(calls.length, 2); // cold spawn + ONE background refresh
});

test("background refresh replaces the snapshot once it completes", async () => {
  let t = 0;
  const { exec, calls } = fakeExec([{ value: DOC }, { value: DOC2 }]);
  const cache = createAnalysisCache({ exec, snapshotFile: tmpSnapshotFile(), now: () => t });
  await cache.get();
  t = 61_000;
  assert.equal((await cache.get()).raw, DOC); // stale served
  await settle(); // let the background refresh land
  const fresh = await cache.get();
  assert.equal(fresh.raw, DOC2);
  assert.equal(fresh.ageMs, 0);
  assert.equal(fresh.refreshing, false);
  assert.equal(fresh.lastError, null);
  assert.equal(calls.length, 2);
});

test("refresh failure retains last-good data and exposes lastError", async () => {
  let t = 0;
  const { exec } = fakeExec([{ value: DOC }, { error: new Error("boom") }, { value: DOC2 }]);
  const cache = createAnalysisCache({ exec, snapshotFile: tmpSnapshotFile(), now: () => t });
  await cache.get();
  t = 61_000;
  await cache.get(); // kicks the failing background refresh
  await settle();
  const r = await cache.get();
  assert.equal(r.raw, DOC); // last-good retained
  assert.equal(r.lastError, "boom");
  await settle(); // that ^ get() kicked refresh #3 (still stale) — let it succeed
  const healed = await cache.get();
  assert.equal(healed.raw, DOC2);
  assert.equal(healed.lastError, null); // success clears the error
});

test("cold failure with no snapshot rejects", async () => {
  const { exec } = fakeExec([{ error: new Error("no data") }]);
  const cache = createAnalysisCache({ exec, snapshotFile: tmpSnapshotFile() });
  await assert.rejects(() => cache.get(), /no data/);
});

test("unparseable analyze output is treated as a failure, not committed", async () => {
  let t = 0;
  const { exec } = fakeExec([{ value: DOC }, { value: "not json{{" }]);
  const cache = createAnalysisCache({ exec, snapshotFile: tmpSnapshotFile(), now: () => t });
  await cache.get();
  t = 61_000;
  await cache.get();
  await settle();
  const r = await cache.get();
  assert.equal(r.raw, DOC); // garbage output never replaces last-good
  assert.match(String(r.lastError), /JSON/i);
});

test("snapshot persists and is loaded on startup (instant first render)", async () => {
  const file = tmpSnapshotFile();
  let t = 5000;
  const first = fakeExec([{ value: DOC }]);
  const a = createAnalysisCache({ exec: first.exec, snapshotFile: file, now: () => t });
  await a.get();
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).raw, DOC);

  // A brand-new instance (server restart) serves the persisted snapshot with no spawn.
  const second = fakeExec([{ value: DOC2 }]);
  const b = createAnalysisCache({ exec: second.exec, snapshotFile: file, now: () => t + 1000 });
  const r = await b.get();
  assert.equal(second.calls.length, 0);
  assert.equal(r.raw, DOC);
  assert.equal(r.ageMs, 1000);
});

test("corrupt or invalid snapshot files are ignored without crashing", async () => {
  for (const garbage of [
    "not json at all {{{",
    JSON.stringify({ generatedAt: 1, raw: 42 }), // wrong raw type
    JSON.stringify({ generatedAt: 1, raw: "nested not-json{{" }), // raw itself unparseable
  ]) {
    const file = tmpSnapshotFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, garbage, { mode: 0o600 });
    const { exec, calls } = fakeExec([{ value: DOC }]);
    const cache = createAnalysisCache({ exec, snapshotFile: file, now: () => 0 });
    const r = await cache.get(); // recomputes instead of crashing
    assert.equal(r.raw, DOC);
    assert.equal(calls.length, 1);
  }
});

test("missing snapshot dir is fine — persist creates it", async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "aios-ac-")), "a", "b", "snap.json");
  const { exec } = fakeExec([{ value: DOC }]);
  const cache = createAnalysisCache({ exec, snapshotFile: file });
  await cache.get();
  assert.ok(existsSync(file));
});

test("timeout aborts the subprocess and reports a typed error", async () => {
  const { exec, calls } = fakeExec([{ hang: true }]);
  const cache = createAnalysisCache({
    exec,
    snapshotFile: tmpSnapshotFile(),
    timeoutMs: 25, // real timer, kept tiny
  });
  await assert.rejects(
    () => cache.get(),
    (err) => {
      assert.ok(err instanceof AnalyzeTimeoutError);
      assert.equal(err.code, "ANALYZE_TIMEOUT");
      return true;
    }
  );
  assert.equal(calls[0].aborted, true); // the child got the kill signal
  // and a later stale-style read still surfaces the failure
  await assert.rejects(() => cache.get()); // still cold — no last-good to serve
});

test("timeout during a stale refresh keeps last-good + sets lastError", async () => {
  let t = 0;
  const { exec, calls } = fakeExec([{ value: DOC }, { hang: true }]);
  const cache = createAnalysisCache({
    exec,
    snapshotFile: tmpSnapshotFile(),
    now: () => t,
    timeoutMs: 25,
  });
  await cache.get();
  t = 61_000;
  const stale = await cache.get(); // immediate, refresh runs in background
  assert.equal(stale.raw, DOC);
  await new Promise((r) => setTimeout(r, 60)); // let the 25ms timeout fire
  const r = await cache.get();
  assert.equal(r.raw, DOC);
  assert.match(String(r.lastError), /timed out/);
  assert.equal(calls[1].aborted, true);
});
