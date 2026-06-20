#!/usr/bin/env node
// lock-marketplace.mjs — generate (or verify) the MARKETPLACE-tier skill catalog.
//
// Trust tiers (see gui/server/skill-library.mjs):
//   • official    — vendored, hash-locked, Apache-2.0 (gui/server/skill-library/<id>/).
//   • marketplace — FIRST-PARTY VETTED skills from Anthropic's official plugin directory
//                   (anthropics/claude-plugins-official). A marketplace is a *live* catalog,
//                   so these are NOT vendored — they are fetched-on-install at a pinned
//                   repo@commit and the fetched bytes are byte-diffed against the per-file
//                   sha256 declared here (authenticity guard). Vendoring would just be the
//                   official tier; fetch-on-install is the architecture for this tier.
//   • community   — non-official, scanned + typed-consent on high risk.
//
// This script REFRESHES marketplace.json from upstream:
//   1. read upstream .claude-plugin/marketplace.json (verifies its schema),
//   2. for each curated plugin, locate its in-repo skill dir at the pinned commit,
//   3. fetch each skill (sparse fetch-by-sha → temp dir), hashDir it,
//   4. write { upstream_repo, upstream_commit, skills:[{ id, name, description, category,
//      trust:"marketplace", source:{repo,commit,path_in_repo}, files:[{path,sha256}] }] }.
//
// The fetch is auth-free (sparse `git fetch --depth 1 <url> <sha>`), so it works against
// GitHub AND a local file:// fixture (used by the offline test).
//
// Usage:
//   node scripts/lock-marketplace.mjs            # refresh marketplace.json from upstream
//   node scripts/lock-marketplace.mjs --check    # structural lint of the committed catalog
//                                                 # (no network — see note below)
//
// NOTE on --check: refreshing requires the network (it fetches upstream). CI must not
// depend on network, so --check is a *structural* validator (shape, disjoint ids, trust,
// valid source, declared hashes present + well-formed). The full fetch+byte-diff
// authenticity path is exercised by test/skill-install-marketplace.test.mjs against a
// local fixture upstream. Run a real refresh (no --check) manually to re-pin a commit.

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { frontmatter } from "./gen-catalog.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LIBRARY_DIR = path.join(SCRIPT_DIR, "..", "gui", "server", "skill-library");
export const MARKETPLACE_JSON = path.join(LIBRARY_DIR, "marketplace.json");

// ── upstream: Anthropic's official plugin directory ──────────────────────────
// The catalog source. The https URL is used at refresh; the pinned commit is what every
// install fetch+verifies against. Confirmed schema at impl: marketplace.json lives at
// .claude-plugin/marketplace.json and lists `plugins[]` (NOT skills) — see refresh().
const UPSTREAM_REPO = "https://github.com/anthropics/claude-plugins-official.git";
const UPSTREAM_GH = "anthropics/claude-plugins-official"; // for `gh api` reads at refresh
const UPSTREAM_MARKETPLACE_PATH = ".claude-plugin/marketplace.json";

// Curated allow-list — a SMALL, reviewable subset of FIRST-PARTY (Anthropic-authored,
// in-repo) plugin SKILLS. Each entry maps a marketplace plugin → the skill dir inside it
// we expose. We keep this tiny and hand-curated on purpose (full-catalog admission is a
// UX-test item, not a data-contract change). ids must be disjoint from the official +
// community tiers and match ^[a-z0-9-]+$.
//   plugin               skill id (dir under plugins/<plugin>/skills/)   category
const CURATED = [
  {
    plugin: "claude-md-management",
    skill: "claude-md-improver",
    category: "Marketplace · Anthropic",
  },
  { plugin: "session-report", skill: "session-report", category: "Marketplace · Anthropic" },
  { plugin: "math-olympiad", skill: "math-olympiad", category: "Marketplace · Anthropic" },
];

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Walk a dir → sorted relative POSIX paths. Throws on ANY symlink (a fetched skill must be
// plain files — a link could escape the tree). Mirrors lock-skill-library's walkFiles.
function walkFiles(root, rel = "") {
  const out = [];
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    const relChild = rel ? `${rel}/${name}` : name;
    const st = lstatSync(path.join(root, relChild));
    if (st.isSymbolicLink())
      throw new Error(`symlink not allowed in marketplace skill: ${relChild}`);
    if (st.isDirectory()) out.push(...walkFiles(root, relChild));
    else if (st.isFile()) out.push(relChild);
  }
  return out;
}

/** Sorted [{path, sha256}] for a dir. Throws on any symlink. */
export function hashDir(dir) {
  return walkFiles(dir).map((rel) => ({
    path: rel,
    sha256: sha256(readFileSync(path.join(dir, rel))),
  }));
}

// Extract the `description:` value from raw frontmatter, tolerating YAML block scalars and
// indented continuation lines (which the shared `frontmatter()` collapses to empty). Used
// only as a fallback so the catalog still carries a human description for the GUI.
function descFromRaw(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return "";
  const fmLines = m[1].split("\n");
  const i = fmLines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return "";
  const parts = [fmLines[i].replace(/^description:\s*/, "")];
  for (let j = i + 1; j < fmLines.length; j++) {
    if (/^[A-Za-z0-9_-]+:/.test(fmLines[j])) break; // next top-level key
    parts.push(fmLines[j].trim());
  }
  return parts
    .join(" ")
    .replace(/^["'|>+-]+/, "")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch a single subdirectory (pathInRepo) of a git repo at a pinned commit into a fresh
 * temp dir. Auth-free + minimal: a sparse, depth-1 fetch *by sha*. Works against an https
 * GitHub URL AND a local file:// fixture (the offline test path). Returns
 * { dir, cleanup } — the caller MUST call cleanup().
 *
 * Pure w.r.t. the source repo: only writes under a fresh os.tmpdir() scratch dir.
 */
export function gitFetchSubdir(repoUrl, commit, pathInRepo) {
  if (!/^[0-9a-f]{40}$/i.test(commit))
    throw new Error(`commit must be a full 40-char sha: ${commit}`);
  if (/(^|\/)\.\.(\/|$)/.test(pathInRepo) || path.isAbsolute(pathInRepo))
    throw new Error(`bad path_in_repo: ${pathInRepo}`);
  const scratch = mkdtempSync(path.join(tmpdir(), "aios-mkt-"));
  const run = (args) =>
    execFileSync("git", ["-C", scratch, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    run(["init", "-q"]);
    run(["sparse-checkout", "init", "--no-cone"]);
    run(["sparse-checkout", "set", `${pathInRepo}/*`]);
    run(["remote", "add", "origin", repoUrl]);
    run(["fetch", "-q", "--depth", "1", "origin", commit]);
    run(["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"]);
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(
      `fetch failed for ${repoUrl}@${commit.slice(0, 7)}:${pathInRepo} — ${e.stderr ? e.stderr.toString().trim() : e.message}`
    );
  }
  const sub = path.join(scratch, pathInRepo);
  if (!existsSync(sub)) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(`path_in_repo not found at commit: ${pathInRepo}`);
  }
  return { dir: sub, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

// ── refresh (network) ─────────────────────────────────────────────────────────

function ghReadJson(ghRepo, repoPath, ref) {
  const out = execFileSync(
    "gh",
    ["api", `repos/${ghRepo}/contents/${repoPath}?ref=${ref}`, "--jq", ".content"],
    { encoding: "utf8" }
  );
  return JSON.parse(Buffer.from(out, "base64").toString("utf8"));
}

/** Refresh marketplace.json from upstream. Requires network + `gh`. */
function refresh() {
  const head = execFileSync("gh", ["api", `repos/${UPSTREAM_GH}/commits/main`, "--jq", ".sha"], {
    encoding: "utf8",
  }).trim();
  console.log(`upstream HEAD: ${head}`);

  // 1. read + verify upstream marketplace.json schema.
  const upstream = ghReadJson(UPSTREAM_GH, UPSTREAM_MARKETPLACE_PATH, head);
  if (!Array.isArray(upstream.plugins))
    throw new Error("upstream marketplace.json: expected a `plugins` array");

  const skills = [];
  for (const c of CURATED) {
    const plugin = upstream.plugins.find((p) => p.name === c.plugin);
    if (!plugin) throw new Error(`curated plugin '${c.plugin}' not in upstream marketplace.json`);
    // We only admit FIRST-PARTY, in-repo plugins (source is a relative "./plugins/<name>"
    // string). Third-party `git-subdir`/`url` sources are intentionally out of scope for v1.
    if (typeof plugin.source !== "string" || !plugin.source.startsWith("./plugins/")) {
      throw new Error(
        `curated plugin '${c.plugin}' is not first-party in-repo (source=${JSON.stringify(plugin.source)})`
      );
    }
    const pathInRepo = `${plugin.source.replace(/^\.\//, "")}/skills/${c.skill}`;
    const { dir, cleanup } = gitFetchSubdir(UPSTREAM_REPO, head, pathInRepo);
    try {
      const skillMd = readFileSync(path.join(dir, "SKILL.md"), "utf8");
      const fm = frontmatter(skillMd);
      const id = c.skill;
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`skill id '${id}' must match ^[a-z0-9-]+$`);
      const files = hashDir(dir);
      const fmDesc = Array.isArray(fm.description)
        ? fm.description.join(" ")
        : fm.description || "";
      const description = String(fmDesc).replace(/\s+/g, " ").trim() || descFromRaw(skillMd);
      skills.push({
        id,
        name: (typeof fm.name === "string" && fm.name) || id,
        description,
        category: c.category,
        trust: "marketplace",
        source: { repo: UPSTREAM_REPO, commit: head, path_in_repo: pathInRepo },
        files,
      });
      console.log(`  + ${id}  (${files.length} files)`);
    } finally {
      cleanup();
    }
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return { upstream_repo: UPSTREAM_REPO, upstream_commit: head, skills };
}

// ── structural --check (no network) ────────────────────────────────────────────

export function structuralCheck(catalog) {
  const problems = [];
  if (!catalog || typeof catalog !== "object") return ["marketplace.json is not an object"];
  if (!catalog.upstream_repo) problems.push("missing upstream_repo");
  if (!/^[0-9a-f]{40}$/i.test(catalog.upstream_commit || ""))
    problems.push("upstream_commit must be a full 40-char sha");
  if (!Array.isArray(catalog.skills)) {
    problems.push("missing skills[]");
    return problems;
  }
  const seen = new Set();
  for (const s of catalog.skills) {
    const id = s.id || "(no id)";
    if (!/^[a-z0-9-]+$/.test(s.id || "")) problems.push(`${id}: id must match ^[a-z0-9-]+$`);
    if (seen.has(s.id)) problems.push(`${id}: duplicate id`);
    seen.add(s.id);
    if (s.trust !== "marketplace") problems.push(`${id}: trust must be "marketplace"`);
    if (!s.source || !s.source.repo || !s.source.path_in_repo)
      problems.push(`${id}: source must have {repo, commit, path_in_repo}`);
    else {
      if (!/^[0-9a-f]{40}$/i.test(s.source.commit || ""))
        problems.push(`${id}: source.commit must be a full 40-char sha`);
      if (/(^|\/)\.\.(\/|$)/.test(s.source.path_in_repo) || path.isAbsolute(s.source.path_in_repo))
        problems.push(`${id}: source.path_in_repo escapes the repo`);
    }
    if (!Array.isArray(s.files) || s.files.length === 0)
      problems.push(`${id}: must declare at least one file with sha256`);
    else {
      for (const f of s.files) {
        if (!f.path || /(^|\/)\.\.(\/|$)/.test(f.path) || path.isAbsolute(f.path))
          problems.push(`${id}: bad file path '${f.path}'`);
        if (!/^[0-9a-f]{64}$/i.test(f.sha256 || ""))
          problems.push(`${id}: file '${f.path}' has a malformed sha256`);
      }
      if (!s.files.some((f) => f.path === "SKILL.md"))
        problems.push(`${id}: must declare a SKILL.md`);
    }
  }
  return problems;
}

function main() {
  const check = process.argv.includes("--check");
  if (check) {
    if (!existsSync(MARKETPLACE_JSON)) {
      console.log("no marketplace.json — marketplace tier not registered");
      return;
    }
    const cat = JSON.parse(readFileSync(MARKETPLACE_JSON, "utf8"));
    const problems = structuralCheck(cat);
    if (problems.length) {
      console.error("marketplace.json STRUCTURAL ERRORS:\n  - " + problems.join("\n  - "));
      process.exit(1);
    }
    console.log(
      `marketplace lock OK — ${cat.skills.length} skill(s) @ ${cat.upstream_commit.slice(0, 7)} (structural; authenticity verified at install)`
    );
    return;
  }
  const built = refresh();
  mkdirSync(LIBRARY_DIR, { recursive: true });
  writeFileSync(MARKETPLACE_JSON, JSON.stringify(built, null, 2) + "\n");
  console.log(
    `wrote ${MARKETPLACE_JSON} — ${built.skills.length} skill(s) @ ${built.upstream_commit.slice(0, 7)}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
