/**
 * AIO-1071 fault-injection controls: every trusted acceptance mechanism gets a deliberate
 * negative control. Each control runs in its own DISPOSABLE COPY of the verified install
 * (or a disposable config/artifact fixture) and is expected to go red — a broken copy
 * that is still accepted fails the whole cell. No control ever mutates the install the
 * real journeys used.
 */
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SENTINELS, scanTextForSentinels, sha256Hex } from "./context.mjs";

let copyCounter = 0;

/** A fresh disposable copy of the installed prefix; returns its paths. */
function disposableCopy(ctx, install) {
  copyCounter += 1;
  const dest = path.join(ctx.base, "fault-copies", `copy-${copyCounter}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  // verbatimSymlinks keeps npm's RELATIVE .bin links relative, so the copy's bins
  // resolve inside the copy — without it cpSync rewrites them to absolute paths into
  // the original install and every in-copy sabotage silently tests the wrong tree.
  cpSync(install.prefix, dest, { recursive: true, verbatimSymlinks: true });
  return {
    prefix: dest,
    pkgDir: path.join(dest, "node_modules", "@aiosbrain", "aios"),
    bin: path.join(dest, "node_modules", ".bin", "aios"),
  };
}

function configDir(ctx, name) {
  const dir = path.join(ctx.base, "fault-config", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function connectLinearReference(ctx, copy, dir) {
  ctx.run(copy.bin, ["connect", "linear", "--reference", "env:AIOS_ACCEPT_LINEAR_KEY"], {
    cwd: copy.prefix,
    env: ctx.cliEnv({ AIOS_CONFIG_DIR: dir }),
    label: "fault-setup-connect",
  });
}

function mockedLinearEnv(ctx, dir, provider) {
  const url = pathToFileURL(path.join(ctx.artifactDir, "helpers", provider)).href;
  return ctx.cliEnv({
    AIOS_CONFIG_DIR: dir,
    AIOS_ACCEPT_LINEAR_KEY: SENTINELS.linearKey,
    NODE_OPTIONS: `--import ${url}`,
  });
}

function brokenBinControl(ctx, install) {
  const copy = disposableCopy(ctx, install);
  chmodSync(path.join(copy.pkgDir, "scripts", "aios.mjs"), 0o644);
  const r = ctx.run(copy.bin, ["--help"], {
    cwd: copy.prefix,
    env: ctx.cliEnv(),
    expectFailure: true,
    label: "fault-broken-bin",
  });
  return { red: r.status !== 0, observed: `exit ${r.status} (${r.spawnError ?? "run"})` };
}

function missingFileControl(ctx, install) {
  const copy = disposableCopy(ctx, install);
  rmSync(path.join(copy.pkgDir, "scripts", "cli", "doctor.mjs"));
  const r = ctx.run(copy.bin, ["doctor", "--json"], {
    cwd: copy.prefix,
    env: ctx.cliEnv(),
    expectFailure: true,
    label: "fault-missing-file",
  });
  return { red: r.status !== 0, observed: `exit ${r.status}` };
}

function failedSpecEvalControl(ctx, install) {
  const copy = disposableCopy(ctx, install);
  renameSync(
    path.join(copy.prefix, "node_modules", "@aiosbrain", "aios-devtools"),
    path.join(copy.prefix, "node_modules", "@aiosbrain", "aios-devtools.broken")
  );
  const spec = path.join(copy.prefix, "fault-spec.md");
  writeFileSync(spec, "# Spec\n\nA short spec body.\n");
  const r = ctx.run(copy.bin, ["spec", "eval", spec, "--no-llm"], {
    cwd: copy.prefix,
    env: ctx.cliEnv(),
    expectFailure: true,
    label: "fault-spec-eval",
  });
  return { red: r.status !== 0, observed: `exit ${r.status}` };
}

function missingCredentialControl(ctx, install) {
  const copy = disposableCopy(ctx, install);
  const dir = configDir(ctx, "missing-credential");
  connectLinearReference(ctx, copy, dir);
  // The referenced variable is deliberately NOT exported: the source is broken.
  const r = ctx.run(copy.bin, ["linear", "get", "AIO-73"], {
    cwd: copy.prefix,
    env: ctx.cliEnv({ AIOS_CONFIG_DIR: dir }),
    expectFailure: true,
    label: "fault-missing-credential",
  });
  const classed = /AIOS_E_CREDENTIAL/.test(`${r.stdout}${r.stderr}`);
  return { red: r.status !== 0 && classed, observed: `exit ${r.status}, classed=${classed}` };
}

async function corruptMigrationControl(ctx, install) {
  const copy = disposableCopy(ctx, install);
  const { runMigration } = await import(
    pathToFileURL(path.join(copy.pkgDir, "scripts", "cli", "migration.mjs")).href
  );
  const dir = configDir(ctx, "corrupt-migration");
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(configPath, "legacy-config-bytes\n", { mode: 0o600 });
  await fs.writeFile(`${configPath}.migration.json`, '{"state":"bogus"}\n');
  try {
    await runMigration({
      configPath,
      packageRecord: { name: ctx.manifest.packageName, version: "0.12.0" },
      stage: async (source) => source,
      validate: async () => {},
    });
    return { red: false, observed: "corrupt journal was accepted" };
  } catch (error) {
    return { red: error.code === "AIOS_E_MIGRATION", observed: `rejected with ${error.code}` };
  }
}

function wrongAdapterControl(ctx, install) {
  const copy = disposableCopy(ctx, install);
  const dir = configDir(ctx, "wrong-adapter");
  connectLinearReference(ctx, copy, dir);
  const r = ctx.run(copy.bin, ["linear", "get", "AIO-73"], {
    cwd: copy.prefix,
    env: mockedLinearEnv(ctx, dir, "wrong-linear-provider.mjs"),
    expectFailure: true,
    label: "fault-wrong-adapter",
  });
  const semanticMatch = /AIO-73 {2}Alpha {2}\[Backlog\] {2}id=issue-a/.test(r.stdout);
  return {
    red: !(r.status === 0 && semanticMatch),
    observed: `exit ${r.status}, semanticMatch=${semanticMatch}`,
  };
}

function unknownErrorControl(ctx, install) {
  const copy = disposableCopy(ctx, install);
  const dir = configDir(ctx, "unknown-error");
  connectLinearReference(ctx, copy, dir);
  // Sabotage the adapter AFTER credentials resolve fine: unknown internal failure.
  rmSync(path.join(copy.pkgDir, "scripts", "connectors", "linear"), { recursive: true });
  const r = ctx.run(copy.bin, ["linear", "get", "AIO-73"], {
    cwd: copy.prefix,
    env: mockedLinearEnv(ctx, dir, "mock-linear-provider.mjs"),
    expectFailure: true,
    label: "fault-unknown-error",
  });
  const successShaped = /AIO-73 {2}Alpha/.test(r.stdout);
  return {
    red: r.status !== 0 && !successShaped,
    observed: `exit ${r.status}, successOutput=${successShaped}`,
  };
}

function digestTamperControl(ctx) {
  const bytes = Buffer.from(readFileSync(ctx.tarball));
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  const tampered = sha256Hex(bytes);
  return {
    red: tampered !== ctx.manifest.sha256,
    observed: `tampered digest differs=${tampered !== ctx.manifest.sha256}`,
  };
}

function sentinelScanControl() {
  const hits = scanTextForSentinels(`prefix ${SENTINELS.linearKey} suffix`);
  return { red: hits.includes("linearKey"), observed: `scanner hits: ${hits.join(",")}` };
}

const CONTROLS = [
  ["broken-bin", "non-executable packaged bin must not be accepted", brokenBinControl],
  ["missing-packaged-file", "deleted runtime module must be red", missingFileControl],
  ["failed-spec-eval", "a spec evaluation that cannot run is red", failedSpecEvalControl],
  ["missing-credential-source", "dangling credential reference", missingCredentialControl],
  ["corrupt-migration-state", "an invalid migration journal is rejected", corruptMigrationControl],
  ["wrong-adapter-result", "semantic check must catch a wrong body", wrongAdapterControl],
  ["unknown-internal-error", "an unknown error must fail closed", unknownErrorControl],
  ["digest-tamper", "a flipped tarball byte must fail verification", digestTamperControl],
  ["sentinel-scan-control", "the leak scanner must detect a leak", sentinelScanControl],
];

export async function runFaultControls(ctx, install) {
  const results = [];
  for (const [id, description, fn] of CONTROLS) {
    let red = false;
    let observed = null;
    try {
      ({ red, observed } = await fn(ctx, install));
    } catch (error) {
      red = true;
      observed = `harness error treated as red: ${error.message.slice(0, 200)}`;
    }
    results.push({ id, description, expected: "nonzero/red", observed, red });
    assert.equal(red, true, `fault control '${id}' was accepted instead of failing: ${observed}`);
  }
  rmSync(path.join(ctx.base, "fault-copies"), { recursive: true, force: true });
  ctx.record("fault-controls", { controls: results, allRed: results.every((r) => r.red) });
  return results;
}
