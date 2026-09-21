// Exercise the current published stamp-format-2 baseline separately from v1 migration.
import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runNpmInstall } from "./journeys-lifecycle.mjs";

// Snapshot the whole workspace (including every managed file and toolkit-bases blob/index).
// Only Git's internal index/hooks are excluded; only the stamp's synced-at line is masked.
// Completed updates must leave no migration journal/staged/snapshot recovery debris.
function workspaceBytes(root) {
  const rows = {};
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && name === ".git") continue;
      const file = path.join(dir, name);
      const rel = path.relative(root, file);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) rows[rel] = ["symlink", readlinkSync(file)];
      else if (stat.isDirectory()) {
        rows[rel] = ["directory"];
        visit(file);
      } else {
        let bytes = readFileSync(file);
        if (rel === ".aios-toolkit-version")
          bytes = Buffer.from(
            bytes.toString("utf8").replace(/^synced-at .+$/m, "synced-at MASKED")
          );
        rows[rel] = ["file", createHash("sha256").update(bytes).digest("hex")];
      }
    }
  }
  visit(root);
  assert.ok(
    Object.keys(rows).some((rel) => rel.startsWith(".aios/toolkit-bases/")),
    "base store is included"
  );
  for (const suffix of [".migration.json", ".last-known-good", ".staged"])
    assert.equal(
      existsSync(path.join(root, `.aios-toolkit-version${suffix}`)),
      false,
      "completed update cleared recovery debris"
    );
  return rows;
}

export function currentUpgradeJourney(ctx, stagedInstall) {
  ctx.verifyArtifactDigest();
  const root = path.join(ctx.base, "upgrade-current");
  const prefix = path.join(root, "live");
  const workspace = path.join(root, "workspace");
  const configDir = path.join(root, "config");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(prefix, "package.json"), '{"private":true}\n');
  runNpmInstall(ctx, {
    spec: "@aiosbrain/aios@2.0.0",
    cwd: prefix,
    label: "current-upgrade-install-2.0.0",
  });
  const pkgDir = path.join(prefix, "node_modules/@aiosbrain/aios");
  const packageVersion = () => JSON.parse(readFileSync(path.join(pkgDir, "package.json"))).version;
  assert.equal(packageVersion(), "2.0.0");
  ctx.runWithAmbientEnv(
    "bash",
    [
      path.join(pkgDir, "scripts/scaffold-project.sh"),
      "--context",
      "consultant",
      "--slug",
      "current-upgrade",
      "--owner",
      "alex",
      "--stakeholder",
      "Sample Co",
      "--team",
      "alex,sam",
      "--org",
      "your-github-org",
      "--currency",
      "USD",
      "--output",
      workspace,
    ],
    { label: "current-upgrade-scaffold-2.0.0" }
  );
  const stampPath = path.join(workspace, ".aios-toolkit-version");
  assert.match(readFileSync(stampPath, "utf8"), /^stamp-format 2$/m);
  const customPath = path.join(workspace, ".claude/rules/current-upgrade-custom.md");
  const custom = "# Local rule\n\nPreserve this current-release customization.\n";
  writeFileSync(customPath, custom);
  const yamlPath = path.join(workspace, "aios.yaml");
  const yaml = readFileSync(yamlPath, "utf8");
  ctx.runWithAmbientEnv("git", ["add", "-A"], { cwd: workspace, label: "current-upgrade-stage" });
  ctx.runWithAmbientEnv(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "customize current release workspace",
    ],
    { cwd: workspace, label: "current-upgrade-commit" }
  );
  const env = ctx.cliEnv({ AIOS_UPDATE_OFFLINE: "1", AIOS_CONFIG_DIR: configDir });
  // Stage-and-verify using the already accepted install before replacing the old package.
  ctx.run(
    process.execPath,
    [path.join(stagedInstall.pkgDir, "scripts/aios.mjs"), "update", "--repo", workspace],
    { cwd: workspace, env, label: "current-upgrade-update" }
  );
  assert.equal(readFileSync(customPath, "utf8"), custom);
  assert.equal(readFileSync(yamlPath, "utf8"), yaml);
  const stableStamp = () =>
    readFileSync(stampPath, "utf8").replace(/^synced-at .+$/m, "synced-at MASKED");
  const updatedStamp = stableStamp();
  assert.match(updatedStamp, /^stamp-format 2$/m);
  assert.ok(
    updatedStamp.includes(ctx.manifest.candidateSha),
    "stamp identifies the accepted source"
  );
  const beforeRepeat = workspaceBytes(workspace);
  runNpmInstall(ctx, { spec: ctx.tarball, cwd: prefix, label: "current-upgrade-replace-package" });
  assert.equal(packageVersion(), ctx.manifest.packageVersion);
  ctx.run(
    process.execPath,
    [path.join(pkgDir, "scripts/aios.mjs"), "update", "--repo", workspace],
    {
      cwd: workspace,
      env,
      label: "current-upgrade-repeat",
    }
  );
  assert.deepEqual(
    workspaceBytes(workspace),
    beforeRepeat,
    "repeat preserves all workspace and base-store bytes"
  );
  assert.equal(stableStamp(), updatedStamp);
  assert.equal(readFileSync(customPath, "utf8"), custom);
  assert.equal(readFileSync(yamlPath, "utf8"), yaml);
  ctx.record("current-upgrade-journey", {
    baseline: "@aiosbrain/aios@2.0.0",
    upgradedVersion: ctx.manifest.packageVersion,
    candidateSha: ctx.manifest.candidateSha,
    actualCli: true,
    engineStrict: true,
    customizationPreserved: true,
    configPreserved: true,
    repeatByteStable: true,
  });
}
