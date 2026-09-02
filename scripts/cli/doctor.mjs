import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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
  // AIO-635 Decision-5 recovery visibility: when the cwd sits in a stamped workspace,
  // report the stamp format, base-store/index integrity, the stamp-migration journal
  // state, and rollback-record presence. Read-only; diagnostics never fail startup.
  checks.push(...workspaceStateChecks(options.cwd ?? process.cwd()));
  return {
    schemaVersion: 1,
    command: "doctor",
    ok: !checks.some((check) => check.status === "fail"),
    checks,
  };
}

function findWorkspaceRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "aios.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function workspaceStateChecks(cwd) {
  const checks = [];
  let ws = null;
  try {
    ws = findWorkspaceRoot(cwd);
  } catch {
    ws = null;
  }
  if (!ws) return checks;
  try {
    const stampPath = path.join(ws, ".aios-toolkit-version");
    if (!fs.existsSync(stampPath)) {
      checks.push(result("workspace-stamp", "warn", "no .aios-toolkit-version stamp"));
      return checks;
    }
    const raw = fs.readFileSync(stampPath, "utf8");
    const format = Number(raw.match(/^stamp-format (\d+)$/m)?.[1] ?? 1);
    checks.push(
      result(
        "workspace-stamp",
        "pass",
        `format ${format}`,
        format < 2 ? "Run `aios update` to upgrade to stamp format 2." : null
      )
    );
    const journal = `${stampPath}.migration.json`;
    if (fs.existsSync(journal)) {
      let state = "unreadable";
      try {
        state = JSON.parse(fs.readFileSync(journal, "utf8")).state ?? "unknown";
      } catch {
        state = "unreadable";
      }
      checks.push(
        result(
          "workspace-stamp-migration",
          "warn",
          `interrupted at '${state}'`,
          "Re-run `aios update` — re-entry resumes the journal and converges."
        )
      );
    } else {
      checks.push(result("workspace-stamp-migration", "pass", "none"));
    }
    checks.push(baseStoreCheck(ws, format));
    checks.push(
      result(
        "workspace-rollback-record",
        "pass",
        fs.existsSync(path.join(ws, ".aios", "rollback.json"))
          ? ".aios/rollback.json present (aios update --rollback available)"
          : "none recorded",
        null
      )
    );
  } catch (error) {
    checks.push(result("workspace-stamp", "warn", `unreadable (${error.code ?? "error"})`));
  }
  return checks;
}

function baseStoreCheck(ws, format) {
  const storeDir = path.join(ws, ".aios", "toolkit-bases");
  const indexPath = path.join(storeDir, "index.json");
  if (!fs.existsSync(indexPath)) {
    return result(
      "workspace-base-store",
      format >= 2 ? "warn" : "pass",
      format >= 2 ? "format-2 stamp but no base-store index" : "not seeded (v1 stamp)",
      format >= 2 ? "Run `aios update` to re-seed .aios/toolkit-bases." : null
    );
  }
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const entries = Object.entries(index.entries ?? {});
    let broken = 0;
    for (const [, entry] of entries) {
      try {
        const blob = fs.readFileSync(path.join(storeDir, entry.hash));
        if (createHash("sha256").update(blob).digest("hex") !== entry.hash) broken += 1;
      } catch {
        broken += 1;
      }
    }
    return result(
      "workspace-base-store",
      broken ? "warn" : "pass",
      broken
        ? `${broken}/${entries.length} base entries unreadable or corrupt`
        : `${entries.length} bases verified`,
      broken ? "Run `aios update` — the next apply rewrites the store." : null
    );
  } catch {
    return result(
      "workspace-base-store",
      "warn",
      "index.json unreadable",
      "Run `aios update` — the next apply rewrites the store."
    );
  }
}

export function cmdDoctor(args) {
  const report = collectDoctor();
  const human = report.checks
    .map((check) => `${check.status.toUpperCase()} ${check.id}: ${check.detail}`)
    .join("\n");
  return createOutput({ json: args.includes("--json") }).success(report, human);
}
