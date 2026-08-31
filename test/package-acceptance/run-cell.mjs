#!/usr/bin/env node
/**
 * AIO-1071 package-acceptance cell runner (CLI-RESET-5): drives the full acceptance
 * lane against ONE digest-verified packed candidate.
 *
 *   verify digest → clean install → isolation probes → diagnostics semantics →
 *   configured use → mocked Linear/Slack journeys → migration interruption/repeat →
 *   registry-0.12.0 upgrade (stage-and-verify) → rollback → fault-injection controls →
 *   sentinel/evidence scan → evidence.json
 *
 * Usage:
 *   node test/package-acceptance/run-cell.mjs --artifact-dir <dir> [--evidence <dir>]
 *   node test/package-acceptance/run-cell.mjs --pack [--evidence <dir>]   # local leg
 *
 * `--pack` is the LOCAL single-cell convenience only: it invokes pack.mjs first, then
 * accepts the result exactly like a CI cell would. In the workflow, only the pack job
 * packs; every cell consumes the downloaded artifact.
 *
 * All child environments come from an explicit allowlist (empty HOME, engine-strict);
 * live provider credentials never participate — connector journeys are mocked with
 * synthetic sentinel credentials, and any sentinel appearing in output or evidence
 * fails the run.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubAmbientProcessEnv } from "../helpers/scrubbed-env.mjs";
import { CellContext, scanTextForSentinels } from "./lib/context.mjs";
import {
  configuredUseJourney,
  diagnosticsJourney,
  freshInstallJourney,
  isolationProbes,
} from "./lib/journeys-core.mjs";
import { linearJourney, slackJourney } from "./lib/journeys-connectors.mjs";
import { migrationJourney, rollbackJourney, upgradeJourney } from "./lib/journeys-lifecycle.mjs";
import { runFaultControls } from "./lib/faults.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  // The harness itself runs scrubbed: no ambient AIOS/Linear/Slack/dotenvx credential
  // can reach any child, assertion, or evidence line (AIO-1028 discipline).
  scrubAmbientProcessEnv();

  let artifactDir = arg("--artifact-dir");
  const base = mkdtempSync(path.join(tmpdir(), "aios-package-acceptance-"));
  if (!artifactDir && process.argv.includes("--pack")) {
    artifactDir = path.join(base, "artifact");
    execFileSync(process.execPath, [
      path.join(ROOT, "test", "package-acceptance", "pack.mjs"),
      ...["--out", artifactDir],
    ]);
  }
  if (!artifactDir) {
    console.error("usage: run-cell.mjs (--artifact-dir <dir> | --pack) [--evidence <dir>]");
    process.exit(2);
  }
  // Evidence must OUTLIVE the temporary work dir: `base` is removed during cleanup
  // before evidence is written, so a default beneath it would self-destruct. Without
  // --evidence, evidence lands in its own temp dir that cleanup never touches.
  const evidenceDir = path.resolve(
    arg("--evidence") ?? mkdtempSync(path.join(tmpdir(), "aios-package-acceptance-evidence-"))
  );

  const ctx = new CellContext({
    artifactDir: path.resolve(artifactDir),
    evidenceDir,
    checkoutRoot: ROOT,
    base,
  });

  // The cell must be testing the SHA the manifest names — never a drifted checkout.
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (head !== ctx.manifest.candidateSha) {
    throw new Error(
      `checkout HEAD ${head} != packed candidate ${ctx.manifest.candidateSha} — ` +
        "check out the candidate SHA before running the cell"
    );
  }

  let ok = false;
  let failure = null;
  try {
    const install = freshInstallJourney(ctx);
    isolationProbes(ctx, install);
    diagnosticsJourney(ctx, install);
    configuredUseJourney(ctx, install);
    linearJourney(ctx, install);
    slackJourney(ctx, install);
    await migrationJourney(ctx, install);
    const upgrade = upgradeJourney(ctx);
    await rollbackJourney(ctx, install, upgrade);
    await runFaultControls(ctx, install);

    if (ctx.sentinelHits.length > 0) {
      throw new Error(
        `secret sentinel leaked into command output: ${JSON.stringify(ctx.sentinelHits)}`
      );
    }
    ok = true;
  } catch (error) {
    failure = error;
  }

  let cleanupState = "removed";
  try {
    rmSync(base, { recursive: true, force: true });
  } catch (error) {
    cleanupState = `failed: ${error.message}`;
  }
  ctx.record("cleanup", { workDir: base, state: cleanupState });
  const evidenceFile = ctx.writeEvidence({ ok });
  // Defense in depth: the persisted evidence itself must carry no sentinel either.
  for (const name of readdirSync(evidenceDir)) {
    const hits = scanTextForSentinels(readFileSync(path.join(evidenceDir, name), "utf8"));
    if (hits.length > 0) {
      throw new Error(`sentinel leaked into evidence file ${name}: ${hits.join(",")}`);
    }
  }
  if (failure) {
    console.error(`package acceptance FAILED — evidence: ${evidenceFile}`);
    throw failure;
  }
  console.log(
    `package acceptance PASS — ${ctx.manifest.packageName}@${ctx.manifest.packageVersion} ` +
      `sha256=${ctx.manifest.sha256}\nevidence: ${evidenceFile}`
  );
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
