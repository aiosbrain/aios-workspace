/** Read-only, dependency-free onboarding preflight. Live state is recomputed on every run. */

import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeBrainOrigin } from "./brain-origin.mjs";
import { parseFlatYaml } from "./flat-yaml.mjs";
import { toolkitMeta } from "./toolkit-meta.mjs";

const MODULE_TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "Library",
  "node_modules",
  "target",
]);
const CORE_MARKERS = [
  "aios.yaml",
  ".aios-toolkit-version",
  "AGENTS.md",
  "0-context",
  "1-inbox",
  "2-work",
];

function readYaml(dir) {
  try {
    return parseFlatYaml(readFileSync(path.join(dir, "aios.yaml"), "utf8"));
  } catch {
    return {};
  }
}

function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitState(dir) {
  const inside = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  const prefix = git(dir, ["rev-parse", "--show-prefix"]);
  if (inside !== "true" || prefix == null || prefix !== "")
    return { available: false, dirty: null };
  const porcelain = git(dir, ["status", "--porcelain"]);
  return { available: true, dirty: porcelain == null ? null : porcelain.length > 0 };
}

function stamp(dir) {
  const file = path.join(dir, ".aios-toolkit-version");
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split("\n");
  const field = (name) =>
    lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) || null;
  return {
    sha: lines[0]?.trim() || null,
    toolkit_version: field("toolkit-version"),
    brain_api: field("brain-api"),
    source: field("source"),
  };
}

function keyConfigured(dir, keyEnv) {
  if (String(process.env[keyEnv] || "").trim()) return true;
  try {
    const raw = readFileSync(path.join(dir, ".env"), "utf8");
    return raw.split("\n").some((line) => {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      return match?.[1] === keyEnv && !!match[2].trim();
    });
  } catch {
    return false;
  }
}

function brainState(dir, yaml) {
  const rawUrl = String(process.env.AIOS_BRAIN_URL || yaml.brain_url || "").trim();
  const keyEnv = String(yaml.api_key_env || "AIOS_API_KEY").trim();
  const hasKey = keyConfigured(dir, keyEnv);
  let normalization = { ok: null, origin: null, error: null };
  if (rawUrl) {
    try {
      normalization = { ok: true, origin: normalizeBrainOrigin(rawUrl), error: null };
    } catch (error) {
      normalization = { ok: false, origin: null, error: error.message };
    }
  }
  const completeness =
    !rawUrl && !hasKey
      ? "standalone"
      : rawUrl && hasKey && normalization.ok
        ? "configured"
        : "incomplete";
  return {
    completeness,
    url_configured: !!rawUrl,
    api_key_configured: hasKey,
    team_id_configured: !!String(process.env.AIOS_TEAM || yaml.team_id || "").trim(),
    normalization,
  };
}

function looksLikeToolkit(dir) {
  return (
    existsSync(path.join(dir, "scripts", "aios.mjs")) && existsSync(path.join(dir, "scaffold"))
  );
}

function looksLikeCandidate(dir) {
  if (looksLikeToolkit(dir)) return false;
  const present = CORE_MARKERS.filter((marker) => existsSync(path.join(dir, marker)));
  return present.includes("aios.yaml") || present.length >= 3;
}

function collectCandidates(root, maxDepth, out, seen) {
  const abs = path.resolve(root);
  if (seen.has(abs) || !existsSync(abs)) return;
  seen.add(abs);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  if (looksLikeCandidate(abs)) {
    out.add(abs);
    return; // do not crawl personal workspace contents
  }
  if (maxDepth <= 0) return;
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      SKIP_DIRS.has(entry.name) ||
      entry.name.startsWith(".")
    )
      continue;
    collectCandidates(path.join(abs, entry.name), maxDepth - 1, out, seen);
  }
}

function toolkitState(dir) {
  if (!dir || !looksLikeToolkit(dir)) return null;
  const gitInfo = gitState(dir);
  const meta = toolkitMeta(dir);
  const head = git(dir, ["rev-parse", "HEAD"]);
  const upstream = git(dir, ["rev-parse", "@{upstream}"]);
  let relation = "unknown";
  if (head && upstream) {
    const counts = git(dir, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    const [ahead, behind] = String(counts || "")
      .split(/\s+/)
      .map(Number);
    if (Number.isFinite(ahead) && Number.isFinite(behind)) {
      relation =
        ahead === 0 && behind === 0 ? "current" : ahead === 0 && behind > 0 ? "behind" : "diverged";
    }
  }
  const strategy = gitInfo.dirty
    ? "leave-dirty-checkout-untouched; use-fresh-versioned-checkout"
    : relation === "current" || relation === "behind"
      ? "fast-forward-only"
      : "use-fresh-versioned-checkout";
  return {
    path: path.resolve(dir),
    version: meta.version,
    brain_api: meta.brainApi || null,
    head,
    upstream,
    relation,
    git: gitInfo,
    recommended_strategy: strategy,
    fresh_checkout_path: `${path.resolve(dir)}-v${meta.version}`,
  };
}

function workspaceState(dir, toolkit) {
  const yaml = readYaml(dir);
  const present = CORE_MARKERS.filter((marker) => existsSync(path.join(dir, marker)));
  const missing = CORE_MARKERS.filter((marker) => !present.includes(marker));
  const versionStamp = stamp(dir);
  const toolkitStale = !!(
    toolkit?.head &&
    versionStamp?.sha &&
    !toolkit.head.startsWith(versionStamp.sha) &&
    !versionStamp.sha.startsWith(toolkit.head)
  );
  return {
    path: path.resolve(dir),
    context: yaml.context || null,
    scaffold: { complete: missing.length === 0, present, missing },
    version_stamp: versionStamp,
    toolkit_stale: toolkitStale,
    git: gitState(dir),
    brain: brainState(dir, yaml),
  };
}

function recommendation(workspaces) {
  if (!workspaces.length)
    return { action: "scaffold", reason: "No existing AIOS personal workspace was found." };
  const target = workspaces[0];
  if (!target.scaffold.complete || target.brain.completeness === "incomplete") {
    return {
      action: "repair-configuration",
      reason: "The existing workspace is partial or its Brain configuration is incomplete/unsafe.",
    };
  }
  if (target.toolkit_stale)
    return {
      action: "update",
      reason: "The workspace version stamp is behind the available toolkit.",
    };
  return {
    action: "continue",
    reason: "The existing workspace is usable; continue from its current state.",
  };
}

export function inspectOnboarding({ startDir = process.cwd(), repo, roots, toolkitDir } = {}) {
  const toolkitCandidates = [
    toolkitDir,
    process.env.AIOS_TOOLKIT_DIR,
    MODULE_TOOLKIT,
    path.join(os.homedir(), "Projects", "aios", "aios-workspace"),
  ].filter(Boolean);
  const toolkit = toolkitState(toolkitCandidates.find(looksLikeToolkit));
  const searchRoots =
    roots ||
    [
      repo,
      startDir,
      path.join(os.homedir(), "Projects"),
      path.join(os.homedir(), "Developer"),
      path.join(os.homedir(), "Code"),
    ].filter(Boolean);
  const found = new Set();
  const seen = new Set();
  for (const root of searchRoots) collectCandidates(root, root === repo ? 1 : 3, found, seen);
  const preferred = repo ? path.resolve(repo) : null;
  const workspaces = [...found]
    .map((dir) => workspaceState(dir, toolkit))
    .sort((a, b) =>
      a.path === preferred ? -1 : b.path === preferred ? 1 : a.path.localeCompare(b.path)
    );
  const recommended = recommendation(workspaces);
  return {
    schema_version: 1,
    inspected_at: new Date().toISOString(),
    live_state: true,
    workspace_candidates: workspaces,
    toolkit,
    recommended_action: recommended.action,
    recommendation_reason: recommended.reason,
  };
}

export function formatInspection(report) {
  const lines = ["AIOS onboarding inspection"];
  if (!report.workspace_candidates.length) lines.push("  Workspaces: none found");
  for (const ws of report.workspace_candidates) {
    lines.push(`  Workspace: ${ws.path}`);
    lines.push(
      `    scaffold: ${ws.scaffold.complete ? "complete" : `partial (missing ${ws.scaffold.missing.join(", ")})`}`
    );
    lines.push(
      `    git: ${ws.git.available ? (ws.git.dirty ? "dirty — leave untouched" : "clean") : "not a repository"}`
    );
    lines.push(
      `    Brain: ${ws.brain.completeness}${ws.brain.normalization.origin ? ` (${ws.brain.normalization.origin})` : ""}`
    );
  }
  if (report.toolkit) {
    lines.push(
      `  Toolkit: ${report.toolkit.path} (v${report.toolkit.version}, ${report.toolkit.relation}, ${report.toolkit.git.dirty ? "dirty" : "clean"})`
    );
  }
  lines.push(
    `  Recommended action: ${report.recommended_action} — ${report.recommendation_reason}`
  );
  return lines.join("\n");
}
