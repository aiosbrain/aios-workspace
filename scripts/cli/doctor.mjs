import * as fs from "node:fs";
import path from "node:path";
import { createOutput } from "./output.mjs";
import { parseUserConfig, resolveUserConfigPath } from "./config-broker.mjs";
import { collectProvenance } from "./provenance.mjs";

function result(id, status, detail, remediation = null) {
  return { id, status, detail, remediation };
}

function availabilityResult(id, value) {
  return result(id, value == null ? "warn" : "pass", value ?? "unavailable");
}

function binModeResult(name, mode) {
  if (!Number.isInteger(mode)) return result(`bin-mode-${name}`, "warn", "unavailable");
  const executable = Boolean(mode & 0o111);
  return result(
    `bin-mode-${name}`,
    executable ? "pass" : "warn",
    `0${mode.toString(8)}${executable ? " executable" : " not executable"}`
  );
}

function driftResult(id, value, driftDetail, cleanDetail) {
  if (value == null) return result(id, "warn", "unavailable");
  return result(id, value ? "warn" : "pass", value ? driftDetail : cleanDetail);
}

export function collectDoctor(options = {}) {
  const env = options.env ?? process.env;
  const checks = [];
  let configPath;
  try {
    configPath = resolveUserConfigPath({ env, platform: options.platform, home: options.home });
    checks.push(result("config-path", "pass", configPath));
  } catch (error) {
    checks.push(result("config-path", "fail", error.code, error.remediation));
  }
  if (configPath) {
    try {
      parseUserConfig(fs.readFileSync(configPath, "utf8"));
      checks.push(result("user-config", "pass", "schemaVersion 2"));
    } catch (error) {
      const missing = error?.code === "ENOENT";
      checks.push(
        result(
          "user-config",
          missing ? "warn" : "fail",
          missing ? "not found" : (error.code ?? "AIOS_E_CONFIG_INVALID"),
          missing ? "Create config.json when a user default is needed." : error.remediation
        )
      );
    }
    const journal = `${configPath}.migration.json`;
    checks.push(
      result(
        "migration-journal",
        fs.existsSync(journal) ? "warn" : "pass",
        fs.existsSync(journal) ? journal : "none"
      )
    );
  }
  const provenance = options.provenance ?? collectProvenance(options);
  checks.push(availabilityResult("runtime", provenance.node));
  checks.push(availabilityResult("installation", provenance.installType));
  checks.push(
    result(
      "path-shadowing",
      provenance.path?.shadowed || !provenance.path?.candidates?.length ? "warn" : "pass",
      provenance.path?.candidates?.join(path.delimiter) || "not on PATH"
    )
  );
  for (const name of ["devtools", "linear", "slack"]) {
    checks.push(availabilityResult(`adapter-${name}`, provenance.adapters?.[name]));
  }
  for (const name of ["aios", "linear", "slack"]) {
    checks.push(binModeResult(name, provenance.binModes?.[name]));
  }
  checks.push(
    driftResult(
      "drift-working-tree",
      provenance.drift?.workingTreeDirty,
      "working tree dirty",
      "working tree clean"
    )
  );
  checks.push(
    driftResult(
      "drift-package-head",
      provenance.drift?.packageHeadMismatch,
      "package metadata does not match HEAD",
      "package metadata matches HEAD"
    )
  );
  return {
    schemaVersion: 1,
    command: "doctor",
    ok: !checks.some((check) => check.status === "fail"),
    checks,
  };
}

export function cmdDoctor(args) {
  const report = collectDoctor();
  const human = report.checks
    .map((check) => `${check.status.toUpperCase()} ${check.id}: ${check.detail}`)
    .join("\n");
  return createOutput({ json: args.includes("--json") }).success(report, human);
}
