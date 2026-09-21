import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const sha = "a".repeat(40),
  version = "2.1.0";
function mcpFixture(platform) {
  const external = [
    "brain_get_item",
    "brain_pull_items",
    "brain_query",
    "brain_search_evidence",
    "brain_status",
  ];
  const team = [
    ...external,
    "brain_list_decisions",
    "brain_list_projects",
    "brain_list_tasks",
    "brain_stakeholders",
  ].sort();
  const hosts = ["claude-code", "codex", "cursor"];
  if (platform !== "linux") hosts.push("claude-desktop");
  return {
    toolkitVersion: version,
    artifact: {
      name: "@aiosbrain/mcp",
      version: "0.2.1",
      closureFiles: 15,
      integrity:
        "sha512-+YNY05QMYyNwC56U3V5oFS7uKToSr9mTNGZeha1waq8grhB32WyHnluRnKS6mO4LKi8ueiEpI4H3xDknR5Pb1Q==",
    },
    membership: { team, external },
    packaged: {
      tamperedArtifactRejected: true,
      files: 14,
      supportedHosts: hosts,
      nativeDependency: "koffi resolved in prefix",
    },
    cases: {
      runningHost: {
        selectedRunning: "refused AIOS_E_CONFLICT, no writes",
        unselectedRunning: "not blocking",
      },
      dryRun: { proposals: hosts.length, treeUnchanged: true },
      install: {
        hosts,
        tier: "team",
        tools: 9,
        closureBytes: "identical to registry",
        nativeReplacement: true,
        unrelatedPreserved: true,
      },
      server: { launchedFrom: "neutral cwd", team: 9, external: 5, evidenceSearch: "ok" },
      repeatAndStatus: {
        repeat: "unchanged",
        credentialSources: ["global-file", "environment"],
        hostLoading: "unverified",
      },
      editedEntry: { install: "refused AIOS_E_CONFLICT", uninstall: "preserved" },
      uninstall: { hostsRestored: hosts.length, credentials: "preserved" },
      legacyUpgrade: {
        owned: "upgraded to 0.2.1, record rewritten, 0.1.1 artifact intact",
        edited: "refused AIOS_E_CONFLICT, untouched",
      },
      ownerOnlyAcl: true,
      onboarding:
        platform === "win32"
          ? { skipped: "the workspace scaffolder is bash; Windows cells cover the installer only" }
          : {
              accept: {
                offerShown: true,
                host: "claude-code",
                projectTarget: "--repo workspace",
                cwdUntouched: true,
              },
              decline: { offerShown: true, mcpWrites: 0 },
              failedBrain: { offerShown: false, mcpWrites: 0 },
              personal: { offerShown: false, mcpWrites: 0 },
            },
    },
    realProfile: "stat fingerprint unchanged",
  };
}
export function setup(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "aios-release-verifier-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (rel, body) => {
    const file = path.join(directory, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  };
  const bytes = Buffer.from("synthetic tarball");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const candidate = {
    schemaVersion: 1,
    candidateSha: sha,
    packageName: "@aiosbrain/aios",
    packageVersion: version,
    sha256: digest,
    tarball: "candidate.tgz",
  };
  write("package-candidate/manifest.json", candidate);
  writeFileSync(path.join(directory, "package-candidate/candidate.tgz"), bytes);
  const jobs = [
    { name: "pack candidate", head_sha: sha, status: "completed", conclusion: "success" },
  ];
  for (const [os, platform] of [
    ["ubuntu-latest", "linux"],
    ["macos-latest", "darwin"],
    ["windows-latest", "win32"],
  ]) {
    for (const node of [22, 24, 26]) {
      jobs.push({
        name: `${platform === "win32" ? "MCP accept" : "accept"} (${os}, Node ${node})`,
        head_sha: sha,
        status: "completed",
        conclusion: "success",
      });
      write(`acceptance-evidence-${os}-node${node}/evidence.json`, {
        schemaVersion: 1,
        candidateSha: sha,
        tarballSha256: digest,
        packageName: candidate.packageName,
        packageVersion: version,
        ok: true,
        sentinelHits: [],
        cell: { node: `v${node}.0.0`, platform },
        commands: [{ status: 0 }],
        sections: {
          "fresh-install": {
            verifiedSha256: digest,
            installedVersion: version,
            escapingLinks: "none",
            engineStrict: true,
            actualCli: true,
          },
          "mcp-host-install": mcpFixture(platform),
          "isolation-probes": {
            ambientCredentials: "none",
            escapingLinks: "none",
            checkoutImports: "none",
            forbiddenTools: "none reachable",
          },
          diagnostics: { provenance: { build: { expectedGitHead: sha } } },
          "configured-use": {},
          "linear-journey": {},
          "slack-journey": {},
          "migration-journey": {
            states: ["discovered", "snapshotted", "staged", "validated", "committed"].map(
              (interruptAt) => ({
                interruptAt,
                actualCli: true,
                exitCode: 86,
                resumed: true,
                committed: true,
                byteStable: true,
              })
            ),
          },
          "upgrade-journey": { candidateEngineStrict: true, upgradedVersion: version },
          "current-upgrade-journey": {
            baseline: "@aiosbrain/aios@2.0.0",
            upgradedVersion: version,
            candidateSha: sha,
            actualCli: true,
            engineStrict: true,
            customizationPreserved: true,
            configPreserved: true,
            repeatByteStable: true,
          },
          "rollback-journey": {
            actualCli: true,
            configDriftRefused: true,
            driftPreserved: true,
            reconciledConfigRestored: true,
            restoredPackage: "@aiosbrain/aios@0.12.0",
          },
          cleanup: { state: "removed" },
          "fault-controls": {
            allRed: true,
            controls: [
              "broken-bin",
              "missing-packaged-file",
              "failed-spec-eval",
              "missing-credential-source",
              "corrupt-migration-state",
              "wrong-adapter-result",
              "unknown-internal-error",
              "digest-tamper",
              "sentinel-scan-control",
            ].map((id) => ({ id, red: true })),
          },
        },
      });
    }
  }
  return {
    directory,
    jobs,
    sha,
    version,
    ref: "refs/tags/v2.1.0",
    run: {
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      path: ".github/workflows/package-acceptance.yml",
      head_sha: sha,
      repository: { full_name: "aiosbrain/aios-workspace" },
      head_repository: { full_name: "aiosbrain/aios-workspace" },
    },
  };
}
export function mutateJson(directory, file, fn) {
  const p = path.join(directory, file),
    data = JSON.parse(readFileSync(p));
  fn(data);
  writeFileSync(p, JSON.stringify(data));
}
