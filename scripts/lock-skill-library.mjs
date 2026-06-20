#!/usr/bin/env node
// lock-skill-library.mjs — generate (or verify) the skill-library manifest.
//
// The cockpit's Skills surface installs ONLY vendored, official, Apache-2.0 skills.
// Trust is carried by provenance + integrity, so this script is the integrity half:
// it walks each vendored skill, refuses symlinks and non-Apache-2.0 licenses, hashes
// every file, records declared capabilities, and writes index.json. The installer
// (gui/server) and OGR09 (validation/check-skill-library.mjs) both read that manifest;
// OGR09 re-runs buildManifest() and asserts it matches the committed index.json.
//
// Usage:
//   node scripts/lock-skill-library.mjs            # write index.json
//   node scripts/lock-skill-library.mjs --check    # exit 1 if index.json is stale

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frontmatter } from "./gen-catalog.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LIBRARY_DIR = path.join(SCRIPT_DIR, "..", "gui", "server", "skill-library");
const CODE_RE = /\.(py|mjs|cjs|js|ts|sh|bash|rb|go|pl)$/i;

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Walk a skill dir → sorted relative POSIX paths. Throws on ANY symlink (a vendored
// skill must be plain files: a link could point outside the tree).
function walkFiles(root, rel = "") {
  const out = [];
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    const relChild = rel ? `${rel}/${name}` : name;
    const st = lstatSync(path.join(root, relChild));
    if (st.isSymbolicLink()) throw new Error(`symlink not allowed in vendored skill: ${relChild}`);
    if (st.isDirectory()) out.push(...walkFiles(root, relChild));
    else if (st.isFile()) out.push(relChild);
  }
  return out;
}

/** Sorted [{path, sha256}] for a dir. Throws on any symlink (via walkFiles). */
export function hashDir(dir) {
  return walkFiles(dir).map((rel) => ({
    path: rel,
    sha256: sha256(readFileSync(path.join(dir, rel))),
  }));
}

/** Order-independent rollup of a file list, for tamper/edit detection. */
export function rollupHash(files) {
  return sha256(
    [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => `${f.path}:${f.sha256}`)
      .join("\n")
  );
}

function assertApache2(skillDir, id) {
  const lic = path.join(skillDir, "LICENSE.txt");
  if (!existsSync(lic))
    throw new Error(
      `skill '${id}' is missing LICENSE.txt — only Apache-2.0 official skills may be vendored`
    );
  const text = readFileSync(lic, "utf8");
  if (/outside the Services|Distribute, sublicense, or transfer these materials/i.test(text)) {
    throw new Error(
      `skill '${id}' carries a PROPRIETARY license — it must be pointer-only (referenced.json), never vendored`
    );
  }
  if (!/Apache License/i.test(text)) {
    throw new Error(
      `skill '${id}' LICENSE.txt is not recognizably Apache-2.0 — refusing to vendor`
    );
  }
}

/** Build the manifest object from sources.json + the on-disk files. Pure (no writes). */
export function buildManifest(libDir = LIBRARY_DIR) {
  const sources = JSON.parse(readFileSync(path.join(libDir, "sources.json"), "utf8"));
  const provenance = {
    upstream_repo: sources.upstream_repo,
    upstream_commit: sources.upstream_commit,
    vendored_at: sources.vendored_at,
  };
  const skills = [];
  for (const id of Object.keys(sources.skills).sort()) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad skill id '${id}' (must match ^[a-z0-9-]+$)`);
    const skillDir = path.join(libDir, id);
    if (!existsSync(skillDir)) throw new Error(`vendored skill dir missing: ${id}`);
    assertApache2(skillDir, id);

    const files = hashDir(skillDir);
    const codeFiles = files.map((f) => f.path).filter((f) => CODE_RE.test(f));

    const fm = frontmatter(readFileSync(path.join(skillDir, "SKILL.md"), "utf8"));
    skills.push({
      id,
      name: fm.name || id,
      description: (fm.description || "").replace(/\s+/g, " ").trim(),
      category: sources.skills[id].category || "Skills",
      license: "Apache-2.0",
      provenance,
      capabilities: {
        bundles_code: codeFiles.length > 0,
        code_files: codeFiles,
        file_count: files.length,
      },
      files,
    });
  }
  return {
    upstream_repo: provenance.upstream_repo,
    upstream_commit: provenance.upstream_commit,
    skills,
  };
}

function main() {
  const check = process.argv.includes("--check");
  const built = buildManifest();
  const indexPath = path.join(LIBRARY_DIR, "index.json");
  const serialized = JSON.stringify(built, null, 2) + "\n";
  if (check) {
    const current = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
    if (current !== serialized) {
      console.error("skill-library index.json is STALE — run: node scripts/lock-skill-library.mjs");
      process.exit(1);
    }
    console.log(`skill-library lock OK — ${built.skills.length} skills, hashes match`);
    return;
  }
  writeFileSync(indexPath, serialized);
  console.log(
    `wrote ${indexPath} — ${built.skills.length} skills @ ${built.upstream_commit.slice(0, 7)}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
