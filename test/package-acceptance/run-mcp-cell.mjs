#!/usr/bin/env node
// Native Windows MCP acceptance consumes the same single tarball as the full cells.
// It makes no claim about the POSIX scaffold/migration journeys.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubAmbientProcessEnv } from "../helpers/scrubbed-env.mjs";
import { CellContext, findEscapingLinks } from "./lib/context.mjs";
import { executeCell } from "./run-cell.mjs";
import { mcpHostJourney } from "./lib/journeys-mcp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  scrubAmbientProcessEnv();
  assert.equal(process.platform, "win32", "This is the native Windows MCP lane");
  const artifactDir = arg("--artifact-dir");
  const evidenceDir = arg("--evidence");
  assert.ok(artifactDir && evidenceDir, "--artifact-dir and --evidence required");
  const ctx = new CellContext({
    artifactDir: path.resolve(artifactDir),
    evidenceDir: path.resolve(evidenceDir),
    checkoutRoot: ROOT,
    base: mkdtempSync(path.join(tmpdir(), "aios-mcp-acceptance-")),
  });
  await executeCell(ctx, {
    journey: async () => {
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim();
      assert.equal(head, ctx.manifest.candidateSha, "Checkout must match packed candidate");
      const verifiedSha256 = ctx.verifyArtifactDigest();
      const prefix = path.join(ctx.base, "install-prefix");
      mkdirSync(prefix, { recursive: true });
      writeFileSync(path.join(prefix, "package.json"), '{"private":true}\n');
      // Invoke npm's JavaScript through the selected Node, never a shell .cmd shim.
      const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
      assert.ok(existsSync(npmCli), "Selected Windows Node installation must contain npm");
      ctx.runWithAmbientEnv(
        process.execPath,
        [npmCli, "install", ctx.tarball, "--omit=optional", "--no-audit", "--no-fund"],
        { cwd: prefix, label: "fresh-install", timeout: 600_000 }
      );
      const pkgDir = path.join(prefix, "node_modules/@aiosbrain/aios");
      const installed = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      assert.equal(installed.name, ctx.manifest.packageName);
      assert.equal(installed.version, ctx.manifest.packageVersion);
      assert.deepEqual(findEscapingLinks(path.join(prefix, "node_modules"), prefix), []);
      const bin = path.join(pkgDir, "scripts/aios.mjs");
      assert.ok(existsSync(bin));
      const version = ctx.run(process.execPath, [bin, "--version"], {
        cwd: prefix,
        label: "installed-cli-version",
      });
      assert.ok(version.stdout.includes(installed.version));
      ctx.record("fresh-install", {
        verifiedSha256,
        installedVersion: installed.version,
        escapingLinks: "none",
        engineStrict: true,
        actualCli: true,
      });
      await mcpHostJourney(ctx, { prefix, pkgDir, bin });
    },
  });
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
