import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLinearClient, resolveLinearApiKey } from "./linear-client.mjs";
import { defaultScanFile } from "./promote.mjs";
import { loadSkillContext, skillSha256 } from "./skill-context.mjs";

const TRUSTED_GIT_BIN = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find(
  existsSync
);

export class SpecPublishError extends Error {
  constructor(message, { ambiguous = false } = {}) {
    super(message);
    this.name = "SpecPublishError";
    this.ambiguous = ambiguous;
  }
}

function repoHead(repo) {
  if (!TRUSTED_GIT_BIN)
    throw new SpecPublishError("git was not found in a trusted system directory");
  return execFileSync(TRUSTED_GIT_BIN, ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function writeBundleManifest(bundleDir, value) {
  writeFileSync(path.join(bundleDir, "audit.json"), `${JSON.stringify(value, null, 2)}\n`);
}

export async function publishSpec({
  repo,
  issueId,
  candidatePath,
  evalArtifactPath,
  expectedRemoteSha,
  exclusiveEditConfirmed = false,
  dryRun = false,
  linear,
  auditRoot = path.join(repo, ".aios", "spec-publish"),
  now = () => new Date(),
  resolveRepoHead = repoHead,
  scanCandidate = defaultScanFile,
}) {
  if (!/^AIO-\d+$/.test(issueId))
    throw new SpecPublishError(`invalid issue id '${issueId}' (expected AIO-<n>)`);
  if (!/^[a-f0-9]{64}$/.test(expectedRemoteSha))
    throw new SpecPublishError("--expected-remote-sha must be a lowercase SHA-256");
  if (!exclusiveEditConfirmed)
    throw new SpecPublishError(
      "publishing requires --confirm-exclusive-editor: coordinate a single Linear description editor until byte verification completes"
    );
  if (!existsSync(candidatePath))
    throw new SpecPublishError(`candidate not found: ${candidatePath}`);
  if (!existsSync(evalArtifactPath))
    throw new SpecPublishError(`evaluation artifact not found: ${evalArtifactPath}`);

  const candidate = readFileSync(candidatePath, "utf8");
  const candidateSha256 = skillSha256(candidate);
  let evaluation;
  try {
    evaluation = JSON.parse(readFileSync(evalArtifactPath, "utf8"));
  } catch (error) {
    throw new SpecPublishError(`invalid evaluation artifact: ${error.message}`);
  }
  if (evaluation.verdict !== "SPEC_READY" || evaluation.exitCode !== 0)
    throw new SpecPublishError("evaluation artifact is not a successful SPEC_READY verdict");
  if (evaluation.publishable !== true)
    throw new SpecPublishError(
      "evaluation artifact is not publishable; rerun spec eval with --publishable on a clean tree"
    );
  if (evaluation.candidateSha256 !== candidateSha256)
    throw new SpecPublishError("candidate hash does not match the evaluation artifact");
  const currentRepoSha = resolveRepoHead(repo);
  if (!evaluation.repoSha || evaluation.repoSha !== currentRepoSha)
    throw new SpecPublishError("repository SHA does not match the evaluation artifact");
  if (evaluation.repoDirty !== false)
    throw new SpecPublishError("evaluation artifact does not prove a clean repository baseline");
  const scan = scanCandidate(candidatePath);
  if (!scan.clean) {
    const findingCount = Array.isArray(scan.findings) ? scan.findings.length : 1;
    throw new SpecPublishError(
      `candidate failed the pre-egress confidentiality scan (${findingCount} finding(s); details withheld)`
    );
  }

  const skillContext = loadSkillContext({
    repo,
    ids: ["linear-publish-spec"],
    stage: "spec-publish",
    source: "explicit",
    explicit: true,
  });
  const before = await linear.getIssue(issueId);
  if (!before) throw new SpecPublishError(`Linear issue not found: ${issueId}`);
  const remoteBefore = before.description ?? "";
  const remoteBeforeSha256 = skillSha256(remoteBefore);
  if (remoteBeforeSha256 !== expectedRemoteSha)
    throw new SpecPublishError("remote description changed since approval; refusing to overwrite");

  const audit = {
    issueId,
    candidatePath: path.resolve(candidatePath),
    evalArtifactPath: path.resolve(evalArtifactPath),
    candidateSha256,
    repoSha: currentRepoSha,
    remoteBeforeSha256,
    exclusiveEditConfirmed,
    injectedSkills: skillContext.audit,
    dryRun,
    status: dryRun ? "DRY_RUN" : "PENDING",
  };
  if (dryRun) return { ...audit, auditBundle: null, verified: false };

  const bundleDir = path.join(auditRoot, issueId, safeTimestamp(now()));
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(path.join(bundleDir, "remote-before.md"), remoteBefore);
  writeFileSync(path.join(bundleDir, "candidate.md"), candidate);
  writeFileSync(
    path.join(bundleDir, "evaluation.json"),
    `${JSON.stringify(evaluation, null, 2)}\n`
  );
  writeBundleManifest(bundleDir, audit);

  const immediate = await linear.getIssue(issueId);
  if (!immediate) throw new SpecPublishError(`Linear issue not found before mutation: ${issueId}`);
  if (skillSha256(immediate.description ?? "") !== remoteBeforeSha256) {
    writeBundleManifest(bundleDir, {
      ...audit,
      status: "STALE",
      error: "remote description changed during publish preflight",
    });
    throw new SpecPublishError(
      `remote description changed during publish preflight; inspect ${bundleDir} and retry only after fresh approval`
    );
  }

  try {
    await linear.updateIssueDescription(issueId, candidate);
  } catch (error) {
    writeBundleManifest(bundleDir, {
      ...audit,
      status: "AMBIGUOUS",
      error: error instanceof Error ? error.message : String(error),
    });
    throw new SpecPublishError(
      `Linear mutation result is ambiguous; inspect ${bundleDir} before any later write`,
      { ambiguous: true }
    );
  }

  let after;
  try {
    after = await linear.getIssue(issueId);
  } catch (error) {
    writeBundleManifest(bundleDir, {
      ...audit,
      status: "AMBIGUOUS",
      error: `post-write fetch failed: ${error.message}`,
    });
    throw new SpecPublishError(
      `post-write verification failed; inspect ${bundleDir} and do not retry the write`,
      { ambiguous: true }
    );
  }
  const remoteAfter = after?.description ?? "";
  const remoteAfterSha256 = skillSha256(remoteAfter);
  writeFileSync(path.join(bundleDir, "remote-after.md"), remoteAfter);
  if (remoteAfter !== candidate) {
    writeBundleManifest(bundleDir, {
      ...audit,
      status: "MISMATCH",
      remoteAfterSha256,
    });
    throw new SpecPublishError(
      `remote byte verification failed; inspect ${bundleDir} and do not issue another write`,
      { ambiguous: true }
    );
  }

  const result = {
    ...audit,
    status: "VERIFIED",
    remoteAfterSha256,
    verified: true,
    auditBundle: bundleDir,
  };
  writeBundleManifest(bundleDir, result);
  return result;
}

export async function cmdSpecPublish(repo, args, deps = {}) {
  const issueId = args[1];
  const candidate = args[2];
  const flag = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? null : args[index + 1];
  };
  if (
    !issueId ||
    !candidate ||
    !flag("--eval-artifact") ||
    !flag("--expected-remote-sha") ||
    !args.includes("--confirm-exclusive-editor")
  ) {
    throw new SpecPublishError(
      "usage: aios spec publish AIO-<n> <candidate> --eval-artifact <json> --expected-remote-sha <sha256> --confirm-exclusive-editor [--dry-run] [--json]"
    );
  }
  const linear =
    deps.linear ??
    createLinearClient({
      apiKey: resolveLinearApiKey(repo),
    });
  const result = await publishSpec({
    repo,
    issueId,
    candidatePath: path.resolve(candidate),
    evalArtifactPath: path.resolve(flag("--eval-artifact")),
    expectedRemoteSha: flag("--expected-remote-sha"),
    exclusiveEditConfirmed: true,
    dryRun: args.includes("--dry-run"),
    linear,
    ...(deps.publishOptions ?? {}),
  });
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else if (result.dryRun)
    console.log(`DRY_RUN ${issueId}: candidate and remote hashes match; no write performed.`);
  else console.log(`VERIFIED ${issueId}: ${result.remoteAfterSha256} (${result.auditBundle})`);
  return 0;
}
