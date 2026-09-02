#!/usr/bin/env node
/**
 * write-build-provenance.mjs — `prepack` hook: embed build.json into the tarball
 * (AIO-635 Decision 1). `{ sha, version, packedAt }` — the sha is the content identity a
 * registry-installed package stamps as a workspace's merge base (line 1 of a `pkg:`-source
 * `.aios-toolkit-version`), and what `aios provenance` reports as the expected build head.
 *
 * build.json is GITIGNORED but allowlisted in package.json `files`, so it ships in every
 * pack without ever dirtying the working tree — which keeps the RESET-5 clean-surface
 * barrier (test/package-acceptance/pack.mjs) honest: the packaged bytes still correspond
 * to HEAD, because this file is DERIVED from HEAD at pack time.
 *
 * Refuses to stamp when HEAD is unknown (not a git checkout): packing outside a checkout
 * would embed a lie. `AIOS_BUILD_SHA` overrides for hermetic build environments.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

let sha = process.env.AIOS_BUILD_SHA ?? null;
if (!sha) {
  try {
    sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    sha = null;
  }
}
if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
  console.error(
    "write-build-provenance: no HEAD sha available — packing outside a git checkout " +
      "requires AIOS_BUILD_SHA=<40-hex sha> to be set explicitly."
  );
  process.exit(1);
}

const body = `${JSON.stringify({ sha, version: pkg.version, packedAt: new Date().toISOString() }, null, 2)}\n`;
writeFileSync(path.join(root, "build.json"), body);
process.stderr.write(`build.json → ${sha.slice(0, 12)} v${pkg.version}\n`);
