import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AIOS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "aios.mjs"
);
const NOW = "2026-07-02T00:00:00Z";

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [AIOS, ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}
function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-cliws-"));
  mkdirSync(path.join(root, "3-log"));
  return realpathSync(root);
}
function projects() {
  return mkdtempSync(path.join(tmpdir(), "aios-cliproj-"));
}
function writeSession(dir, slug, id, records) {
  const d = path.join(dir, slug);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, id + ".jsonl"),
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
const storeId = (root) => {
  const raw = readFileSync(path.join(root, "3-log", "time-log.md"), "utf8");
  const dataRow = raw
    .split("\n")
    .find((l) => l.startsWith("| ") && !/^\|\s*ID\s*\|/.test(l) && !/^\|-+/.test(l));
  return dataRow.split("|")[1].trim();
};

test("cli: capture → report → reconcile happy path", () => {
  const root = workspace();
  const proj = projects();
  writeSession(proj, "slug", "s1", block(root));

  const cap = run([
    "time",
    "capture",
    "--repo",
    root,
    "--projects-dir",
    proj,
    "--now",
    NOW,
    "--json",
  ]);
  assert.equal(cap.code, 0);
  const sum = JSON.parse(cap.stdout);
  assert.equal(sum.captured, 1);
  assert.equal(sum.written, 1);

  const rep = run(["time", "report", "--repo", root, "--now", NOW, "--json"]);
  assert.equal(rep.code, 0);
  const report = JSON.parse(rep.stdout);
  assert.equal(report.totalMin, 20);
  assert.equal(report.byTag[0].tag, "engineering");

  const id = storeId(root);
  const rec = run([
    "time",
    "reconcile",
    "--repo",
    root,
    "--id",
    id,
    "--set-tag",
    "research",
    "--confirm",
    "--json",
  ]);
  assert.equal(rec.code, 0);
  assert.deepEqual(JSON.parse(rec.stdout).updated, [id]);
  assert.match(
    readFileSync(path.join(root, "3-log", "time-log.md"), "utf8"),
    /research .*\| yes \|/
  );

  rmSync(root, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

test("cli: reconcile on a confirmed row errors (immutable) and does not write", () => {
  const root = workspace();
  const proj = projects();
  writeSession(proj, "slug", "s1", block(root));
  run(["time", "capture", "--repo", root, "--projects-dir", proj, "--now", NOW]);
  const id = storeId(root);
  run(["time", "reconcile", "--repo", root, "--id", id, "--confirm"]);

  const r = run(["time", "reconcile", "--repo", root, "--id", id, "--set-tag", "admin"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /confirmed and immutable/);

  rmSync(root, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

test("cli: reconcile unknown id errors, non-zero, no write", () => {
  const root = workspace();
  const r = run(["time", "reconcile", "--repo", root, "--id", "deadbeef00", "--confirm"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /no time row with id deadbeef00/);
  rmSync(root, { recursive: true, force: true });
});

test("cli: capture --dry-run writes nothing", () => {
  const root = workspace();
  const proj = projects();
  writeSession(proj, "slug", "s1", block(root));
  const r = run([
    "time",
    "capture",
    "--repo",
    root,
    "--projects-dir",
    proj,
    "--now",
    NOW,
    "--dry-run",
    "--json",
  ]);
  assert.equal(JSON.parse(r.stdout).captured, 1);
  const rep = JSON.parse(run(["time", "report", "--repo", root, "--now", NOW, "--json"]).stdout);
  assert.equal(rep.totalMin, 0); // nothing persisted
  rmSync(root, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

test("cli: malformed config errors clearly", () => {
  const root = workspace();
  const cfg = path.join(root, "bad-config.json");
  writeFileSync(cfg, "{ not valid json ");
  const r = run(["time", "capture", "--repo", root, "--config", cfg, "--now", NOW]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /time-config: invalid JSON/);
  rmSync(root, { recursive: true, force: true });
});

test("cli: no-spine workspace fails clearly", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-cli-nospine-"));
  const r = run(["time", "report", "--repo", root]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /no workspace spine/);
  rmSync(root, { recursive: true, force: true });
});
