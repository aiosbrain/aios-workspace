// Shared loop identity resolution so the CLI (`aios loop`) and the MCP `aios_loop_collect`
// tool stamp manifests with the SAME member + project — they must be identical regardless of
// entry point (the loop runs from CLI and cockpit against one model). Zero-dep.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseFlatYaml } from "./flat-yaml.mjs";

function slugify(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readYaml(file) {
  if (!existsSync(file)) return {};
  try {
    return parseFlatYaml(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Resolve { member, project } for a workspace root, identically for CLI and MCP.
 * member:  $AIOS_MEMBER → aios.yaml `member` → git user.name (slugified) → "owner"
 * project: project.yaml|engagement.yaml `slug` → basename(repo) (slugified)
 */
export function resolveLoopIdentity(repo, env = process.env) {
  const aios = readYaml(path.join(repo, "aios.yaml"));
  let proj = {};
  for (const f of ["project.yaml", "engagement.yaml"]) {
    const p = path.join(repo, f);
    if (existsSync(p)) {
      proj = readYaml(p);
      break;
    }
  }
  const git = (key) => {
    try {
      return execFileSync("git", ["-C", repo, "config", key], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  // Mirror the sync client's resolveMember precedence: $AIOS_MEMBER → aios.yaml member →
  // git config aios.member → slugified git user.name → "owner".
  const member =
    (env.AIOS_MEMBER && String(env.AIOS_MEMBER).trim()) ||
    aios.member ||
    git("aios.member") ||
    slugify(git("user.name")) ||
    "owner";
  const project = proj.slug || slugify(path.basename(repo));
  return { member, project };
}
