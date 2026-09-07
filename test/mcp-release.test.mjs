import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyMcpRelease } from "../scripts/verify-mcp-release.mjs";

test("release gate binds the exact tag, successful dispatch, three isolated cells and tarball bytes", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "mcp-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sha = "a".repeat(40);
  const bytes = Buffer.from("synthetic accepted artifact bytes");
  const candidate = {
    candidateSha: sha,
    packageName: "@aiosbrain/mcp",
    version: "0.1.0",
    tarball: "aiosbrain-mcp-0.1.0.tgz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  mkdirSync(path.join(directory, "mcp-candidate"));
  writeFileSync(path.join(directory, "mcp-candidate/candidate.json"), JSON.stringify(candidate));
  writeFileSync(path.join(directory, "mcp-candidate", candidate.tarball), bytes);
  const result = {
    mutation: "baseline",
    exitCode: 0,
    cleanup: true,
    isolation: "docker-no-checkout",
    groundedRequests: 1,
    candidate,
  };
  const evidence = { workspaceSha: sha, runs: [result] };
  for (const node of [22, 24, 26]) {
    mkdirSync(path.join(directory, `mcp-package-evidence-node-${node}`));
    writeFileSync(
      path.join(directory, `mcp-package-evidence-node-${node}/evidence.json`),
      JSON.stringify(evidence)
    );
  }
  const run = {
    conclusion: "success",
    status: "completed",
    event: "workflow_dispatch",
    path: ".github/workflows/mcp-package-acceptance.yml",
    repository: { full_name: "aiosbrain/aios-workspace" },
    head_repository: { full_name: "aiosbrain/aios-workspace" },
    head_sha: sha,
    head_branch: "main",
  };
  const args = { directory, run, sha, version: "0.1.0", ref: "refs/tags/mcp-v0.1.0" };
  assert.equal(verifyMcpRelease(args).candidate.sha256, candidate.sha256);
  for (const change of [
    { conclusion: "failure" },
    { head_branch: "feature/unmerged" },
    { event: "pull_request" },
    { head_sha: "b".repeat(40) },
    { path: ".github/workflows/unrelated.yml" },
    { head_repository: { full_name: "foreign/repo" } },
  ])
    assert.throws(() => verifyMcpRelease({ ...args, run: { ...run, ...change } }));
  assert.throws(() => verifyMcpRelease({ ...args, ref: "refs/heads/main" }));
  for (const change of [
    { cleanup: false },
    { exitCode: 1 },
    { isolation: "local-import-guard" },
    { groundedRequests: 0 },
    { candidate: { ...candidate, sha256: "wrong" } },
  ]) {
    writeFileSync(
      path.join(directory, "mcp-package-evidence-node-24/evidence.json"),
      JSON.stringify({ ...evidence, runs: [{ ...result, ...change }] })
    );
    assert.throws(() => verifyMcpRelease(args));
  }
  writeFileSync(
    path.join(directory, "mcp-package-evidence-node-24/evidence.json"),
    JSON.stringify(evidence)
  );
  writeFileSync(path.join(directory, "mcp-candidate", candidate.tarball), "changed artifact");
  assert.throws(() => verifyMcpRelease(args));
});
