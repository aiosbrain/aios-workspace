#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { stableDigest } from "./policy.mjs";

const MAX_FINDINGS = 500;

function argsFor(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--") || i + 1 >= argv.length) throw new Error(`bad argument: ${value}`);
    parsed[value.slice(2)] = argv[i + 1];
    i += 1;
  }
  return parsed;
}

async function jsonIf(path) {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    console.error(`unusable artifact ${path}: ${error.message}`);
    return null;
  }
}

function redactedFindings(health) {
  if (!health) return { findings: [], reasonCodes: [] };
  if (!Array.isArray(health.findings)) {
    return { findings: [], reasonCodes: ["health_findings_invalid"] };
  }
  const valid = health.findings.filter(
    (finding) =>
      /^[0-9a-f]{64}$/.test(finding?.fingerprint ?? "") &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(finding?.check_id ?? "") &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(finding?.axis ?? "") &&
      ["quality_issue", "evidence_gap"].includes(finding?.kind) &&
      ["low", "medium", "high", "critical"].includes(finding?.severity) &&
      ["complete", "partial", "missing", "stale", "error"].includes(finding?.evidence_status) &&
      finding?.remediation_tier === 0
  );
  const findings = valid
    .map((finding) => ({
      fingerprint: finding.fingerprint,
      check_id: finding.check_id,
      axis: finding.axis,
      kind: finding.kind,
      severity: finding.severity,
      evidence_status: finding.evidence_status,
      remediation_tier: finding.remediation_tier,
    }))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en"))
    .slice(0, MAX_FINDINGS);
  const reasonCodes = [];
  if (valid.length !== health.findings.length) reasonCodes.push("health_findings_invalid");
  if (valid.length > MAX_FINDINGS) reasonCodes.push("health_findings_truncated");
  return { findings, reasonCodes };
}

function reportReasonCodes({
  decision,
  revalidation,
  health,
  healthMatches,
  exactHead,
  delivery,
  findingReasonCodes,
}) {
  const codes = [...(decision.reason_codes ?? [])];
  if (revalidation) codes.push(...(revalidation.reason_codes ?? []));
  else if (!exactHead) codes.push("revalidation_artifact_missing");
  if (!health) codes.push("health_artifact_missing");
  else if (!healthMatches) codes.push("health_head_mismatch");
  if (delivery !== "succeeded") codes.push(`brain_delivery_${delivery}`);
  codes.push(...findingReasonCodes);
  return [...new Set(codes)].sort((a, b) => a.localeCompare(b, "en"));
}

function evidenceFor(health) {
  if (!health) return null;
  return {
    rubric_version: health.rubric_version,
    profile_id: health.profile_id,
    profile_version: health.profile_version,
    measured_at: health.measured_at,
    score_pct: health.score_pct,
    status: health.status,
    evidence_status: health.evidence_status,
    quality_gate: health.quality_gate,
    scanner_automation_eligible: health.automation_eligible,
  };
}

export function buildPatrolReport({ decision, revalidation, health, delivery, run, generated_at }) {
  const { findings, reasonCodes: findingReasonCodes } = redactedFindings(health);
  const healthMatches = health?.head_sha === decision.resolved_sha;
  const exactHead = revalidation?.decision === "run" && revalidation.exact_head === true;
  const scheduled = decision.provisional === false;
  const delivered = delivery === "succeeded";
  const reasonCodes = reportReasonCodes({
    decision,
    revalidation,
    health,
    healthMatches,
    exactHead,
    delivery,
    findingReasonCodes,
  });
  const calibrationEligible =
    decision.decision === "run" &&
    scheduled &&
    exactHead &&
    healthMatches &&
    health?.evidence_status === "complete" &&
    delivered;
  const report = {
    schema_version: "1",
    producer: "aios-workspace/debt-patrol",
    policy_version: run.policy_version,
    report_only: true,
    immutable: true,
    run: {
      id: run.id,
      attempt: run.attempt,
      event_name: run.event_name,
      schedule_name: decision.schedule_name,
      provisional: decision.provisional,
      calibration_eligible: calibrationEligible,
      automatic_filing_eligible: false,
    },
    target: {
      repository: decision.repository,
      slug: decision.slug,
      default_branch: decision.default_branch,
      resolved_sha: decision.resolved_sha,
      revalidated_sha: revalidation?.observed_sha ?? null,
      exact_head_verified: exactHead,
    },
    policy: {
      decision: reasonCodes.length === 0 ? "run" : "stop",
      reason_codes: reasonCodes,
      decision_fingerprint: decision.decision_fingerprint,
      budget_minutes: decision.budget_minutes,
      open_pr_cap: decision.open_pr_cap,
      observed_open_pr_count: decision.observed_open_pr_count,
    },
    evidence: evidenceFor(health),
    findings,
    finding_set_fingerprint: stableDigest(findings.map((finding) => finding.fingerprint)),
    delivery: { team_brain: delivery },
    capabilities: {
      source_write: false,
      pull_request_write: false,
      linear_write: false,
      auto_merge: false,
    },
    generated_at: generated_at ?? new Date().toISOString(),
  };
  return { ...report, report_fingerprint: stableDigest(report) };
}

async function main() {
  const args = argsFor(process.argv.slice(2));
  for (const required of [
    "decision-env",
    "revalidation",
    "health",
    "delivery",
    "run-id",
    "run-attempt",
    "event",
    "policy-version",
    "output",
  ]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  const decisionText = process.env[args["decision-env"]];
  if (!decisionText) throw new Error(`missing decision environment ${args["decision-env"]}`);
  const report = buildPatrolReport({
    decision: JSON.parse(decisionText),
    revalidation: await jsonIf(args.revalidation),
    health: await jsonIf(args.health),
    delivery: args.delivery,
    run: {
      id: args["run-id"],
      attempt: Number(args["run-attempt"]),
      event_name: args.event,
      policy_version: args["policy-version"],
    },
  });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
