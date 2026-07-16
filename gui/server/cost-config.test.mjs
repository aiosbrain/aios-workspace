import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateCostConfigPatch,
  applyCostConfigPatch,
  editableCostConfig,
  readCostConfig,
  updateCostConfig,
  coerceUsd,
  configSubscriptionUsd,
} from "./cost-config.mjs";
import { buildCostsPayload } from "./costs.mjs";
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

  // Nulls clear ALL claude config keys (monthly_usd AND plan — a bare plan
  // still resolves to a "config" price in claude-plan.mjs) and drop emptied
  // month maps. Hand-added unmanaged keys survive.
  const cleared = applyCostConfigPatch(next, {
    subscriptions: { claude: null },
    metered: { anthropic: { "2026-06": null, "2026-07": null } },
  });
  assert.equal(cleared.subscriptions.claude, undefined);
  assert.equal(cleared.claude.monthly_usd, undefined);
  assert.equal(cleared.claude.plan, undefined);
  assert.equal(cleared.claude.custom_note, "hand-added");
  assert.equal(cleared.metered, undefined);
});

test("clearing the Claude entry cannot resurrect as owner-entered (reviewer repro)", () => {
  // Empirical scenario from PR #342 review: a config holding BOTH plan and
  // monthly_usd, cleared from the GUI, must fall back to auto-detection —
  // not keep showing $200 with "config"/owner-entered provenance forever.
  const repo = tmpRepo({ claude: { plan: "max_20x", monthly_usd: 200 } });
  const cleared = updateCostConfig(repo, { subscriptions: { claude: null } });
  assert.equal(cleared.ok, true);
  const onDisk = readCostConfig(repo);
  assert.equal(onDisk.claude, undefined); // both keys gone → container dropped

  // The CLI reader no longer resolves a "config"-sourced plan…
  const plan = detectClaudePlan({ config: onDisk, env: {} });
  assert.notEqual(plan.source, "config");
  // …the Settings surface shows blank…
  assert.equal(editableCostConfig(onDisk).subscriptions.claude, null);
  // …and the ledger shows the keychain-detected plan with HONEST provenance.
  const payload = buildCostsPayload(
    JSON.stringify({
      window: null,
      costs: {
        claude: { totals: { cost_usd: 1, events: 1 }, days: [] },
        plan: { provider: "claude", plan: "max_20x", monthly_usd: 200, source: "keychain" },
      },
    }),
    { config: onDisk, period: "2026-07" }
  );
  const line = payload.lines.find((l) => l.provider === "claude");
  assert.equal(line.source, "detected");
  assert.equal(payload.by_provider.find((b) => b.provider === "claude").status, "subscription");
  rmSync(repo, { recursive: true, force: true });
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

test("updateCostConfig writes atomically (rename, no temp remnants)", () => {
  const repo = tmpRepo({ claude: { monthly_usd: 200 } });
  const ok = updateCostConfig(repo, { metered: { anthropic: { "2026-07": 1.5 } } });
  assert.equal(ok.ok, true);
  const files = readdirSync(path.join(repo, ".aios"));
  assert.deepEqual(files, ["cost-config.json"]); // no .tmp left behind
  assert.equal(readCostConfig(repo).metered.anthropic["2026-07"], 1.5);
  rmSync(repo, { recursive: true, force: true });
});

test("ledger and Settings share one coercion — hand-edited strings survive (reviewer repro)", () => {
  // A hand-edited numeric string must be treated the same everywhere: counted
  // by the ledger, displayed by the form, and preserved across a save.
  const config = {
    subscriptions: { cursor: { monthly_usd: "200" } },
    metered: { anthropic: { "2026-07": "42.13" } },
  };
  assert.equal(coerceUsd("200"), 200);
  assert.equal(coerceUsd(" 42.13 "), 42.13);
  assert.equal(coerceUsd("junk"), null);
  assert.equal(coerceUsd(""), null);
  assert.equal(coerceUsd(-1), null);
  // Ledger read path…
  assert.equal(configSubscriptionUsd(config, "cursor"), 200);
  const payload = buildCostsPayload(JSON.stringify({ window: null, costs: {} }), {
    config,
    period: "2026-07",
  });
  assert.equal(payload.lines.find((l) => l.provider === "cursor").amount_usd, 200);
  assert.equal(payload.lines.find((l) => l.provider === "anthropic").amount_usd, 42.13);
  // …and the Settings hydration agree.
  const editable = editableCostConfig(config);
  assert.equal(editable.subscriptions.cursor, 200);
  assert.deepEqual(editable.metered.anthropic, { "2026-07": 42.13 });
  // A hydrated-form save round-trip preserves the value (as a number).
  const repo = tmpRepo(config);
  const saved = updateCostConfig(repo, {
    subscriptions: { cursor: editable.subscriptions.cursor },
    metered: { anthropic: { "2026-07": editable.metered.anthropic["2026-07"] } },
  });
  assert.equal(saved.ok, true);
  assert.equal(readCostConfig(repo).subscriptions.cursor.monthly_usd, 200);
  assert.equal(editableCostConfig(readCostConfig(repo)).subscriptions.cursor, 200);
  rmSync(repo, { recursive: true, force: true });
});

test("a bare claude.plan resolves like the CLI does (config price, editable, clearable)", () => {
  const config = { claude: { plan: "max_20x" } };
  // claude-plan.mjs maps a bare plan to its list price with source "config"…
  const plan = detectClaudePlan({ config, env: {} });
  assert.equal(plan.monthly_usd, 200);
  assert.equal(plan.source, "config");
  // …so the GUI readers must agree (Settings shows 200, not blank).
  assert.equal(configSubscriptionUsd(config, "claude"), 200);
  assert.equal(editableCostConfig(config).subscriptions.claude, 200);
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
