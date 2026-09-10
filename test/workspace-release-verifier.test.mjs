import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyWorkspaceRelease } from "../scripts/verify-workspace-release.mjs";

const sha = "a".repeat(40),
  version = "2.0.0";
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
  ]) {
    for (const node of [22, 24, 26]) {
      jobs.push({
        name: `accept (${os}, Node ${node})`,
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
          "fresh-install": { verifiedSha256: digest, installedVersion: version },
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
    ref: "refs/tags/v2.0.0",
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
test("accepts exactly six matching cells and returns the same tarball and computed integrity", (t) => {
  const args = setup(t),
    result = verifyWorkspaceRelease(args);
  assert.equal(result.tarball, path.join(args.directory, "package-candidate/candidate.tgz"));
  assert.match(result.integrity, /^sha512-/);
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
