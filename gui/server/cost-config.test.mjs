import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateCostConfigPatch,
  applyCostConfigPatch,
  editableCostConfig,
  readCostConfig,
  updateCostConfig,
} from "./cost-config.mjs";
import { detectClaudePlan, loadCostConfig } from "../../scripts/analyze/claude-plan.mjs";

function tmpRepo(initial) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "aios-cost-config-"));
  if (initial) {
    mkdirSync(path.join(repo, ".aios"), { recursive: true });
    writeFileSync(
      path.join(repo, ".aios", "cost-config.json"),
      JSON.stringify(initial, null, 2) + "\n"
    );
  }
  return repo;
}

test("validate rejects bad providers, months, and amounts", () => {
  assert.equal(validateCostConfigPatch({ subscriptions: { cursor: 20 } }).length, 0);
  assert.equal(
    validateCostConfigPatch({ metered: { anthropic: { "2026-07": 42.13, "2026-06": null } } })
      .length,
    0
  );
  assert.ok(validateCostConfigPatch(null).length);
  assert.ok(validateCostConfigPatch({ nope: 1 }).length);
  assert.ok(validateCostConfigPatch({ subscriptions: { anthropic: 5 } }).length); // metered-only provider
  assert.ok(validateCostConfigPatch({ subscriptions: { cursor: -1 } }).length);
  assert.ok(validateCostConfigPatch({ subscriptions: { cursor: "20" } }).length);
  assert.ok(validateCostConfigPatch({ subscriptions: { cursor: Infinity } }).length);
  assert.ok(validateCostConfigPatch({ metered: { claude: { "2026-07": 5 } } }).length); // subscription-only provider
  assert.ok(validateCostConfigPatch({ metered: { anthropic: { "2026-13": 5 } } }).length);
  assert.ok(validateCostConfigPatch({ metered: { anthropic: { July: 5 } } }).length);
  assert.ok(validateCostConfigPatch({ metered: { anthropic: 5 } }).length);
});

test("apply merges, deletes on null, and preserves unmanaged keys", () => {
  const existing = {
    claude: { plan: "max_20x", monthly_usd: 200, custom_note: "hand-added" },
    metered: { anthropic: { "2026-06": 10 } },
    some_future_key: true,
  };
  const next = applyCostConfigPatch(existing, {
    subscriptions: { cursor: 20, claude: 100 },
    metered: { anthropic: { "2026-07": 42.13 } },
  });
  assert.equal(next.subscriptions.cursor.monthly_usd, 20);
  // Claude writes BOTH the new shape and the legacy key claude-plan.mjs reads.
  assert.equal(next.subscriptions.claude.monthly_usd, 100);
  assert.equal(next.claude.monthly_usd, 100);
  assert.equal(next.claude.plan, "max_20x"); // untouched
  assert.equal(next.claude.custom_note, "hand-added"); // untouched
  assert.equal(next.metered.anthropic["2026-06"], 10); // prior month kept
  assert.equal(next.metered.anthropic["2026-07"], 42.13);
  assert.equal(next.some_future_key, true);
  assert.notEqual(next, existing); // pure — input not mutated
  assert.equal(existing.claude.monthly_usd, 200);

  // Nulls clear both claude keys and drop emptied month maps.
  const cleared = applyCostConfigPatch(next, {
    subscriptions: { claude: null },
    metered: { anthropic: { "2026-06": null, "2026-07": null } },
  });
  assert.equal(cleared.subscriptions.claude, undefined);
  assert.equal(cleared.claude.monthly_usd, undefined);
  assert.equal(cleared.claude.plan, "max_20x");
  assert.equal(cleared.metered, undefined);
});

test("updateCostConfig round-trips through the file and validates input", () => {
  const repo = tmpRepo();
  const bad = updateCostConfig(repo, { subscriptions: { cursor: "lots" } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length);

  const ok = updateCostConfig(repo, {
    subscriptions: { claude: 200, codex: 0 },
    metered: { anthropic: { "2026-07": 42.13 } },
  });
  assert.equal(ok.ok, true);
  const onDisk = JSON.parse(readFileSync(path.join(repo, ".aios", "cost-config.json"), "utf8"));
  assert.equal(onDisk.claude.monthly_usd, 200);
  assert.equal(onDisk.subscriptions.codex.monthly_usd, 0);
  assert.equal(onDisk.metered.anthropic["2026-07"], 42.13);
  assert.deepEqual(readCostConfig(repo), onDisk);
  rmSync(repo, { recursive: true, force: true });
});

test("pre-existing legacy config keeps working end-to-end (claude-plan.mjs)", () => {
  const legacy = { claude: { plan: "max_20x", monthly_usd: 200 } };
  const repo = tmpRepo(legacy);
  // The analyze CLI reader and the GUI reader see the same file.
  assert.deepEqual(loadCostConfig(repo), legacy);
  assert.deepEqual(readCostConfig(repo), legacy);
  // Legacy shape resolves in the editable view with no migration step.
  assert.equal(editableCostConfig(readCostConfig(repo)).subscriptions.claude, 200);

  // An unrelated GUI edit must not break the CLI's plan override.
  const updated = updateCostConfig(repo, { metered: { anthropic: { "2026-07": 9.5 } } });
  assert.equal(updated.ok, true);
  const plan = detectClaudePlan({ config: readCostConfig(repo), env: {} });
  assert.equal(plan.monthly_usd, 200);
  assert.equal(plan.source, "config");

  // A GUI subscription edit is what the CLI reads next time (legacy key updated).
  updateCostConfig(repo, { subscriptions: { claude: 100 } });
  const plan2 = detectClaudePlan({ config: loadCostConfig(repo), env: {} });
  assert.equal(plan2.monthly_usd, 100);
  assert.equal(plan2.source, "config");
  rmSync(repo, { recursive: true, force: true });
});

test("readCostConfig tolerates missing or corrupt files", () => {
  const repo = tmpRepo();
  assert.deepEqual(readCostConfig(repo), {});
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  writeFileSync(path.join(repo, ".aios", "cost-config.json"), "not json");
  assert.deepEqual(readCostConfig(repo), {});
  writeFileSync(path.join(repo, ".aios", "cost-config.json"), "[1,2]");
  assert.deepEqual(readCostConfig(repo), {});
  rmSync(repo, { recursive: true, force: true });
});

test("editableCostConfig sanitizes junk values", () => {
  const e = editableCostConfig({
    subscriptions: { cursor: { monthly_usd: "junk" }, codex: { monthly_usd: 5 } },
    metered: { anthropic: { "2026-07": 1.5, "bad-month": 2, "2026-08": -3 } },
  });
  assert.equal(e.subscriptions.cursor, null);
  assert.equal(e.subscriptions.codex, 5);
  assert.deepEqual(e.metered.anthropic, { "2026-07": 1.5 });
});
