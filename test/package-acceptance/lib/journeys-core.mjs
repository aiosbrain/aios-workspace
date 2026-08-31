/**
 * AIO-1071 core acceptance journeys: digest-verified install into a clean prefix,
 * isolation probes (forbidden tools, checkout imports, escaping links, ambient
 * credentials), diagnostic semantic-schema checks, and configured use (scaffold →
 * validate → offline status) — all driven from the INSTALLED tarball only.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isScrubbedName } from "../../helpers/scrubbed-env.mjs";
import { findEscapingLinks, probeForbiddenPathTools } from "./context.mjs";

/** Install the digest-verified tarball into a clean throwaway npm prefix. */
export function freshInstallJourney(ctx) {
  const digest = ctx.verifyArtifactDigest();
  const prefix = path.join(ctx.base, "install-prefix");
  mkdirSync(prefix, { recursive: true });
  writeFileSync(
    path.join(prefix, "package.json"),
    `${JSON.stringify({ name: "aios-acceptance-fixture", private: true }, null, 2)}\n`
  );
  ctx.run("npm", ["install", ctx.tarball, "--omit=optional", "--no-audit", "--no-fund"], {
    cwd: prefix,
    label: "fresh-install",
  });
  const pkgDir = path.join(prefix, "node_modules", "@aiosbrain", "aios");
  const bin = path.join(prefix, "node_modules", ".bin", "aios");
  const installed = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(installed.version, ctx.manifest.packageVersion, "installed version = manifest");
  for (const name of Object.keys(ctx.manifest.bin)) {
    assert.ok(
      existsSync(path.join(prefix, "node_modules", ".bin", name)),
      `npm exposed the ${name} bin`
    );
  }
  ctx.record("fresh-install", {
    verifiedSha256: digest,
    installedVersion: installed.version,
    bins: Object.keys(ctx.manifest.bin),
  });
  return { prefix, pkgDir, bin };
}

/** Probes that fail the cell if any developer-environment leakage can participate. */
export function isolationProbes(ctx, install) {
  const cliEnv = ctx.cliEnv();
  const forbiddenTools = probeForbiddenPathTools(cliEnv.PATH);
  assert.deepEqual(forbiddenTools, [], `forbidden tools reachable: ${forbiddenTools.join(", ")}`);

  const ambient = Object.keys(cliEnv).filter((name) => isScrubbedName(name));
  assert.deepEqual(ambient, [], `ambient credential variables leaked: ${ambient.join(", ")}`);

  const escapes = findEscapingLinks(path.join(install.prefix, "node_modules"), install.prefix);
  assert.deepEqual(escapes, [], `node_modules links escape the prefix: ${escapes.join(", ")}`);

  // Import-trace probe: the installed CLI's module graph must never touch the checkout.
  // The only checkout-adjacent file allowed is the probe preload itself (artifact copy).
  const probe = path.join(ctx.artifactDir, "helpers", "import-probe.mjs");
  const trace = path.join(ctx.base, "import-trace.txt");
  writeFileSync(trace, "");
  ctx.run(install.bin, ["doctor", "--json"], {
    cwd: install.prefix,
    env: ctx.cliEnv({
      AIOS_IMPORT_TRACE: trace,
      NODE_OPTIONS: `--import ${pathToFileURL(probe).href}`,
    }),
    label: "import-trace-doctor",
  });
  const checkoutUrl = pathToFileURL(ctx.checkoutRoot).href;
  const artifactUrl = pathToFileURL(ctx.artifactDir).href;
  const offenders = readFileSync(trace, "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((url) => url.startsWith(`${checkoutUrl}/`) && !url.startsWith(`${artifactUrl}/`));
  assert.deepEqual(offenders, [], `installed CLI imported from the checkout: ${offenders[0]}`);

  ctx.record("isolation-probes", {
    cliPath: cliEnv.PATH,
    forbiddenTools: "none reachable",
    ambientCredentials: "none",
    escapingLinks: "none",
    checkoutImports: "none",
  });
}

function parseJsonDocument(stdout, command) {
  assert.equal(stdout.trim().startsWith("{"), true, `${command} --json must emit JSON first`);
  const doc = JSON.parse(stdout);
  assert.equal(doc.schemaVersion, 1, `${command} schemaVersion`);
  assert.equal(doc.command, command, `${command} document identity`);
  return doc;
}

/** Semantic schema + stable-identity checks for help/version/doctor/provenance. */
export function diagnosticsJourney(ctx, install) {
  const configDir = path.join(ctx.base, "diag-config");
  mkdirSync(configDir, { recursive: true });
  const env = ctx.cliEnv({ AIOS_CONFIG_DIR: configDir });
  const results = {};

  const help = parseJsonDocument(
    ctx.run(install.bin, ["help", "--json"], { cwd: install.prefix, env, label: "help" }).stdout,
    "help"
  );
  const names = new Set(help.commands.map((c) => c.name));
  for (const required of ["help", "version", "doctor", "provenance", "linear", "slack"]) {
    assert.ok(names.has(required), `help must list '${required}'`);
  }
  results.help = { commands: help.commands.length };

  const version = parseJsonDocument(
    ctx.run(install.bin, ["version", "--json"], { cwd: install.prefix, env, label: "version" })
      .stdout,
    "version"
  );
  assert.ok(
    version.label.startsWith(`v${ctx.manifest.packageVersion} `),
    `version label '${version.label}' must carry v${ctx.manifest.packageVersion}`
  );
  assert.match(version.label, /brain-api \d+\.\d+/, "version label carries the contract version");
  results.version = { label: version.label };

  const doctor = parseJsonDocument(
    ctx.run(install.bin, ["doctor", "--json"], { cwd: install.prefix, env, label: "doctor" })
      .stdout,
    "doctor"
  );
  assert.equal(doctor.ok, true, "clean install must be doctor-ok");
  assert.ok(Array.isArray(doctor.checks) && doctor.checks.length >= 8, "doctor emits checks");
  for (const check of doctor.checks) {
    assert.ok(["pass", "warn", "fail"].includes(check.status), `check status ${check.status}`);
  }
  // Semantic negative: an invalid config file must flip ok=false (not merely warn).
  writeFileSync(path.join(configDir, "config.json"), "invalid config fixture\n");
  const sickDoctor = parseJsonDocument(
    ctx.run(install.bin, ["doctor", "--json"], { cwd: install.prefix, env, label: "doctor-sick" })
      .stdout,
    "doctor"
  );
  assert.equal(sickDoctor.ok, false, "invalid config must be reported");
  writeFileSync(path.join(configDir, "config.json"), '{"schemaVersion":2}\n');
  results.doctor = { cleanOk: doctor.ok, invalidConfigOk: sickDoctor.ok };

  const provenance = parseJsonDocument(
    ctx.run(install.bin, ["provenance", "--json"], {
      cwd: install.prefix,
      env,
      label: "provenance",
    }).stdout,
    "provenance"
  );
  assert.equal(provenance.installType, "registry", "tarball install classifies as registry");
  assert.equal(provenance.package.name, ctx.manifest.packageName);
  assert.equal(provenance.package.version, ctx.manifest.packageVersion);
  assert.equal(
    provenance.adapters.devtools,
    ctx.manifest.dependencies["@aiosbrain/aios-devtools"],
    "installed devtools must match the exact pin"
  );
  results.provenance = {
    installType: provenance.installType,
    adapters: provenance.adapters,
  };

  ctx.record("diagnostics", results);
}

/** Configured use: scaffold a synthetic workspace, validate, run offline status/push. */
export function configuredUseJourney(ctx, install) {
  const ws = path.join(ctx.base, "acceptance-ws");
  ctx.run(
    "bash",
    [
      path.join(install.pkgDir, "scripts", "scaffold-project.sh"),
      ...["--context", "consultant", "--slug", "acceptance-sample", "--owner", "alex"],
      ...["--stakeholder", "Sample Co", "--team", "alex,sam"],
      ...["--org", "your-github-org", "--currency", "USD", "--output", ws],
    ],
    { label: "scaffold" }
  );
  assert.ok(existsSync(path.join(ws, "aios.yaml")), "scaffold produced aios.yaml");
  ctx.run("bash", [path.join(install.pkgDir, "validation", "validate-all.sh"), ws, "--quick"], {
    label: "validate-quick",
  });
  const status = ctx.run(install.bin, ["status", "--repo", ws], { cwd: ws, label: "status" });
  assert.ok(status.stdout.length > 0, "aios status printed a report");
  ctx.run(install.bin, ["push", "--dry-run", "--repo", ws], { cwd: ws, label: "push-dry-run" });
  ctx.record("configured-use", {
    workspace: "scaffolded+validated",
    statusBytes: status.stdout.length,
  });
}
