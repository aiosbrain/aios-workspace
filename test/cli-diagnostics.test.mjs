import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDoctor } from "../scripts/cli/doctor.mjs";
import { collectProvenance } from "../scripts/cli/provenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const LOADER = path.join(ROOT, "test", "fixtures", "cli-import-blocker-loader.mjs");

function run(command, home) {
  return spawnSync(process.execPath, ["--experimental-loader", LOADER, CLI, command, "--json"], {
    cwd: home,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, AIOS_CONFIG_DIR: path.join(home, "config") },
  });
}

test("all diagnostics start through the canonical bin without the legacy or adapter graph", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aios-diagnostic-home-"));
  try {
    for (const command of ["help", "version", "doctor", "provenance"]) {
      const result = run(command, home);
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      const document = JSON.parse(result.stdout);
      assert.equal(document.command, command);
      assert.ok(result.stdout.trim().startsWith("{") && result.stdout.trim().endsWith("}"));
      assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret-value/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor reports invalid config as independent read-only data", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aios-doctor-invalid-"));
  const configDir = path.join(home, "config");
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "config.json"), "not json\n");
    const report = collectDoctor({ home, env: { AIOS_CONFIG_DIR: configDir } });
    assert.equal(report.ok, false);
    assert.equal(
      report.checks.find((check) => check.id === "user-config").detail,
      "AIOS_E_CONFIG_INVALID"
    );
    assert.equal(report.checks.find((check) => check.id === "runtime").status, "pass");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provenance reports observable drift instead of a constant clean claim", () => {
  const report = collectProvenance({ env: {}, home: "/fixture/home", cwd: "/fixture/workspace" });
  assert.ok([true, false, null].includes(report.drift.workingTreeDirty));
  assert.ok([true, false, null].includes(report.drift.packageHeadMismatch));
  assert.equal(report.build.expectedGitHead, null);
});
