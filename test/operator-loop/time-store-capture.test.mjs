import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { capture, readStore, writeStore } from "../../dist/operator-loop/index.js";

const NOW = new Date("2026-07-02T00:00:00Z");

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-ws-"));
  mkdirSync(path.join(root, "3-log"));
  return realpathSync(root);
}
function projects() {
  return mkdtempSync(path.join(tmpdir(), "aios-proj-"));
}
function writeSession(projectsDir, slug, id, records) {
  const dir = path.join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, id + ".jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
}
const block = (cwd) => [
  {
    type: "user",
    timestamp: "2026-07-01T09:00:00Z",
    cwd,
    message: { role: "user", content: "hi" },
  },
  {
    type: "assistant",
    timestamp: "2026-07-01T09:20:00Z",
    cwd,
    message: { role: "assistant", content: [{ type: "tool_use", name: "Edit" }] },
  },
];

test("capture: derives a workspace block at team tier, idempotently", () => {
  const root = workspace();
  const proj = projects();
  writeSession(proj, "slug", "s1", block(root));

  const s1 = capture({ root, projectsDir: proj, now: NOW });
  assert.equal(s1.captured, 1);
  assert.equal(s1.written, 1);
  const rows = readStore(root).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, "team");
  assert.equal(rows[0].runtimeMin, 20);
  assert.equal(rows[0].confirmed, false);

  const s2 = capture({ root, projectsDir: proj, now: NOW });
  assert.equal(s2.written, 0); // no change on re-capture
  assert.equal(readStore(root).rows.length, 1);

  rmSync(root, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

test("capture: unknown repo (default exclude) is not captured", () => {
  const root = workspace();
  const proj = projects();
  const other = realpathSync(projects());
  writeSession(proj, "slug", "s1", block(other));

  const s = capture({ root, projectsDir: proj, now: NOW });
  assert.equal(s.captured, 0);
  assert.equal(s.excludedUnlisted, 1);
  assert.equal(readStore(root).rows.length, 0);

  rmSync(root, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

test("capture: confirmed rows are immutable across captures", () => {
  const root = workspace();
  const proj = projects();
  writeSession(proj, "slug", "s1", block(root));
  capture({ root, projectsDir: proj, now: NOW });

  const rows = readStore(root).rows;
  rows[0].confirmed = true;
  rows[0].tag = "strategy"; // a human correction
  writeStore(root, rows);

  capture({ root, projectsDir: proj, now: NOW }); // would re-derive tag "engineering"
  const after = readStore(root).rows;
  assert.equal(after.length, 1);
  assert.equal(after[0].confirmed, true);
  assert.equal(after[0].tag, "strategy"); // preserved

  rmSync(root, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

test("capture: --dry-run writes nothing (no store, no config)", () => {
  const root = workspace();
  const proj = projects();
  writeSession(proj, "slug", "s1", block(root));

  const s = capture({ root, projectsDir: proj, now: NOW, dryRun: true });
  assert.equal(s.dryRun, true);
  assert.equal(s.captured, 1);
  assert.equal(readStore(root).rows.length, 0);
  assert.equal(existsSync(path.join(root, ".aios/time-config.json")), false);

  rmSync(root, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

test("capture: no workspace spine throws a clear error", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-nospine-"));
  const proj = projects();
  assert.throws(() => capture({ root, projectsDir: proj, now: NOW }), /no workspace spine/);
  rmSync(root, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

test("store: mixed-tier rows round-trip through render/parse", () => {
  const root = workspace();
  writeStore(root, [
    {
      id: "aaa",
      startIso: "2026-07-01T09:00:00Z",
      endIso: "2026-07-01T09:20:00Z",
      repo: "aios-workspace",
      runtimeMin: 20,
      tag: "engineering",
      tier: "team",
      confirmed: false,
      taskRef: "AIO-139",
    },
    {
      id: "bbb",
      startIso: "2026-07-01T10:00:00Z",
      endIso: "2026-07-01T10:30:00Z",
      repo: "personal",
      runtimeMin: 30,
      tag: "admin",
      tier: "admin",
      confirmed: true,
      taskRef: "",
    },
  ]);
  const back = readStore(root).rows;
  assert.equal(back.length, 2);
  const byId = Object.fromEntries(back.map((r) => [r.id, r]));
  assert.equal(byId.aaa.tier, "team");
  assert.equal(byId.aaa.taskRef, "AIO-139");
  assert.equal(byId.bbb.tier, "admin");
  assert.equal(byId.bbb.confirmed, true);
  rmSync(root, { recursive: true, force: true });
});
