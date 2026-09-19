import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  verifyWorkspaceRelease,
  runWorkspaceRelease,
} from "../scripts/verify-workspace-release.mjs";

const sha = "a".repeat(40),
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
function setup(t) {
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
function mutateJson(directory, file, fn) {
  const p = path.join(directory, file),
    data = JSON.parse(readFileSync(p));
  fn(data);
  writeFileSync(p, JSON.stringify(data));
}
const cell = "acceptance-evidence-macos-latest-node26/evidence.json";
test("requires six full cells and three Windows MCP cells bound to the same tarball", (t) => {
  const args = setup(t),
    result = verifyWorkspaceRelease(args);
  assert.equal(result.tarball, path.join(args.directory, "package-candidate/candidate.tgz"));
  assert.match(result.integrity, /^sha512-/);
});

for (const [name, mutate] of [
  [
    "lost current-release customization",
    (e) => {
      e.sections["current-upgrade-journey"].customizationPreserved = false;
    },
  ],
  [
    "current-release stamp names another candidate",
    (e) => {
      e.sections["current-upgrade-journey"].candidateSha = "b".repeat(40);
    },
  ],
  [
    "missing corrupt-artifact rejection",
    (e) => {
      delete e.sections["mcp-host-install"].packaged.tamperedArtifactRejected;
    },
  ],
  [
    "missing MCP journey",
    (e) => {
      delete e.sections["mcp-host-install"];
    },
  ],
  [
    "old server pin",
    (e) => {
      e.sections["mcp-host-install"].artifact.version = "0.1.1";
    },
  ],
  [
    "different server integrity",
    (e) => {
      e.sections["mcp-host-install"].artifact.integrity = "other";
    },
  ],
  [
    "missing evidence tool",
    (e) => {
      e.sections["mcp-host-install"].membership.team.splice(6, 1);
    },
  ],
  [
    "onboarding helper without completed flow",
    (e) => {
      e.sections["mcp-host-install"].cases.onboarding.accept.cwdUntouched = false;
    },
  ],
  [
    "no existing-file native replacement",
    (e) => {
      e.sections["mcp-host-install"].cases.install.nativeReplacement = false;
    },
  ],
  [
    "unverified old installer upgrade",
    (e) => {
      delete e.sections["mcp-host-install"].cases.legacyUpgrade;
    },
  ],
])
  test(`refuses ${name}`, (t) => {
    const args = setup(t);
    mutateJson(args.directory, cell, mutate);
    assert.throws(() => verifyWorkspaceRelease(args));
  });

for (const [name, mutate] of [
  [
    "Windows replaced by a non-native cell",
    (e) => {
      e.cell.platform = "linux";
    },
  ],
  [
    "Windows artifact mismatch",
    (e) => {
      e.tarballSha256 = "b".repeat(64);
    },
  ],
  [
    "missing owner-only ACL proof",
    (e) => {
      delete e.sections["mcp-host-install"].cases.ownerOnlyAcl;
    },
  ],
  [
    "Windows cleanup failed",
    (e) => {
      e.sections.cleanup.state = "failed";
    },
  ],
])
  test(`refuses ${name}`, (t) => {
    const args = setup(t);
    mutateJson(args.directory, "acceptance-evidence-windows-latest-node26/evidence.json", mutate);
    assert.throws(() => verifyWorkspaceRelease(args));
  });
for (const [name, mutate] of [
  [
    "branch instead of tag",
    (x) => {
      x.ref = "refs/heads/main";
    },
  ],
  [
    "wrong tag version",
    (x) => {
      x.ref = "refs/tags/v2.0.1";
    },
  ],
  [
    "PR run",
    (x) => {
      x.run.event = "pull_request";
    },
  ],
  [
    "foreign repository",
    (x) => {
      x.run.head_repository.full_name = "other/repo";
    },
  ],
  [
    "wrong workflow",
    (x) => {
      x.run.path = ".github/workflows/ci.yml";
    },
  ],
  [
    "different commit",
    (x) => {
      x.run.head_sha = "b".repeat(40);
    },
  ],
  [
    "cancelled run",
    (x) => {
      x.run.conclusion = "cancelled";
    },
  ],
  [
    "skipped cell",
    (x) => {
      x.jobs[1].conclusion = "skipped";
    },
  ],
  [
    "missing cell job",
    (x) => {
      x.jobs.pop();
    },
  ],
  [
    "substituted tarball",
    (x) => writeFileSync(path.join(x.directory, "package-candidate/candidate.tgz"), "different"),
  ],
  [
    "traversal tarball name",
    (x) =>
      mutateJson(x.directory, "package-candidate/manifest.json", (j) => {
        j.tarball = "../elsewhere.tgz";
      }),
  ],
  ["missing evidence", (x) => rmSync(path.join(x.directory, cell))],
  [
    "different digest",
    (x) =>
      mutateJson(x.directory, cell, (j) => {
        j.tarballSha256 = "b".repeat(64);
      }),
  ],
  [
    "wrong platform",
    (x) =>
      mutateJson(x.directory, cell, (j) => {
        j.cell.platform = "linux";
      }),
  ],
  [
    "wrong Node",
    (x) =>
      mutateJson(x.directory, cell, (j) => {
        j.cell.node = "v22.0.0";
      }),
  ],
  [
    "sentinel leak",
    (x) =>
      mutateJson(x.directory, cell, (j) => {
        j.sentinelHits = [{ sentinel: "linearKey" }];
      }),
  ],
  [
    "cleanup failed",
    (x) =>
      mutateJson(x.directory, cell, (j) => {
        j.sections.cleanup.state = "failed";
      }),
  ],
  [
    "control not red",
    (x) =>
      mutateJson(x.directory, cell, (j) => {
        j.sections["fault-controls"].controls[0].red = false;
      }),
  ],
  [
    "duplicated control",
    (x) =>
      mutateJson(x.directory, cell, (j) => {
        j.sections["fault-controls"].controls[0].id = "digest-tamper";
      }),
  ],
  [
    "missing migration",
    (x) =>
      mutateJson(x.directory, cell, (j) => {
        delete j.sections["migration-journey"];
      }),
  ],
])
  test(`refuses ${name} before publication`, (t) => {
    const args = setup(t);
    mutate(args);
    assert.throws(() => verifyWorkspaceRelease(args));
  });

for (const [name, mutate] of [
  [
    "helper-only migration",
    (s) => {
      s["migration-journey"].states[0].actualCli = false;
    },
  ],
  [
    "missing committed crash",
    (s) => {
      s["migration-journey"].states.pop();
    },
  ],
  [
    "missing config drift refusal",
    (s) => {
      s["rollback-journey"].configDriftRefused = false;
    },
  ],
])
  test(`refuses ${name}`, (t) => {
    const args = setup(t);
    mutateJson(args.directory, cell, (e) => mutate(e.sections));
    assert.throws(() => verifyWorkspaceRelease(args));
  });

function orchestrationFixture(t) {
  const args = setup(t);
  const source = {
    name: "@aiosbrain/aios",
    version,
    bin: { aios: "scripts/aios.mjs" },
    engines: { node: "22.x || 24.x || 26.x" },
    dependencies: {},
  };
  writeFileSync(path.join(args.directory, "package.json"), JSON.stringify(source));
  const expected = verifyWorkspaceRelease(args);
  const calls = [];
  const command = (executable, argv) => {
    calls.push([executable, ...argv]);
    if (executable === "/usr/bin/gh")
      return JSON.stringify(
        argv[1].includes("/jobs?")
          ? { total_count: args.jobs.length, jobs: args.jobs }
          : { ...args.run, run_attempt: 2 }
      );
    if (executable === "/usr/bin/git") return sha;
    if (executable === "/usr/bin/tar") return JSON.stringify(source);
    if (executable === process.execPath && argv[1] === "publish") return "";
    if (executable === process.execPath && argv[1] === "view")
      return JSON.stringify(expected.integrity);
    throw new Error("Unexpected release command");
  };
  return {
    args,
    source,
    expected,
    calls,
    options: {
      platform: "linux",
      root: args.directory,
      env: {
        WORKSPACE_ACCEPTANCE_RUN_ID: "123",
        WORKSPACE_RELEASE_ARTIFACTS: args.directory,
        WORKSPACE_RELEASE_VERSION: version,
        GITHUB_REF: args.ref,
      },
      command,
    },
  };
}

test("publication orchestration verifies the latest attempt and never publishes in verification mode", (t) => {
  const f = orchestrationFixture(t);
  assert.deepEqual(runWorkspaceRelease(f.options), f.expected);
  assert.ok(f.calls.some((c) => c[2]?.includes("/attempts/2/jobs?")));
  assert.ok(f.calls.every((c) => c[0] !== process.execPath));
});

test("publication orchestration passes only the accepted bytes to npm and checks registry integrity", (t) => {
  const f = orchestrationFixture(t);
  runWorkspaceRelease({ ...f.options, publish: true });
  const publishCalls = f.calls.filter((c) => c[0] === process.execPath && c[2] === "publish");
  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0][3], f.expected.tarball);
  assert.ok(publishCalls[0].includes("--ignore-scripts"));
  assert.ok(publishCalls[0].includes("--provenance"));
  assert.ok(f.calls.some((c) => c[0] === process.execPath && c[2] === "view"));
});

test("packed metadata mismatch refuses publication before npm runs", (t) => {
  const f = orchestrationFixture(t);
  const command = (exe, args) =>
    exe === "/usr/bin/tar"
      ? JSON.stringify({ ...f.source, version: "9.0.0" })
      : f.options.command(exe, args);
  assert.throws(
    () => runWorkspaceRelease({ ...f.options, command, publish: true }),
    /Packed version/
  );
  assert.ok(f.calls.every((c) => c[0] !== process.execPath));
});

test("registry integrity mismatch cannot return success after the simulated publish", (t) => {
  const f = orchestrationFixture(t);
  const command = (exe, args) =>
    exe === process.execPath && args[1] === "view"
      ? JSON.stringify("wrong")
      : f.options.command(exe, args);
  assert.throws(
    () => runWorkspaceRelease({ ...f.options, command, publish: true }),
    /Registry bytes differ/
  );
});

test("accepted upload polls processing 404 without a second publish", (t) => {
  const f = orchestrationFixture(t);
  let reads = 0;
  const waits = [];
  const command = (exe, args) => {
    if (exe === process.execPath && args[1] === "view" && ++reads <= 2)
      throw Object.assign(new Error("processing"), {
        stdout: JSON.stringify({ error: { code: "E404" } }),
      });
    return f.options.command(exe, args);
  };
  runWorkspaceRelease({ ...f.options, command, wait: (ms) => waits.push(ms), publish: true });
  assert.equal(reads, 3);
  assert.deepEqual(waits, [30000, 30000]);
  assert.equal(f.calls.filter((c) => c[2] === "publish").length, 1);
});

test("registry absence exhausts bounded checks without republishing", (t) => {
  const f = orchestrationFixture(t);
  let reads = 0;
  let waits = 0;
  const command = (exe, args) => {
    if (exe === process.execPath && args[1] === "view") {
      reads++;
      throw Object.assign(new Error("processing"), {
        stdout: JSON.stringify({ error: { code: "E404" } }),
      });
    }
    return f.options.command(exe, args);
  };
  assert.throws(
    () => runWorkspaceRelease({ ...f.options, command, wait: () => waits++, publish: true }),
    /still unavailable.*do not republish/
  );
  assert.equal(reads, 41);
  assert.equal(waits, 40);
  assert.equal(f.calls.filter((c) => c[2] === "publish").length, 1);
});

test("registry authentication failure is not retried as processing", (t) => {
  const f = orchestrationFixture(t);
  const failure = Object.assign(new Error("auth"), {
    stdout: JSON.stringify({ error: { code: "E401" } }),
  });
  const command = (exe, args) => {
    if (exe === process.execPath && args[1] === "view") throw failure;
    return f.options.command(exe, args);
  };
  assert.throws(
    () =>
      runWorkspaceRelease({
        ...f.options,
        command,
        wait: () => assert.fail("must not wait"),
        publish: true,
      }),
    (error) => error === failure
  );
  assert.equal(f.calls.filter((c) => c[2] === "publish").length, 1);
});
