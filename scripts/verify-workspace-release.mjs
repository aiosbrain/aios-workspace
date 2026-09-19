// Publish only the immutable Workspace tarball accepted by all full and MCP cells.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "aiosbrain/aios-workspace";
const CONTROLS = [
  "broken-bin",
  "missing-packaged-file",
  "failed-spec-eval",
  "missing-credential-source",
  "corrupt-migration-state",
  "wrong-adapter-result",
  "unknown-internal-error",
  "digest-tamper",
  "sentinel-scan-control",
].sort((a, b) => a.localeCompare(b));
const SECTIONS = [
  "fresh-install",
  "isolation-probes",
  "diagnostics",
  "configured-use",
  "linear-journey",
  "slack-journey",
  "migration-journey",
  "upgrade-journey",
  "current-upgrade-journey",
  "rollback-journey",
  "fault-controls",
  "cleanup",
];
const MCP_TOOLS = [
  "brain_status",
  "brain_search_evidence",
  "brain_query",
  "brain_pull_items",
  "brain_get_item",
  "brain_list_projects",
  "brain_list_tasks",
  "brain_list_decisions",
  "brain_stakeholders",
].sort();
function verifyMcpEvidence(section, platform, version) {
  assert.ok(section, "Missing packed MCP installer acceptance");
  assert.equal(section.toolkitVersion, version);
  assert.deepEqual(section.artifact, {
    name: "@aiosbrain/mcp",
    version: "0.2.1",
    closureFiles: 15,
    integrity:
      "sha512-+YNY05QMYyNwC56U3V5oFS7uKToSr9mTNGZeha1waq8grhB32WyHnluRnKS6mO4LKi8ueiEpI4H3xDknR5Pb1Q==",
  });
  assert.deepEqual(section.membership.team, MCP_TOOLS);
  assert.deepEqual(section.membership.external, [
    "brain_get_item",
    "brain_pull_items",
    "brain_query",
    "brain_search_evidence",
    "brain_status",
  ]);
  const hosts = ["claude-code", "codex", "cursor"];
  if (platform !== "linux") hosts.push("claude-desktop");
  hosts.sort();
  assert.deepEqual([...section.packaged.supportedHosts].sort(), hosts);
  assert.equal(
    section.packaged.tamperedArtifactRejected,
    true,
    "Installed decoder must reject corrupt pinned bytes"
  );
  assert.equal(section.packaged.nativeDependency, "koffi resolved in prefix");
  const c = section.cases;
  assert.equal(c.runningHost.selectedRunning, "refused AIOS_E_CONFLICT, no writes");
  assert.equal(c.runningHost.unselectedRunning, "not blocking");
  assert.equal(c.dryRun.treeUnchanged, true);
  assert.equal(c.dryRun.proposals, hosts.length);
  assert.deepEqual([...c.install.hosts].sort(), hosts);
  assert.equal(c.install.tier, "team");
  assert.equal(c.install.tools, 9);
  assert.equal(c.install.closureBytes, "identical to registry");
  assert.equal(c.install.nativeReplacement, true);
  assert.equal(c.install.unrelatedPreserved, true);
  assert.deepEqual(c.server, {
    launchedFrom: "neutral cwd",
    team: 9,
    external: 5,
    evidenceSearch: "ok",
  });
  assert.deepEqual(c.repeatAndStatus, {
    repeat: "unchanged",
    credentialSources: ["global-file", "environment"],
    hostLoading: "unverified",
  });
  assert.deepEqual(c.editedEntry, { install: "refused AIOS_E_CONFLICT", uninstall: "preserved" });
  assert.equal(c.uninstall.hostsRestored, hosts.length);
  assert.equal(c.uninstall.credentials, "preserved");
  assert.deepEqual(c.legacyUpgrade, {
    owned: "upgraded to 0.2.1, record rewritten, 0.1.1 artifact intact",
    edited: "refused AIOS_E_CONFLICT, untouched",
  });
  if (platform === "win32") {
    assert.equal(c.ownerOnlyAcl, true, "Native Windows owner-only ACL proof required");
    assert.deepEqual(c.onboarding, {
      skipped: "the workspace scaffolder is bash; Windows cells cover the installer only",
    });
  } else {
    assert.deepEqual(c.onboarding.accept, {
      offerShown: true,
      host: "claude-code",
      projectTarget: "--repo workspace",
      cwdUntouched: true,
    });
    assert.deepEqual(c.onboarding.decline, { offerShown: true, mcpWrites: 0 });
    for (const name of ["failedBrain", "personal"])
      assert.deepEqual(c.onboarding[name], { offerShown: false, mcpWrites: 0 });
  }
  assert.equal(section.realProfile, "stat fingerprint unchanged");
}

function readJson(file) {
  assert.ok(lstatSync(file).isFile(), "Release evidence must be a regular file");
  return JSON.parse(readFileSync(file, "utf8"));
}

export function verifyWorkspaceRelease({ directory, run, jobs, sha, version, ref }) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(ref, `refs/tags/v${version}`, "Exact stable version tag required");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(run.event, "workflow_dispatch", "PR acceptance is not release acceptance");
  assert.equal(run.path, ".github/workflows/package-acceptance.yml");
  assert.equal(run.repository.full_name, REPOSITORY);
  assert.equal(run.head_repository.full_name, REPOSITORY);
  assert.equal(run.head_sha, sha, "Dispatch workflow and release must bind the same commit");
  const requiredJobs = ["pack candidate"];
  for (const os of ["ubuntu-latest", "macos-latest"])
    for (const node of [22, 24, 26]) requiredJobs.push(`accept (${os}, Node ${node})`);
  for (const node of [22, 24, 26]) requiredJobs.push(`MCP accept (windows-latest, Node ${node})`);
  for (const name of requiredJobs) {
    const matches = jobs.filter((job) => job.name === name);
    assert.equal(matches.length, 1, `Exactly one job required: ${name}`);
    assert.equal(matches[0].head_sha, sha);
    assert.equal(matches[0].status, "completed");
    assert.equal(matches[0].conclusion, "success");
  }
  const candidateDir = path.join(directory, "package-candidate");
  const candidate = readJson(path.join(candidateDir, "manifest.json"));
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.candidateSha, sha);
  assert.equal(candidate.packageName, "@aiosbrain/aios");
  assert.equal(candidate.packageVersion, version);
  assert.match(candidate.tarball, /^[a-zA-Z0-9_.-]+\.tgz$/);
  const tarball = path.join(candidateDir, candidate.tarball);
  assert.ok(lstatSync(tarball).isFile());
  const bytes = readFileSync(tarball);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), candidate.sha256);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  for (const [os, platform] of [
    ["ubuntu-latest", "linux"],
    ["macos-latest", "darwin"],
    ["windows-latest", "win32"],
  ]) {
    for (const node of [22, 24, 26]) {
      const evidence = readJson(
        path.join(directory, `acceptance-evidence-${os}-node${node}`, "evidence.json")
      );
      assert.equal(evidence.schemaVersion, 1);
      assert.equal(evidence.candidateSha, sha);
      assert.equal(evidence.tarballSha256, candidate.sha256);
      assert.equal(evidence.packageName, candidate.packageName);
      assert.equal(evidence.packageVersion, version);
      assert.equal(evidence.ok, true);
      assert.deepEqual(evidence.sentinelHits, []);
      assert.equal(evidence.cell.platform, platform);
      assert.match(evidence.cell.node, new RegExp(String.raw`^v${node}\.`));
      const s = evidence.sections;
      verifyMcpEvidence(s["mcp-host-install"], platform, version);
      assert.equal(s.cleanup.state, "removed");
      assert.ok(Array.isArray(evidence.commands) && evidence.commands.length > 0);
      assert.equal(s["fresh-install"].verifiedSha256, candidate.sha256);
      assert.equal(s["fresh-install"].installedVersion, version);
      if (platform === "win32") {
        assert.equal(s["fresh-install"].escapingLinks, "none");
        assert.equal(s["fresh-install"].engineStrict, true);
        assert.equal(s["fresh-install"].actualCli, true);
        continue;
      }
      for (const section of SECTIONS) assert.ok(s[section], `Missing ${section}`);
      assert.equal(s.diagnostics.provenance.build.expectedGitHead, sha);
      assert.equal(s["isolation-probes"].ambientCredentials, "none");
      assert.equal(s["isolation-probes"].escapingLinks, "none");
      assert.equal(s["isolation-probes"].checkoutImports, "none");
      assert.equal(s["isolation-probes"].forbiddenTools, "none reachable");
      assert.equal(s.cleanup.state, "removed");
      const states = s["migration-journey"].states;
      assert.deepEqual(
        states.map((state) => state.interruptAt),
        ["discovered", "snapshotted", "staged", "validated", "committed"]
      );
      assert.ok(
        states.every(
          (state) =>
            state.actualCli === true &&
            state.exitCode === 86 &&
            state.resumed === true &&
            state.committed === true &&
            state.byteStable === true
        )
      );
      for (const key of [
        "actualCli",
        "configDriftRefused",
        "driftPreserved",
        "reconciledConfigRestored",
      ])
        assert.equal(s["rollback-journey"][key], true);
      assert.equal(s["rollback-journey"].restoredPackage, "@aiosbrain/aios@0.12.0");
      assert.equal(s["upgrade-journey"].candidateEngineStrict, true);
      assert.equal(s["upgrade-journey"].upgradedVersion, version);
      const currentUpgrade = s["current-upgrade-journey"];
      assert.equal(currentUpgrade.baseline, "@aiosbrain/aios@2.0.0");
      assert.equal(currentUpgrade.upgradedVersion, version);
      assert.equal(currentUpgrade.candidateSha, sha);
      for (const key of [
        "actualCli",
        "engineStrict",
        "customizationPreserved",
        "configPreserved",
        "repeatByteStable",
      ])
        assert.equal(currentUpgrade[key], true, `Current release upgrade missing: ${key}`);

      const controls = s["fault-controls"];
      assert.equal(controls.allRed, true);
      assert.deepEqual(
        controls.controls.map((c) => c.id).sort((a, b) => a.localeCompare(b)),
        CONTROLS
      );
      assert.ok(controls.controls.every((c) => c.red === true));
      assert.ok(Array.isArray(evidence.commands) && evidence.commands.length > 0);
    }
  }
  return { tarball, candidate, integrity };
}

// npm acknowledges an upload before publish-time scanning makes it readable.
// Retry only registry absence; never repeat the upload or soften an integrity failure.
export function verifyRegistryAvailability({ readIntegrity, expected, wait }) {
  const attempts = 41;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let integrity;
    try {
      integrity = readIntegrity();
    } catch (error) {
      let code;
      try {
        code = JSON.parse(String(error.stdout ?? "")).error?.code;
      } catch {
        /* Non-JSON npm errors are not evidence of temporary registry absence. */
      }
      if (code !== "E404") throw error;
      assert.ok(
        attempt < attempts,
        "Published package is still unavailable after bounded registry checks; do not republish"
      );
      wait(30_000);
      continue;
    }
    assert.equal(integrity, expected, "Registry bytes differ from accepted artifact");
    return;
  }
}

/** Publication orchestration; injected command runner permits offline no-publish verification. */
export function runWorkspaceRelease({
  env = process.env,
  platform = process.platform,
  root = process.cwd(),
  command = execFileSync,
  publish = false,
  wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  // This entrypoint belongs to the Ubuntu OIDC publisher. Verification above is portable.
  // Never discover release executables from an artifact-controlled search path.
  assert.equal(platform, "linux", "Run the publication entrypoint in its Ubuntu workflow");
  const npmCli = path.resolve(
    path.dirname(process.execPath),
    "../lib/node_modules/npm/bin/npm-cli.js"
  );
  assert.ok(lstatSync(npmCli).isFile(), "Pinned Node installation must carry npm");
  const id = env.WORKSPACE_ACCEPTANCE_RUN_ID;
  assert.match(id || "", /^\d+$/);
  const api = (endpoint) =>
    JSON.parse(command("/usr/bin/gh", ["api", endpoint], { encoding: "utf8", cwd: root }));
  const run = api(`repos/${REPOSITORY}/actions/runs/${id}`);
  const jobResponse = api(
    `repos/${REPOSITORY}/actions/runs/${id}/attempts/${run.run_attempt}/jobs?per_page=100`
  );
  assert.equal(
    jobResponse.total_count,
    jobResponse.jobs.length,
    "Do not silently truncate job evidence"
  );
  const sha = command("/usr/bin/git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    cwd: root,
  }).trim();
  const manifest = readJson(path.join(root, "package.json"));
  assert.equal(manifest.name, "@aiosbrain/aios");
  assert.equal(env.WORKSPACE_RELEASE_VERSION, manifest.version);
  const verified = verifyWorkspaceRelease({
    directory: env.WORKSPACE_RELEASE_ARTIFACTS,
    run,
    jobs: jobResponse.jobs,
    sha,
    version: manifest.version,
    ref: env.GITHUB_REF,
  });
  const packed = JSON.parse(
    command("/usr/bin/tar", ["-xOf", verified.tarball, "package/package.json"], {
      encoding: "utf8",
    })
  );
  for (const key of ["name", "version", "bin", "engines", "dependencies"])
    assert.deepEqual(packed[key], manifest[key], `Packed ${key} must match the release source`);
  if (publish) {
    command(
      process.execPath,
      [
        npmCli,
        "publish",
        verified.tarball,
        "--access",
        "public",
        "--provenance",
        "--ignore-scripts",
      ],
      { stdio: "inherit" }
    );
    verifyRegistryAvailability({
      expected: verified.integrity,
      wait,
      readIntegrity: () =>
        JSON.parse(
          command(
            process.execPath,
            [
              npmCli,
              "view",
              `@aiosbrain/aios@${manifest.version}`,
              "dist.integrity",
              "--json",
              "--prefer-online",
              "--fetch-retries=0",
            ],
            { encoding: "utf8", cwd: root, timeout: 15_000 }
          )
        ),
    });
  }
  return verified;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  console.log(
    JSON.stringify(runWorkspaceRelease({ publish: process.argv.includes("--publish") }), null, 2)
  );
