#!/usr/bin/env node
/**
 * verify.mjs — `aios verify <sha> [--lanes N]`
 *
 * Review one commit through a bounded OpenRouter council panel and emit a single,
 * deterministically severity-ranked report. Apart from an explicitly requested --out path,
 * this command only reads repository state and writes stdout/stderr.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCouncil } from "./council.mjs";
import { normalizeSeverity, rankFindings, rankSeverity } from "./consolidate-findings.mjs";

export const DEFAULT_LANES = 3;
export const MAX_LANES = 8;

function usageError(message) {
  return { error: message, exitCode: 4 };
}

export function parseVerifyArgs(args) {
  const rest = [...args];
  const positional = [];
  let lanes = DEFAULT_LANES;
  let json = false;
  let out = null;

  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--lanes") {
      const raw = rest.shift();
      if (raw === undefined || raw.startsWith("-")) {
        return usageError("`--lanes` needs an integer value");
      }
      if (!/^\d+$/.test(raw)) return usageError(`--lanes must be an integer (got ${raw})`);
      lanes = Number(raw);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--out") {
      out = rest.shift();
      if (out === undefined || out.startsWith("-")) {
        return usageError("`--out` needs a file path");
      }
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, lanes, json, out, sha: null };
    } else if (arg.startsWith("-")) {
      return usageError(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) return usageError("usage: aios verify <sha> [--lanes N]");
  if (lanes < 1) return usageError("--lanes must be at least 1");
  if (lanes > MAX_LANES) {
    return usageError(`--lanes ${lanes} exceeds the hard cap of ${MAX_LANES}`);
  }
  return { sha: positional[0], lanes, json, out, help: false };
}

function gitRead(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

export function validateCommit(repo, sha) {
  try {
    gitRead(repo, ["cat-file", "-e", `${sha}^{commit}`]);
    return gitRead(repo, ["rev-parse", "--verify", `${sha}^{commit}`]);
  } catch {
    return null;
  }
}

export function parseLaneFindings(text, lane, model) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : raw);
  } catch {
    return [
      {
        severity: "High",
        title: "Lane returned an invalid findings payload",
        detail: "The reviewer response was not valid JSON, so this lane fails closed.",
        lane,
        model,
      },
    ];
  }

  const items = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(items)) {
    return [
      {
        severity: "High",
        title: "Lane omitted its findings array",
        detail: "The reviewer response did not contain a JSON findings array.",
        lane,
        model,
      },
    ];
  }

  return items.map((item, index) => ({
    severity: normalizeSeverity(item?.severity) ?? "High",
    title: String(item?.title ?? `Untitled finding ${index + 1}`).trim(),
    detail: String(item?.detail ?? item?.description ?? "").trim(),
    lane,
    model,
  }));
}

export function mergeLaneResults(results) {
  const findings = [];
  results.forEach((result, index) => {
    const lane = index + 1;
    if (!result.ok) {
      findings.push({
        severity: "High",
        title: "Review lane failed",
        detail: String(result.error ?? "Unknown provider failure"),
        lane,
        model: result.model,
      });
      return;
    }
    findings.push(...parseLaneFindings(result.text, lane, result.model));
  });
  return rankFindings(findings);
}

function buildPrompt(sha, diff) {
  return [
    `Review commit ${sha} for correctness, security, regressions, and missing tests.`,
    "Return JSON only: an array of findings.",
    'Each finding must be {"severity":"Critical|High|Medium|Low","title":"...","detail":"..."}.',
    "Return [] when there are no findings. Do not use markdown fences.",
    "",
    "Diff:",
    diff,
  ].join("\n");
}

function formatTextReport(report) {
  const lines = [
    `AIOS verify ${report.sha}`,
    `lanes: ${report.lanes}`,
    `findings: ${report.findings.length}`,
    "",
  ];
  if (!report.findings.length) {
    lines.push("CLEAR — no findings reported.");
  } else {
    for (const finding of report.findings) {
      lines.push(
        `[${finding.severity}] lane ${finding.lane} · ${finding.model} — ${finding.title}`
      );
      if (finding.detail) lines.push(`  ${finding.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function cmdVerify(repo, args, deps = {}) {
  const parsed = parseVerifyArgs(args);
  if (parsed.error) {
    console.error(`error: ${parsed.error}`);
    return parsed.exitCode;
  }
  if (parsed.help) {
    console.log("usage: aios verify <sha> [--lanes N] [--json] [--out <file>]");
    return 0;
  }

  const resolvedSha = validateCommit(repo, parsed.sha);
  if (!resolvedSha) {
    console.error(`error: unknown commit '${parsed.sha}'`);
    return 4;
  }

  const apiKey = deps.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("error: OPENROUTER_API_KEY is not set — verify launched zero lanes");
    return 2;
  }

  const diff = gitRead(repo, ["diff", `${resolvedSha}^..${resolvedSha}`]);
  const councilRunner = deps.runCouncil ?? runCouncil;
  const council = await councilRunner(repo, [buildPrompt(resolvedSha, diff)], {
    apiKey,
    lanes: parsed.lanes,
    persist: false,
    print: false,
    ...(deps.councilOptions ?? {}),
  });
  const findings = mergeLaneResults(council.results);
  const blocking = findings.some(
    (finding) => rankSeverity(finding.severity) >= rankSeverity("High")
  );
  const report = {
    schemaVersion: 1,
    sha: resolvedSha,
    lanes: council.models.length,
    models: council.models,
    blocking,
    findings,
  };
  const output = parsed.json ? `${JSON.stringify(report)}\n` : formatTextReport(report);

  if (parsed.out) writeFileSync(path.resolve(repo, parsed.out), output, "utf8");
  process.stdout.write(output);
  return blocking ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const code = await cmdVerify(process.cwd(), process.argv.slice(2));
  process.exitCode = code;
}
