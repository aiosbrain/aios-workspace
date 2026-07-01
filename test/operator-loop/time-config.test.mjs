import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseTimeConfig,
  loadTimeConfig,
  scopeRepo,
  defaultTimeConfig,
} from "../../dist/operator-loop/index.js";

test("parseTimeConfig rejects malformed configs (loud, never silent up-scope)", () => {
  assert.throws(() => parseTimeConfig(null), /must be a JSON object/);
  assert.throws(() => parseTimeConfig([]), /must be a JSON object/);
  assert.throws(() => parseTimeConfig({ default: "nope" }), /default must be/);
  assert.throws(() => parseTimeConfig({ idleGapMin: 0 }), /idleGapMin/);
  assert.throws(() => parseTimeConfig({ idleGapMin: -5 }), /idleGapMin/);
  assert.throws(() => parseTimeConfig({ repos: [] }), /repos must be an object/);
  assert.throws(() => parseTimeConfig({ repos: { "/x": { tier: "bogus" } } }), /tier must be/);
  assert.throws(
    () => parseTimeConfig({ repos: { "/x": { tier: "team", alias: 5 } } }),
    /alias must be a string/
  );
});

test("parseTimeConfig accepts a valid config", () => {
  const cfg = parseTimeConfig({
    default: "admin",
    idleGapMin: 15,
    repos: { "/x/y": { tier: "team", alias: "yy" } },
  });
  assert.equal(cfg.unknownDefault, "admin");
  assert.equal(cfg.idleGapMin, 15);
  const key = [...cfg.repos.keys()][0];
  assert.equal(cfg.repos.get(key).tier, "team");
  assert.equal(cfg.repos.get(key).alias, "yy");
});

test("loadTimeConfig returns safe defaults when the file is absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-time-cfg-"));
  const cfg = loadTimeConfig(dir);
  assert.equal(cfg.unknownDefault, "exclude");
  assert.equal(cfg.repos.size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("scopeRepo: basename collision does NOT up-scope unknown work", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "aios-time-scope-"));
  const dirA = path.join(tmp, "one", "app");
  const dirB = path.join(tmp, "two", "app");
  const dirC = path.join(tmp, "three", "app");
  for (const d of [dirA, dirB, dirC]) mkdirSync(d, { recursive: true });
  const A = realpathSync(dirA);
  const B = realpathSync(dirB);
  const C = realpathSync(dirC);

  const cfg = defaultTimeConfig(); // default exclude, no allowlist
  // current workspace realpath → captured team
  assert.deepEqual(scopeRepo(cfg, A, A), { capture: true, tier: "team", alias: "app" });
  // B shares basename "app" but is a different realpath and is not allowlisted → excluded
  assert.equal(scopeRepo(cfg, A, B).capture, false);

  // Only the current-workspace realpath OR an explicit allowlist entry may be captured.
  const cfg2 = parseTimeConfig({ default: "exclude", repos: { [B]: { tier: "external" } } });
  assert.equal(scopeRepo(cfg2, A, B).capture, true);
  assert.equal(scopeRepo(cfg2, A, B).tier, "external");
  assert.equal(scopeRepo(cfg2, A, C).capture, false); // still unknown → excluded

  rmSync(tmp, { recursive: true, force: true });
});

test("scopeRepo: unknown default admin captures at admin, never team", () => {
  const cfg = parseTimeConfig({ default: "admin" });
  const r = scopeRepo(cfg, "/ws", "/some/other/repo");
  assert.equal(r.capture, true);
  assert.equal(r.tier, "admin");
});

test("scopeRepo: config can force the current workspace to exclude or admin", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "aios-time-cws-"));
  const ws = realpathSync(tmp);
  assert.equal(
    scopeRepo(parseTimeConfig({ repos: { [ws]: { tier: "exclude" } } }), ws, ws).capture,
    false
  );
  assert.deepEqual(scopeRepo(parseTimeConfig({ repos: { [ws]: { tier: "admin" } } }), ws, ws), {
    capture: true,
    tier: "admin",
    alias: path.basename(ws),
  });
  rmSync(tmp, { recursive: true, force: true });
});

test("scopeRepo: a subdir of the workspace is attributed to it (containment)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "aios-time-sub-"));
  const ws = realpathSync(tmp);
  const sub = path.join(ws, "2-work");
  mkdirSync(sub, { recursive: true });
  const r = scopeRepo(defaultTimeConfig(), ws, realpathSync(sub));
  assert.equal(r.capture, true);
  assert.equal(r.tier, "team");
  rmSync(tmp, { recursive: true, force: true });
});

test("scopeRepo: null cwd is always excluded", () => {
  assert.equal(scopeRepo(parseTimeConfig({ default: "admin" }), "/ws", null).capture, false);
});
