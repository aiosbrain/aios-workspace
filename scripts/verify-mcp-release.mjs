// Verify an already accepted tarball. This command never packs or rebuilds it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function parseRegistryIntegrity(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) assert.equal(parsed.length, 1, "Expected one registry version");
  const integrity = Array.isArray(parsed) ? parsed[0] : parsed;
  assert.equal(typeof integrity, "string");
  assert.match(integrity, /^sha512-/);
  return integrity;
}

export function verifyMcpRelease({
  directory,
  run,
  sha,
  version,
  ref,
  repository = "aiosbrain/aios-workspace",
}) {
  assert.equal(run.conclusion, "success", "Acceptance workflow must have succeeded");
  assert.equal(run.status, "completed");
  assert.equal(run.event, "workflow_dispatch", "Release requires post-merge acceptance dispatch");
  assert.equal(run.path, ".github/workflows/mcp-package-acceptance.yml");
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.head_repository.full_name, repository);
  assert.equal(run.head_sha, sha, "Acceptance must name this exact release commit");
  assert.equal(run.head_branch, "main", "Release acceptance must run from merged main");
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(ref, `refs/tags/mcp-v${version}`, "MCP release requires its exact version tag");
  const candidate = JSON.parse(
    readFileSync(path.join(directory, "mcp-candidate/candidate.json"), "utf8")
  );
  assert.equal(candidate.candidateSha, sha);
  assert.equal(candidate.packageName, "@aiosbrain/mcp");
  assert.equal(candidate.version, version);
  assert.match(candidate.tarball, /^[a-zA-Z0-9_.-]+\.tgz$/);
  const tarball = path.join(directory, "mcp-candidate", candidate.tarball);
  const bytes = readFileSync(tarball);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), candidate.sha256);
  assert.equal(
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    candidate.integrity
  );
  for (const node of [22, 24, 26]) {
    const evidence = JSON.parse(
      readFileSync(path.join(directory, `mcp-package-evidence-node-${node}/evidence.json`), "utf8")
    );
    assert.equal(evidence.workspaceSha, sha);
    assert.ok(!evidence.error);
    assert.equal(evidence.runs.length, 1);
    const result = evidence.runs[0];
    assert.equal(result.mutation, "baseline");
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanup, true);
    assert.equal(result.isolation, "docker-no-checkout");
    assert.ok(result.groundedRequests > 0);
    assert.equal(result.candidate.sha256, candidate.sha256);
    assert.equal(result.candidate.integrity, candidate.integrity);
    assert.equal(result.candidate.candidateSha, sha);
  }
  return { tarball, candidate };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const directory = process.env.MCP_RELEASE_ARTIFACTS;
  const id = process.env.MCP_ACCEPTANCE_RUN_ID;
  assert.match(id || "", /^\d+$/);
  const run = JSON.parse(
    execFileSync("gh", ["api", `repos/aiosbrain/aios-workspace/actions/runs/${id}`], {
      encoding: "utf8",
    })
  );
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifest = JSON.parse(readFileSync("packages/mcp/package.json", "utf8"));
  assert.equal(process.env.MCP_RELEASE_VERSION, manifest.version);
  const verified = verifyMcpRelease({
    directory,
    run,
    sha,
    version: manifest.version,
    ref: process.env.GITHUB_REF,
  });
  if (process.argv.includes("--publish")) {
    execFileSync(
      "npm",
      ["publish", verified.tarball, "--access", "public", "--provenance", "--ignore-scripts"],
      { stdio: "inherit" }
    );
    const integrity = parseRegistryIntegrity(
      execFileSync(
        "npm",
        ["view", `@aiosbrain/mcp@${manifest.version}`, "dist.integrity", "--json"],
        { encoding: "utf8" }
      )
    );
    assert.equal(integrity, verified.candidate.integrity, "Published registry integrity mismatch");
  }
  console.log(JSON.stringify(verified, null, 2));
}
