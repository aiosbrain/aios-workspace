// Asks store (AIO-167) — unit tests on the compiled store: fold semantics, validation/truncation,
// GC boundary, orphan detection, lock-staleness recovery, and the maintenance-safety contention
// proof (a parallel appender vs `compact` under the lock loses no line).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ASKS_STORE_REL,
  OPEN_SOFT_CAP,
  RESOLVED_GC_DAYS,
  appendCreate,
  appendCreateDeduped,
  appendOp,
  buildRecord,
  compact,
  detectOrphans,
  foldLines,
  hasOpenDuplicate,
  readAsks,
  withLock,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST_INDEX = pathToFileURL(path.join(ROOT, "dist", "operator-loop", "index.js")).href;
const DAY = 86_400_000;

function ws() {
  return mkdtempSync(path.join(tmpdir(), "asks-store-"));
}
function storeFile(root) {
  return path.join(root, ASKS_STORE_REL);
}
function writeRaw(root, lines) {
  const abs = storeFile(root);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, lines.join("\n") + "\n");
}

test("fold: create → open; resolve/orphan derive status + resolvedAt (in creation order)", () => {
  const root = ws();
  try {
    const a = appendCreate(root, { kind: "k", severity: "fyi", title: "A", source: "test" });
    const b = appendCreate(root, { kind: "k", severity: "blocker", title: "B", source: "test" });
    appendOp(root, "resolve", a.id, "2026-07-02T00:00:00.000Z");
    appendOp(root, "orphan", b.id, "2026-07-03T00:00:00.000Z");
    const { asks, warnings } = readAsks(root);
    assert.equal(warnings.length, 0);
    assert.deepEqual(
      asks.map((x) => [x.id, x.status, x.resolvedAt]),
      [
        [a.id, "resolved", "2026-07-02T00:00:00.000Z"],
        [b.id, "orphaned", "2026-07-03T00:00:00.000Z"],
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fold: duplicate create id — FIRST wins, second is a warning", () => {
  const root = ws();
  try {
    const rec = { v: 1, op: "create", ask: baseAsk({ id: "dup", title: "first" }) };
    const rec2 = { v: 1, op: "create", ask: baseAsk({ id: "dup", title: "second" }) };
    writeRaw(root, [JSON.stringify(rec), JSON.stringify(rec2)]);
    const { asks, warnings } = readAsks(root);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].title, "first");
    assert.ok(warnings.some((w) => w.reason === "duplicate-create-id"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fold: malformed / unknown-version / unknown-id ops are warnings, never silently dropped", () => {
  const root = ws();
  try {
    const good = { v: 1, op: "create", ask: baseAsk({ id: "x1" }) };
    writeRaw(root, [
      "{not json",
      JSON.stringify({ v: 2, op: "create", ask: baseAsk({ id: "x2" }) }),
      JSON.stringify({ v: 1, op: "resolve", id: "nope", at: "2026-07-02T00:00:00.000Z" }),
      JSON.stringify({ v: 1, op: "frobnicate" }),
      JSON.stringify(good),
    ]);
    const { asks, warnings } = readAsks(root);
    assert.equal(asks.length, 1);
    const reasons = warnings.map((w) => w.reason).sort();
    assert.deepEqual(reasons, [
      "malformed-json",
      "unknown-id-resolve",
      "unknown-op",
      "unknown-version",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write: severity enum + tier validated; title/body/kind normalized; newline-safe", () => {
  assert.throws(
    () => buildRecord({ kind: "k", severity: "nope", title: "t", source: "s" }),
    /invalid severity/
  );
  assert.throws(
    () => buildRecord({ kind: "k", severity: "fyi", title: "t", source: "s", tier: "public" }),
    /invalid tier/
  );
  const rec = buildRecord({
    kind: "  Weird Kind!! ",
    severity: "decision",
    title: "line one\nline two\t" + "x".repeat(400),
    body: "b".repeat(3000),
    source: "cli",
  });
  assert.equal(rec.kind, "weird-kind");
  assert.equal(rec.title.length, 200);
  assert.ok(!/[\n\t]/.test(rec.title), "title has no control chars");
  assert.equal(rec.body.length, 2000);
  assert.equal(rec.tier, "admin"); // default
  // A create line round-trips through NDJSON with an embedded newline in the body, still one line.
  const root = ws();
  try {
    appendCreate(root, { kind: "k", severity: "fyi", title: "hi", body: "a\nb", source: "test" });
    const raw = readFileSync(storeFile(root), "utf8").trimEnd();
    assert.equal(raw.split("\n").length, 1, "one physical line despite an embedded newline");
    const { asks, warnings } = readAsks(root);
    assert.equal(warnings.length, 0);
    assert.equal(asks[0].body, "a\nb");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hasOpenDuplicate: matches only OPEN asks; null key never dedupes", () => {
  const root = ws();
  try {
    const a = appendCreate(root, {
      kind: "k",
      severity: "fyi",
      title: "t",
      source: "s",
      dedupeKey: "K1",
    });
    assert.equal(hasOpenDuplicate(root, "K1"), true);
    assert.equal(hasOpenDuplicate(root, null), false);
    appendOp(root, "resolve", a.id, "2026-07-02T00:00:00.000Z");
    assert.equal(hasOpenDuplicate(root, "K1"), false, "resolved ask no longer dedupes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC 7-day boundary: compact drops closed asks older than the cutoff, keeps recent + open", () => {
  const root = ws();
  try {
    const now = new Date("2026-07-20T00:00:00.000Z");
    const old = appendCreate(root, { kind: "k", severity: "fyi", title: "old", source: "s" });
    const recent = appendCreate(root, { kind: "k", severity: "fyi", title: "recent", source: "s" });
    appendCreate(root, { kind: "k", severity: "fyi", title: "open", source: "s" });
    // old: closed 8 days ago (> 7) → GC'd; recent: closed 1 day ago (< 7) → kept.
    appendOp(root, "resolve", old.id, new Date(now.getTime() - 8 * DAY).toISOString());
    appendOp(root, "resolve", recent.id, new Date(now.getTime() - 1 * DAY).toISOString());
    const { removed } = compact(root, now);
    assert.equal(removed, 1);
    const { asks, warnings } = readAsks(root);
    assert.equal(warnings.length, 0, "compacted store folds cleanly");
    const titles = asks.map((a) => a.title).sort();
    assert.deepEqual(titles, ["open", "recent"]);
    // kept-but-closed retains its resolved status through the create+op rewrite.
    assert.equal(asks.find((a) => a.title === "recent").status, "resolved");
    assert.equal(RESOLVED_GC_DAYS, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectOrphans: missing transcript file OR open >14d with a sessionId", () => {
  const root = ws();
  try {
    const now = new Date("2026-07-20T00:00:00.000Z");
    const missing = appendCreate(root, {
      kind: "stop",
      severity: "fyi",
      title: "gone",
      source: "hook:stop",
      transcriptPath: path.join(root, "does-not-exist.jsonl"),
    });
    const stale = appendCreate(root, {
      kind: "idle",
      severity: "blocker",
      title: "old session",
      source: "hook:idle",
      sessionId: "s1",
      createdAt: new Date(now.getTime() - 20 * DAY).toISOString(),
    });
    const livePath = path.join(root, "live.jsonl");
    writeFileSync(livePath, "{}\n");
    appendCreate(root, {
      kind: "stop",
      severity: "fyi",
      title: "present",
      source: "hook:stop",
      transcriptPath: livePath,
    });
    const open = readAsks(root).asks.filter((a) => a.status === "open");
    const ids = detectOrphans(open, now).sort();
    assert.deepEqual(ids.sort(), [missing.id, stale.id].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock: a stale lockfile (mtime > 30s) is reclaimed, and the append still lands", () => {
  const root = ws();
  try {
    const abs = storeFile(root);
    mkdirSync(path.dirname(abs), { recursive: true });
    const lock = abs + ".lock";
    writeFileSync(lock, "99999 stale\n");
    const old = Date.now() / 1000 - 120;
    utimesSync(lock, old, old);
    const rec = appendCreate(root, {
      kind: "k",
      severity: "fyi",
      title: "after stale",
      source: "s",
    });
    assert.ok(rec.id);
    assert.equal(existsSync(lock), false, "lock released");
    assert.equal(readAsks(root).asks.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readAsks open count reflects the soft-cap surface the CLI warns on", () => {
  const root = ws();
  try {
    const lines = [];
    for (let i = 0; i <= OPEN_SOFT_CAP; i++)
      lines.push(
        JSON.stringify({ v: 1, op: "create", ask: baseAsk({ id: "c" + i, title: "t" + i }) })
      );
    writeRaw(root, lines);
    const open = readAsks(root).asks.filter((a) => a.status === "open").length;
    assert.equal(open, OPEN_SOFT_CAP + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MAINTENANCE SAFETY: a parallel appender vs repeated compaction loses no line, no corruption", async () => {
  const root = ws();
  try {
    // Seed so compact has something to rewrite from the first pass.
    appendCreate(root, { kind: "k", severity: "fyi", title: "seed", source: "s" });
    const appender = path.join(root, "appender.mjs");
    writeFileSync(
      appender,
      `const { appendCreate } = await import(${JSON.stringify(DIST_INDEX)});
const [root, n] = [process.argv[2], Number(process.argv[3])];
for (let i = 0; i < n; i++) appendCreate(root, { kind: "c", severity: "fyi", title: "x" + i, source: "test", dedupeKey: "hammer|" + i });
`
    );
    const N = 120;
    // Launch the appender child; hammer compact() while it runs. Yield to the event loop each
    // iteration (setImmediate) so the child's exit is observed — the appends run in a separate
    // process, so they genuinely race the in-process compaction (both honor the same lock).
    const child = execFileAsync("node", [appender, root, String(N)]);
    let compactions = 0;
    while (!child.done) {
      compact(root, new Date());
      compactions++;
      await new Promise((r) => setImmediate(r));
    }
    await child.promise;
    compact(root, new Date());

    const raw = readFileSync(storeFile(root), "utf8");
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line), `corrupt line: ${line}`);
    }
    const { asks, warnings } = readAsks(root);
    assert.equal(warnings.length, 0, "no malformed lines after contention");
    // seed + N hammered creates all survive (all recent → none GC'd), none lost to a rewrite race.
    assert.equal(asks.length, N + 1, `expected ${N + 1} asks, ran ${compactions} compactions`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────
function baseAsk(over = {}) {
  return {
    id: "id",
    dedupeKey: null,
    kind: "k",
    severity: "fyi",
    title: "t",
    body: "",
    ref: null,
    source: "test",
    sessionId: null,
    tailHash: null,
    transcriptPath: null,
    tier: "admin",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

// A tiny non-blocking child wrapper: exposes a `.done` flag the parent can spin on.
function execFileAsync(cmd, args) {
  const state = { done: false };
  state.promise = new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      state.done = true;
      code === 0 ? resolve() : reject(new Error(`appender exited ${code}: ${err}`));
    });
    p.on("error", reject);
  });
  return state;
}

// foldLines is exercised implicitly via readAsks; assert the pure entry point directly too.
test("foldLines is pure over a line array", () => {
  const line = JSON.stringify({ v: 1, op: "create", ask: baseAsk({ id: "p1" }) });
  const { asks, warnings } = foldLines([line, "", "  "]);
  assert.equal(asks.length, 1);
  assert.equal(warnings.length, 0);
});

test("appendCreateDeduped: suppresses an open duplicate, appends again once resolved", () => {
  const root = ws();
  try {
    const first = appendCreateDeduped(root, {
      kind: "c",
      severity: "fyi",
      title: "one",
      source: "test",
      dedupeKey: "k1",
    });
    assert.ok(first, "first write lands");
    const dup = appendCreateDeduped(root, {
      kind: "c",
      severity: "fyi",
      title: "two",
      source: "test",
      dedupeKey: "k1",
    });
    assert.equal(dup, null, "open duplicate suppressed under the lock");
    const noKey = appendCreateDeduped(root, {
      kind: "c",
      severity: "fyi",
      title: "three",
      source: "test",
    });
    assert.ok(noKey, "a keyless input never dedupes");
    appendOp(root, "resolve", first.id);
    const again = appendCreateDeduped(root, {
      kind: "c",
      severity: "fyi",
      title: "four",
      source: "test",
      dedupeKey: "k1",
    });
    assert.ok(again, "resolved asks no longer suppress the key");
    assert.equal(readAsks(root).asks.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withLock ownership token: reports reclaimed locks so rewrites can abort", () => {
  const root = ws();
  try {
    const lockPath = path.join(root, ASKS_STORE_REL) + ".lock";
    const observed = withLock(root, (ownsLock) => {
      const owned = ownsLock();
      writeFileSync(lockPath, "9999 someone-else 2020-01-01T00:00:00.000Z\n"); // simulate stale-reclaim
      return { owned, afterSteal: ownsLock() };
    });
    assert.equal(observed.owned, true, "holder owns its fresh lock");
    assert.equal(observed.afterSteal, false, "a rewritten lockfile is detected as reclaimed");
    assert.ok(existsSync(lockPath), "a reclaimed lock is not deleted by the previous holder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
