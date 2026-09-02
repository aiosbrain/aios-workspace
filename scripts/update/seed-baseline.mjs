#!/usr/bin/env node
/**
 * update/seed-baseline.mjs — scaffold-time v2 baseline seeding (AIO-635 Decisions 1/5).
 *
 * `scaffold-project.sh` invokes this right after writing its v1-shaped stamp. It rewrites
 * the stamp as FORMAT 2 and seeds `.aios/toolkit-bases/` with the toolkit's own content —
 * the exact 3-way merge base the first `aios update` needs. Without it, a workspace
 * scaffolded from a REGISTRY install (no git history to `git show` from) had no base at
 * all: every stamp-time-personalized managed file (RESOLVER.md from RESOLVER.md.tmpl)
 * surfaced a permanent `no-base` conflict on the very first update — the AIO-351 storm,
 * reproduced verbatim in the AIO-1072 migration-runbook rehearsal.
 *
 * Best-effort by contract: any failure leaves the scaffolder's v1 stamp in place (the
 * checkout flow still resolves bases via gitShow), and the caller ignores the exit code.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { resolveDistributionRoot } from "../cli.mjs";
import { toolkitMeta } from "../toolkit-meta.mjs";
import { managedPathsForConfig } from "../toolkit-manifest.mjs";
import { parseFlatYaml } from "../flat-yaml.mjs";
import { writeV2State } from "./registry-root.mjs";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repo = arg("--repo");
const from = arg("--from");
if (!repo || !from) {
  console.error("usage: seed-baseline.mjs --repo <workspace> --from <toolkit-root>");
  process.exit(2);
}

const root = resolveDistributionRoot(from);
if (!root || root.kind === "workspace" || !root.sha) {
  // No classifiable root or no content identity (a checkout with no git available):
  // keep the scaffolder's v1 stamp — the checkout flow still has gitShow.
  process.exit(0);
}
let cfg = {};
try {
  cfg = parseFlatYaml(readFileSync(path.join(repo, "aios.yaml"), "utf8"));
} catch {
  cfg = {};
}
const meta = toolkitMeta(root.dir);
const stampSource =
  root.kind === "registry" ? `pkg:@aiosbrain/aios@${meta.version}` : path.resolve(root.dir);
await writeV2State(repo, {
  srcDir: root.dir,
  sha: root.sha,
  meta,
  stampSource,
  managedPaths: managedPathsForConfig(cfg),
  packageVersion: meta.version,
});
process.stderr.write(`seeded v2 sync baseline (${root.kind}, ${root.sha.slice(0, 12)})\n`);
