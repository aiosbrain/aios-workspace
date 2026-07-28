import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishSpec, SpecPublishError } from "../scripts/spec-publish.mjs";
import { skillSha256 } from "../scripts/skill-context.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const REPO_SHA = "1".repeat(40);

function fixture({ verdict = "SPEC_READY", candidate = "# Ready\n", remote = "# Old\n" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "spec-publish-"));
  const candidatePath = path.join(root, "candidate.md");
  const evalArtifactPath = path.join(root, "evaluation.json");
  writeFileSync(candidatePath, candidate);
  writeFileSync(
    evalArtifactPath,
    JSON.stringify({
      verdict,
      exitCode: verdict === "SPEC_READY" ? 0 : 1,
      candidateSha256: skillSha256(candidate),
      repoSha: REPO_SHA,
      repoDirty: false,
      publishable: true,
      // A published spec becomes the build contract, so it must carry the adversarial review.
      // Implied before AIO-573 (deterministic-only exited 3, never SPEC_READY); asserted since.
      tier: "full",
    })
  );
  let description = remote;
  let writes = 0;
  const linear = {
    async getIssue() {
      return { description };
    },
    async updateIssueDescription(_id, value) {
      writes++;
      description = value;
      return { ok: true };
    },
  };
  const args = {
    repo: REPO,
    issueId: "AIO-1",
    candidatePath,
    evalArtifactPath,
    expectedRemoteSha: skillSha256(remote),
    exclusiveEditConfirmed: true,
    linear,
    auditRoot: path.join(root, "audit"),
    now: () => new Date("2026-07-25T00:00:00.000Z"),
    resolveRepoHead: () => REPO_SHA,
    scanCandidate: () => ({ clean: true, findings: [] }),
  };
  return { root, args, linear, writes: () => writes, setRemote: (value) => (description = value) };
}

test("publish refuses without explicit single-editor coordination", async () => {
  const fx = fixture();
  let reads = 0;
  fx.args.exclusiveEditConfirmed = false;
  fx.args.linear.getIssue = async () => {
    reads++;
    return { description: "# Old\n" };
  };
  try {
    await assert.rejects(() => publishSpec(fx.args), /confirm-exclusive-editor/);
    assert.equal(reads, 0);
    assert.equal(fx.writes(), 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("successful publish writes once, fetches again, and byte-verifies the remote", async () => {
  const fx = fixture();
  try {
    const result = await publishSpec(fx.args);
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.verified, true);
    assert.equal(fx.writes(), 1);
    assert.equal(
      readFileSync(path.join(result.auditBundle, "remote-after.md"), "utf8"),
      "# Ready\n"
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(result.auditBundle, "audit.json"), "utf8")).status,
      "VERIFIED"
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("NOT_READY artifact refuses before any remote read or write", async () => {
  const fx = fixture({ verdict: "NOT_READY" });
  let reads = 0;
  fx.args.linear.getIssue = async () => {
    reads++;
    return { description: "# Old\n" };
  };
  try {
    await assert.rejects(() => publishSpec(fx.args), /not a successful SPEC_READY/);
    assert.equal(reads, 0);
    assert.equal(fx.writes(), 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a deterministic-only artifact cannot be published (AIO-573)", async () => {
  // Publishing writes the spec into the Linear issue description, making it the build contract.
  // Before the adversarial layer became opt-in, a deterministic-only run exited 3 and could never
  // reach SPEC_READY, so this guarantee was structural. Now it has to be checked.
  const fx = fixture();
  const evaluation = JSON.parse(readFileSync(fx.args.evalArtifactPath, "utf8"));
  writeFileSync(fx.args.evalArtifactPath, JSON.stringify({ ...evaluation, tier: "deterministic" }));
  let reads = 0;
  fx.args.linear.getIssue = async () => {
    reads++;
    return { description: "# Old\n" };
  };
  try {
    await assert.rejects(() => publishSpec(fx.args), /deterministic-only/);
    assert.equal(reads, 0, "must refuse before contacting Linear");
    assert.equal(fx.writes(), 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a normal readiness artifact cannot be reused for external publishing", async () => {
  const fx = fixture();
  const evaluation = JSON.parse(readFileSync(fx.args.evalArtifactPath, "utf8"));
  writeFileSync(fx.args.evalArtifactPath, JSON.stringify({ ...evaluation, publishable: false }));
  let reads = 0;
  fx.args.linear.getIssue = async () => {
    reads++;
    return { description: "# Old\n" };
  };
  try {
    await assert.rejects(() => publishSpec(fx.args), /rerun spec eval with --publishable/);
    assert.equal(reads, 0);
    assert.equal(fx.writes(), 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("stale pre-write remote hash refuses without mutation", async () => {
  const fx = fixture();
  fx.setRemote("# Concurrent edit\n");
  try {
    await assert.rejects(() => publishSpec(fx.args), /remote description changed/);
    assert.equal(fx.writes(), 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a remote edit during audit preparation is rechecked immediately before mutation", async () => {
  const fx = fixture();
  let reads = 0;
  fx.args.linear.getIssue = async () => {
    reads++;
    return { description: reads === 1 ? "# Old\n" : "# Concurrent edit\n" };
  };
  try {
    await assert.rejects(() => publishSpec(fx.args), /changed during publish preflight/);
    assert.equal(fx.writes(), 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("candidate confidentiality findings refuse before contacting Linear", async () => {
  const fx = fixture();
  let reads = 0;
  const withheldPayload = "do-not-echo-this-finding-payload";
  fx.args.scanCandidate = () => ({
    clean: false,
    findings: [`scanner finding payload: ${withheldPayload}`],
  });
  fx.args.linear.getIssue = async () => {
    reads++;
    return { description: "# Old\n" };
  };
  try {
    await assert.rejects(
      () => publishSpec(fx.args),
      (error) => {
        assert.match(error.message, /pre-egress confidentiality scan \(1 finding/);
        assert.doesNotMatch(error.message, new RegExp(withheldPayload));
        return true;
      }
    );
    assert.equal(reads, 0);
    assert.equal(fx.writes(), 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("candidate hash mismatch refuses before contacting Linear", async () => {
  const fx = fixture();
  writeFileSync(fx.args.candidatePath, "# Changed\n");
  let reads = 0;
  fx.args.linear.getIssue = async () => {
    reads++;
    return { description: "# Old\n" };
  };
  try {
    await assert.rejects(() => publishSpec(fx.args), /candidate hash/);
    assert.equal(reads, 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("ambiguous mutation response is never retried and preserves the backup", async () => {
  const fx = fixture();
  fx.args.linear.updateIssueDescription = async () => {
    throw new Error("connection dropped");
  };
  try {
    await assert.rejects(
      () => publishSpec(fx.args),
      (error) => error instanceof SpecPublishError && error.ambiguous
    );
    const bundle = path.join(fx.args.auditRoot, "AIO-1", "2026-07-25T00-00-00-000Z");
    assert.equal(readFileSync(path.join(bundle, "remote-before.md"), "utf8"), "# Old\n");
    assert.equal(
      JSON.parse(readFileSync(path.join(bundle, "audit.json"), "utf8")).status,
      "AMBIGUOUS"
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("post-write byte mismatch fails closed without a second write", async () => {
  const fx = fixture();
  let attempts = 0;
  fx.args.linear.updateIssueDescription = async () => {
    attempts++;
    fx.setRemote("# Server transformed\n");
  };
  try {
    await assert.rejects(
      () => publishSpec(fx.args),
      (error) => error instanceof SpecPublishError && error.ambiguous
    );
    assert.equal(attempts, 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("dry-run performs no mutation and creates no audit bundle", async () => {
  const fx = fixture();
  try {
    const result = await publishSpec({ ...fx.args, dryRun: true });
    assert.equal(result.status, "DRY_RUN");
    assert.equal(fx.writes(), 0);
    assert.equal(existsSync(fx.args.auditRoot), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
