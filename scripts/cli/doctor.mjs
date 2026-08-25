import * as fs from "node:fs";
import path from "node:path";
import { createOutput } from "./output.mjs";
import { parseUserConfig, resolveUserConfigPath } from "./config-broker.mjs";
import { collectProvenance } from "./provenance.mjs";

function result(id, status, detail, remediation = null) {
  return { id, status, detail, remediation };
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
  const provenance = collectProvenance(options);
  checks.push(result("runtime", "pass", provenance.node));
  checks.push(result("installation", "pass", provenance.installType));
  checks.push(
    result(
      "path-shadowing",
      provenance.path.shadowed ? "warn" : "pass",
      provenance.path.candidates.join(path.delimiter) || "not on PATH"
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
