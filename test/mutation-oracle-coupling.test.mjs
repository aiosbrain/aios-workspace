// Pins for the two Ultraharden Batch 1 mutation-lane defects (split out of
// mutation-config.test.mjs to stay under the file-size cap):
// - AIO-994: the oracle-coupling guard — every calibrated mutate target must be
//   genuinely imported by a nightly oracle file, or the campaign scores 0.00
//   with every mutant surviving by construction.
// - AIO-534: the sole-denominator campaign split that closes the shotgun
//   bypass, plus its label-collision guard.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearStaleSplitReports,
  configFor,
  MUTATION_GROUPS,
  splitCampaigns,
} from "../scripts/run-mutation.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every calibrated target is imported by a nightly oracle file via a real import (AIO-994)", () => {
  // The 0.00 defect: the campaign mutated dist/operator-loop/inbox/capability.js while its kill
  // command ran a suite that never imported the module, so every mutant survived by
  // construction. Pin the coupling for EVERY calibrated floor: some nightly oracle file must
  // genuinely import each calibrated target, so a future cut or refactor that severs the
  // import fails HERE instead of surfacing as a silent all-survivors nightly. Match the actual
  // import statement (quoted specifier after `from`/`import(`/`require(`) — a plain
  // substring check is satisfiable by a comment that merely mentions the path.
  for (const group of MUTATION_GROUPS) {
    const targets = Object.entries(group.breakThresholdByTarget ?? {})
      .filter(([, threshold]) => threshold > 0)
      .map(([target]) => target);
    if (!targets.length) continue;
    assert.ok(
      group.nightlyTests?.length,
      `${group.name}: a calibrated floor needs a declared nightly oracle (nightlyTests)`
    );
    const sources = group.nightlyTests.map((entry) => readFileSync(path.join(ROOT, entry), "utf8"));
    for (const target of targets) {
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const importStatement = new RegExp(
        String.raw`(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*${escaped}["']`
      );
      assert.ok(
        sources.some((source) => importStatement.test(source)),
        `${group.name}: no nightlyTests file contains a real import of ${target} — an oracle that does not load the mutate target cannot kill any mutant (the AIO-994 defect)`
      );
    }
  }
});

test("a calibrated target always gets its own sole-denominator campaign (shotgun bypass closed)", () => {
  // RED (pre-AIO-534): main() built ONE campaign per group from every matched file, so a PR
  // touching capability.ts plus any second inbox file produced a mixed denominator and the
  // calibrated 90% floor collapsed to 0 — configFor still behaves that way for a mixed set:
  const group = MUTATION_GROUPS.find((entry) => entry.name === "inbox-authorization");
  const target = "dist/operator-loop/inbox/capability.js";
  const sibling = "dist/operator-loop/inbox/outbox.js";
  assert.equal(configFor(group, [target, sibling], false).thresholds.break, 0);
  // GREEN: the selection layer never hands configFor that mixed set. splitCampaigns() carves
  // the calibrated target into its own campaign with the floor armed, and the sibling into a
  // separate advisory campaign.
  const campaigns = splitCampaigns(group, [target, sibling]);
  assert.deepEqual(
    campaigns.map((campaign) => campaign.mutate),
    [[target], [sibling]]
  );
  const [calibrated, rest] = campaigns;
  assert.equal(configFor(group, calibrated.mutate, false, calibrated.label).thresholds.break, 90);
  assert.equal(configFor(group, rest.mutate, false, rest.label).thresholds.break, 0);
  // Distinct labels: the two campaigns must not clobber each other's config or report files.
  assert.notEqual(calibrated.label, rest.label);
  assert.equal(rest.label, "inbox-authorization");
  assert.equal(
    configFor(group, calibrated.mutate, false, calibrated.label).jsonReporter.fileName,
    `reports/mutation/${calibrated.label}.json`
  );
});

test("splitCampaigns fails loudly on duplicate labels from same-basename calibrated targets", () => {
  // Labels name .stryker-tmp/<label>.conf.json and reports/mutation/<label>.json;
  // a silent collision would clobber one campaign's config and report with the other's.
  const group = {
    name: "example",
    breakThresholdByTarget: {
      "dist/a/capability.js": 90,
      "dist/b/capability.js": 85,
    },
  };
  assert.throws(
    () => splitCampaigns(group, ["dist/a/capability.js", "dist/b/capability.js"]),
    /duplicate campaign labels/
  );
});

test("splitCampaigns keeps single-campaign selections under the plain group name", () => {
  const group = MUTATION_GROUPS.find((entry) => entry.name === "inbox-authorization");
  const target = "dist/operator-loop/inbox/capability.js";
  // Sole calibrated target (the nightly case): one campaign, stable label, floor armed via
  // configFor's sole-denominator rule — report/artifact paths do not change.
  assert.deepEqual(splitCampaigns(group, [target]), [
    { mutate: [target], label: "inbox-authorization" },
  ]);
  // A group with no calibrated targets is never split.
  const updateSafety = MUTATION_GROUPS.find((entry) => entry.name === "update-safety");
  assert.deepEqual(
    splitCampaigns(updateSafety, ["scripts/toolkit-merge.mjs", "scripts/update.mjs"]),
    [{ mutate: ["scripts/toolkit-merge.mjs", "scripts/update.mjs"], label: "update-safety" }]
  );
  assert.deepEqual(splitCampaigns(updateSafety, []), []);
});

test("clearStaleSplitReports deletes only the selected groups' split reports", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mutation-reports-"));
  const files = [
    "inbox-authorization--capability.json", // stale split report: goes
    "inbox-authorization.json", // main group report: stays
    "inbox-authorization--capability.txt", // not a report: stays
    "update-safety--merge.json", // other group not selected: stays
  ];
  for (const file of files) writeFileSync(path.join(dir, file), "{}");
  clearStaleSplitReports(["inbox-authorization", "inbox-authorization"], dir);
  assert.deepEqual(readdirSync(dir).sort(), [
    "inbox-authorization--capability.txt",
    "inbox-authorization.json",
    "update-safety--merge.json",
  ]);
  rmSync(dir, { recursive: true, force: true });
});
