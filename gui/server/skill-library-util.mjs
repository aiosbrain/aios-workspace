// gui/server/skill-library-util.mjs — gui-owned filesystem/git helpers for the skill
// library (AIO-600 C2, GUI↔toolkit decoupling).
//
// PROVENANCE: every helper below is a deliberate, honest COPY of a small, stable
// toolkit helper — duplicated so gui/server never imports scripts/** (boundary R4,
// scripts/check-boundaries.mjs). Keep each copy in lockstep with its source:
//
//   sha256 / hashDir / rollupHash  ← scripts/lock-skill-library.mjs
//   gitFetchSubdir                 ← scripts/lock-marketplace.mjs
//   copyDir / ensureGitignore      ← scripts/connector.mjs
//   frontmatter                    ← scripts/gen-catalog.mjs
//
// Cross-side parity is enforced end-to-end by the install suites
// (test/skill-install.test.mjs, test/skill-install-marketplace.test.mjs): the committed
// locks (index.json) and test-built marketplace catalogs are generated with the
// scripts-side copies and verified at install time with THESE copies — algorithmic
// drift fails those tests CLOSED (hash mismatch refuses the install), never open.

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  lstatSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ── integrity hashing (copy of scripts/lock-skill-library.mjs) ───────────────────────

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

// ── pinned git subdir fetch (copy of scripts/lock-marketplace.mjs) ───────────────────

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

// ── generic fs helpers (copy of scripts/connector.mjs) ───────────────────────────────

export function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name),
      d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

export function ensureGitignore(repo, entries = [".env", ".env.keys"]) {
  const gi = path.join(repo, ".gitignore");
  let txt = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const lines = new Set(txt.split("\n").map((l) => l.trim()));
  let changed = false;
  for (const n of entries)
    if (!lines.has(n)) {
      txt = txt.replace(/\s*$/, "\n") + n + "\n";
      changed = true;
    }
  if (changed) writeFileSync(gi, txt);
}

// ── SKILL.md frontmatter (copy of scripts/gen-catalog.mjs) ───────────────────────────
// NOT replaceable by @aios-alpha/monorepo/workspace-parse's parseFrontmatter: that one
// is a flat-YAML reader, while SKILL.md descriptions routinely use `|`/`>` block
// scalars and lists, which this parser handles. Same behavior as the parser the lock
// scripts use to build index.json descriptions.

// tiny YAML-frontmatter reader (handles inline, `|` and `>` block scalars, simple lists)
export function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split("\n");
  const out = {};
  let key = null,
    block = null,
    blockMode = null,
    list = null;
  const flush = () => {
    if (key && block !== null) {
      out[key] =
        blockMode === ">" ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
      block = null;
      blockMode = null;
    }
    if (key && list !== null) {
      out[key] = list;
      list = null;
    }
    key = null;
  };
  for (const raw of lines) {
    const top = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    const isIndented = /^\s+/.test(raw);
    if (top && !isIndented) {
      flush();
      key = top[1];
      const val = top[2];
      const blockHdr = val.match(/^([|>])[-+]?$/); // |, |-, |+, >, >-, >+ (YAML chomping indicators)
      if (blockHdr) {
        blockMode = blockHdr[1];
        block = [];
      } else if (val === "") {
        list = [];
      } // may become a list (- items) or stay empty
      else {
        out[key] = val.replace(/^["']|["']$/g, "");
        key = null;
      }
    } else if (key && block !== null) {
      block.push(raw.replace(/^\s{2}/, ""));
    } else if (key && list !== null) {
      const li = raw.match(/^\s*-\s*(.*)$/);
      if (li) list.push(li[1].replace(/^["']|["']$/g, "").trim());
    }
  }
  flush();
  return out;
}

// ── gui-owned (not a copy) ───────────────────────────────────────────────────────────

/**
 * Ids of the skills installed in <repo>/.claude/skills — the directory names that carry
 * a SKILL.md. The install-status key the library list needs (the id IS the dir name,
 * matching gen-catalog's readSkills(), which the gui no longer imports).
 */
export function installedSkillIds(repo) {
  const dir = path.join(repo, ".claude", "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((name) => {
      const sub = path.join(dir, name);
      return statSync(sub).isDirectory() && existsSync(path.join(sub, "SKILL.md"));
    });
}
