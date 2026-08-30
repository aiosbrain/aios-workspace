import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDoctor } from "../scripts/cli/doctor.mjs";
import { classifyInstallType, collectProvenance } from "../scripts/cli/provenance.mjs";

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

    const subprocess = run("doctor", home);
    assert.equal(subprocess.status, 0, subprocess.stderr);
    const document = JSON.parse(subprocess.stdout);
    assert.equal(document.ok, false);
    assert.equal(
      document.checks.find((check) => check.id === "user-config").detail,
      "AIOS_E_CONFIG_INVALID"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor exposes stable adapter, bin-mode, and drift checks", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aios-doctor-conformance-"));
  const configDir = path.join(home, "config");
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "config.json"), '{"schemaVersion":2}\n');
    const report = collectDoctor({
      home,
      env: { AIOS_CONFIG_DIR: configDir },
      provenance: {
        node: "v24.0.0",
        installType: "registry",
        path: { candidates: ["/fixture/bin/aios"], shadowed: false },
        adapters: { devtools: "0.3.1", linear: null, slack: "^1.2.3" },
        binModes: { aios: 0o755, linear: null, slack: 0o644 },
        drift: { workingTreeDirty: true, packageHeadMismatch: false },
      },
    });
    const checks = new Map(report.checks.map((check) => [check.id, check]));

    assert.equal(checks.get("adapter-devtools").status, "pass");
    assert.equal(checks.get("adapter-linear").status, "warn");
    assert.equal(checks.get("adapter-slack").detail, "^1.2.3");
    assert.equal(checks.get("bin-mode-aios").status, "pass");
    assert.equal(checks.get("bin-mode-linear").status, "warn");
    assert.equal(checks.get("bin-mode-slack").status, "warn");
    assert.equal(checks.get("drift-working-tree").status, "warn");
    assert.equal(checks.get("drift-package-head").status, "pass");
    assert.equal(report.ok, true, "warnings remain non-fatal");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor warns when provenance evidence is unavailable without leaking config references", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aios-doctor-redaction-"));
  const configDir = path.join(home, "config");
  const reference = "env:DOCTOR_REFERENCE_MUST_NOT_LEAK";
  const resolvedValue = "doctor-resolved-value-must-not-leak";
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "config.json"),
      `${JSON.stringify({ schemaVersion: 2, credentialSources: { linear: reference } })}\n`
    );
    const report = collectDoctor({
      home,
      env: { AIOS_CONFIG_DIR: configDir, DOCTOR_REFERENCE_MUST_NOT_LEAK: resolvedValue },
      provenance: {
        node: null,
        installType: null,
        path: { candidates: [], shadowed: false },
        adapters: {},
        binModes: {},
        drift: { workingTreeDirty: null, packageHeadMismatch: null },
      },
    });
    const serialized = JSON.stringify(report);
    const checks = new Map(report.checks.map((check) => [check.id, check]));

    for (const id of [
      "runtime",
      "installation",
      "path-shadowing",
      "adapter-devtools",
      "adapter-linear",
      "adapter-slack",
      "bin-mode-aios",
      "bin-mode-linear",
      "bin-mode-slack",
      "drift-working-tree",
      "drift-package-head",
    ]) {
      assert.equal(checks.get(id).status, "warn", `${id} should warn`);
    }
    assert.doesNotMatch(serialized, /DOCTOR_REFERENCE_MUST_NOT_LEAK/);
    assert.equal(serialized.includes(resolvedValue), false);
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

test("provenance does not inherit Git drift from a registry install's parent checkout", () => {
  const consumer = mkdtempSync(path.join(tmpdir(), "aios-provenance-consumer-"));
  const installedRoot = path.join(consumer, "node_modules", "@aiosbrain", "aios");
  const installedBin = path.join(installedRoot, "scripts", "aios.mjs");
  try {
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: consumer, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "--quiet");
    writeFileSync(path.join(consumer, "tracked.txt"), "committed\n");
    git("add", "tracked.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture"
    );
    const consumerHead = git("rev-parse", "HEAD");
    writeFileSync(path.join(consumer, "tracked.txt"), "dirty\n");

    mkdirSync(path.dirname(installedBin), { recursive: true });
    writeFileSync(
      path.join(installedRoot, "package.json"),
      `${JSON.stringify({
        name: "@aiosbrain/aios",
        version: "fixture",
        bin: { aios: "scripts/aios.mjs" },
        aiosBuild: { gitHead: consumerHead },
      })}\n`
    );
    writeFileSync(installedBin, "#!/usr/bin/env node\n");

    const installed = collectProvenance({
      packageRoot: installedRoot,
      executable: installedBin,
      env: {},
      home: path.join(consumer, "home"),
      cwd: consumer,
    });
    assert.equal(installed.installType, "registry");
    assert.equal(installed.build.gitHead, null);
    assert.equal(installed.drift.workingTreeDirty, null);
    assert.equal(installed.drift.packageHeadMismatch, null);

    writeFileSync(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ name: "@aiosbrain/aios", version: "checkout-fixture" })}\n`
    );
    const checkout = collectProvenance({
      packageRoot: consumer,
      executable: installedBin,
      env: {},
      home: path.join(consumer, "home"),
      cwd: consumer,
    });
    assert.equal(checkout.installType, "checkout");
    assert.equal(checkout.build.gitHead, consumerHead);
    assert.equal(checkout.drift.workingTreeDirty, true);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("provenance classifies an npm-installed bin symlink as registry", () => {
  const root = path.join("/fixture", "node_modules", "@aiosbrain", "aios");
  assert.equal(
    classifyInstallType({
      packageRoot: root,
      packageName: "@aiosbrain/aios",
      executable: {
        path: path.join("/fixture", "node_modules", ".bin", "aios"),
        realpath: path.join(root, "scripts", "aios.mjs"),
        link: true,
      },
    }),
    "registry"
  );
});

test("provenance classifies a package root linked outside node_modules as link", () => {
  const root = path.join("/fixture", "linked-aios");
  assert.equal(
    classifyInstallType({
      packageRoot: root,
      packageName: "@aiosbrain/aios",
      executable: {
        path: path.join("/fixture", "node_modules", ".bin", "aios"),
        realpath: path.join(root, "scripts", "aios.mjs"),
        link: true,
      },
    }),
    "link"
  );
});

test("provenance preserves checkout classification ahead of bin-link evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-provenance-checkout-"));
  try {
    writeFileSync(path.join(root, ".git"), "gitdir: /fixture/worktree\n");
    assert.equal(
      classifyInstallType({
        packageRoot: root,
        packageName: "@aiosbrain/aios",
        executable: {
          path: path.join("/fixture", "node_modules", ".bin", "aios"),
          realpath: path.join(root, "scripts", "aios.mjs"),
          link: true,
        },
      }),
      "checkout"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provenance recognizes a Windows npm bin shim as a registry install", () => {
  assert.equal(
    classifyInstallType({
      packageRoot: String.raw`C:\fixture\node_modules\@aiosbrain\aios`,
      packageName: "@aiosbrain/aios",
      platform: "win32",
      executable: {
        path: String.raw`C:\fixture\node_modules\.bin\aios.cmd`,
        realpath: String.raw`C:\fixture\node_modules\.bin\aios.cmd`,
        link: false,
      },
    }),
    "registry"
  );
});
