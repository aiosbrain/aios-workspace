// gui/server/skill-library.mjs — skill-library install logic, by trust tier.
//
// Trust tiers:
//   • official    — vendored, Apache-2.0 skills (gui/server/skill-library/<id>/). Safety
//                   rests on provenance + integrity; install is ONE-CLICK (hash-locked).
//   • marketplace — FIRST-PARTY VETTED skills from Anthropic's official plugin directory
//                   (anthropics/claude-plugins-official, see marketplace.json). A
//                   marketplace is a *live* catalog, so these are NOT vendored — they are
//                   FETCHED-ON-INSTALL at the pinned repo@commit and the fetched bytes are
//                   byte-diffed against the per-file sha256 declared in the catalog
//                   (authenticity guard; refuse on ANY mismatch). Because the source is
//                   first-party vetted, the scan stays ADVISORY + simple-accept (no typed
//                   confirm). Trust ranks: official > marketplace > community.
//   • community   — non-official skills (community.json) with NO first-party provenance.
//                   Install is GATED: the static scanner (scripts/skill-scan.mjs) runs,
//                   the findings are surfaced, and an explicit consent step is required —
//                   a `high` risk class demands a TYPED confirm. The scan is ADVISORY;
//                   provenance + human review are the real anchor.
//
// Across all tiers the #17 safety machinery carries over unchanged:
//   • install verifies the source snapshot against the committed lock / declared hashes
//   • never overwrites a user-authored/edited skill (collision + edit checks)
//   • records each install in an atomic ledger so uninstall is safe-only
//   • rejects symlinks (via hashDir) and only ever touches ids matching ^[a-z0-9-]+$

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { LIBRARY_DIR, hashDir, rollupHash } from "../../scripts/lock-skill-library.mjs";
import { gitFetchSubdir } from "../../scripts/lock-marketplace.mjs";
import { copyDir, ensureGitignore } from "../../scripts/connector.mjs";
import { readSkills, frontmatter } from "../../scripts/gen-catalog.mjs";
import { scanSkill } from "../../scripts/skill-scan.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GEN_CATALOG = path.join(SCRIPT_DIR, "..", "..", "scripts", "gen-catalog.mjs");
const ID_RE = /^[a-z0-9-]+$/;

function manifest() {
  return JSON.parse(readFileSync(path.join(LIBRARY_DIR, "index.json"), "utf8"));
}
function referenced() {
  try {
    return JSON.parse(readFileSync(path.join(LIBRARY_DIR, "referenced.json"), "utf8"));
  } catch {
    return { skills: [], docs_url: "" };
  }
}
// Community (non-official) skills — NO first-party provenance, gated behind scan+consent.
function communityManifest() {
  try {
    const j = JSON.parse(readFileSync(path.join(LIBRARY_DIR, "community.json"), "utf8"));
    if (Array.isArray(j.skills)) return j;
  } catch {
    /* none */
  }
  return { skills: [] };
}
// Marketplace (first-party vetted) skills — a LIVE catalog, fetched-on-install + byte-diffed.
function marketplaceManifest() {
  try {
    const j = JSON.parse(readFileSync(path.join(LIBRARY_DIR, "marketplace.json"), "utf8"));
    if (Array.isArray(j.skills)) return j;
  } catch {
    /* none */
  }
  return { skills: [] };
}

// Resolve a skill id → { tier, ... }. Official skills live at LIBRARY_DIR/<id>; community
// skills declare a source dir (vendored-demo) inside the library tree; marketplace skills
// declare an upstream {repo,commit,path_in_repo} and are FETCHED on demand (no local dir).
// A local sourceDir is always confined to LIBRARY_DIR (id is ^[a-z0-9-]+$; source paths are
// repo-controlled, not user input) — no path traversal from a request.
function resolveSource(id) {
  const off = manifest().skills.find((s) => s.id === id);
  if (off)
    return {
      tier: "official",
      sourceDir: path.join(LIBRARY_DIR, id),
      entry: off,
      commit: manifest().upstream_commit,
    };
  const mkt = marketplaceManifest().skills.find((s) => s.id === id);
  if (mkt)
    return {
      tier: "marketplace",
      sourceDir: null,
      entry: mkt,
      commit: (mkt.source && mkt.source.commit) || null,
    };
  const com = communityManifest().skills.find((s) => s.id === id);
  if (com) {
    const rel = (com.source && com.source.dir) || `community/${id}`;
    const dir = path.resolve(LIBRARY_DIR, rel);
    if (!dir.startsWith(path.resolve(LIBRARY_DIR) + path.sep))
      throw new Error(`community source escapes library: ${id}`);
    return {
      tier: "community",
      sourceDir: dir,
      entry: com,
      commit: (com.source && com.source.upstream_commit) || null,
    };
  }
  throw new Error(`unknown skill '${id}'`);
}

/**
 * Fetch a marketplace skill to a temp dir AND verify the fetched bytes byte-for-byte
 * against the catalog's declared per-file sha256. REFUSES on any mismatch — a tampered or
 * drifted upstream cannot be installed or scanned. Runs `fn(verifiedDir)` and always
 * cleans the temp dir afterward. `entry` is a marketplace catalog entry.
 *
 * The byte-diff is the authenticity anchor for this tier (the source is NOT vendored, so
 * we cannot trust the upstream at fetch time — only the committed catalog hashes).
 */
function withMarketplaceSource(entry, fn) {
  const src = entry.source || {};
  if (!src.repo || !src.commit || !src.path_in_repo)
    throw new Error(`'${entry.id}' has no valid marketplace source`);
  if (!Array.isArray(entry.files) || entry.files.length === 0)
    throw new Error(`'${entry.id}' declares no files to verify`);

  let fetched;
  try {
    fetched = gitFetchSubdir(src.repo, src.commit, src.path_in_repo);
  } catch (e) {
    throw new Error(
      `could not fetch '${entry.id}' from ${src.repo}@${String(src.commit).slice(0, 7)} — ${e.message} (marketplace installs need network access)`
    );
  }

  try {
    // hashDir throws on symlinks; the byte-diff below is order-independent.
    const got = hashDir(fetched.dir);
    const want = entry.files;
    const gotMap = new Map(got.map((f) => [f.path, f.sha256]));
    const wantMap = new Map(want.map((f) => [f.path, f.sha256]));
    const mismatches = [];
    for (const [p, sha] of wantMap) {
      if (!gotMap.has(p)) mismatches.push(`missing ${p}`);
      else if (gotMap.get(p) !== sha) mismatches.push(`hash mismatch ${p}`);
    }
    for (const p of gotMap.keys()) if (!wantMap.has(p)) mismatches.push(`unexpected ${p}`);
    if (mismatches.length) {
      throw new Error(
        `authenticity check FAILED for '${entry.id}' — fetched bytes do not match the pinned catalog (${mismatches.slice(0, 5).join("; ")}${mismatches.length > 5 ? "; …" : ""})`
      );
    }
    return fn(fetched.dir, rollupHash(want));
  } finally {
    fetched.cleanup();
  }
}

/**
 * Static, advisory scan of a skill's source by id. Pure read — never installs.
 * Marketplace skills are fetched+verified to a temp dir, scanned, then cleaned up.
 * Returns { id, tier, riskClass, findings, counts, requiresTypedConfirm }.
 */
export function scanSkillById(id) {
  if (!ID_RE.test(id)) throw new Error("bad skill id");
  const { tier, sourceDir, entry } = resolveSource(id);
  const res =
    tier === "marketplace"
      ? withMarketplaceSource(entry, (dir) => scanSkill(dir))
      : scanSkill(sourceDir);
  return {
    id,
    tier,
    name: entry.name || id,
    riskClass: res.riskClass,
    findings: res.findings,
    counts: res.counts,
    bundlesCode: res.bundlesCode,
    // Typed confirm is community-only: marketplace is first-party vetted (advisory scan).
    requiresTypedConfirm: res.riskClass === "high" && tier === "community",
  };
}
function ledgerPath(repo) {
  return path.join(repo, ".aios", "skills-installed.json");
}
function readLedger(repo) {
  try {
    const j = JSON.parse(readFileSync(ledgerPath(repo), "utf8"));
    if (Array.isArray(j.skills)) return j;
  } catch {
    /* fresh */
  }
  return { skills: [] };
}
function writeLedger(repo, led) {
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  const tmp = ledgerPath(repo) + ".tmp";
  writeFileSync(tmp, JSON.stringify(led, null, 2) + "\n");
  renameSync(tmp, ledgerPath(repo)); // atomic
}
function refreshCatalog(repo) {
  try {
    execFileSync(process.execPath, [GEN_CATALOG, "--repo", repo], { stdio: "ignore" });
  } catch {
    /* best-effort */
  }
}

/** Library skills (official + marketplace + community, with installed status) + Anthropic-hosted pointers. */
export function listLibrary(repo) {
  const installed = new Set(readSkills(repo).map((s) => s.id));
  const m = manifest();
  const ref = referenced();
  const mkt = marketplaceManifest();
  // Marketplace cards are derived purely from the committed catalog (no fetch here — the
  // list stays fast/offline; bytes are fetched+verified only on scan/install).
  const marketplace = mkt.skills.map((s) => ({
    id: s.id,
    name: s.name || s.id,
    description: s.description || "",
    category: s.category || "Marketplace · Anthropic",
    trust: "marketplace",
    capabilities: {
      bundles_code: (s.files || []).some((f) =>
        /\.(py|mjs|cjs|js|jsx|ts|tsx|sh|bash|zsh|rb|go|pl|php|ps1)$/i.test(f.path)
      ),
    },
    source: {
      repo: s.source?.repo,
      commit: s.source?.commit,
      path_in_repo: s.source?.path_in_repo,
    },
    bundled: false,
    installed: installed.has(s.id),
  }));
  const community = communityManifest().skills.map((s) => {
    // Compute a lightweight per-skill summary from SKILL.md frontmatter (no scan here —
    // scanning is on demand, so the list stays fast). riskClass is fetched on Review.
    let description = "";
    try {
      description = (
        frontmatter(
          readFileSync(
            path.join(LIBRARY_DIR, (s.source && s.source.dir) || `community/${s.id}`, "SKILL.md"),
            "utf8"
          )
        ).description || ""
      )
        .replace(/\s+/g, " ")
        .trim();
    } catch {
      /* keep empty */
    }
    return {
      id: s.id,
      name: s.name || s.id,
      description,
      category: s.category || "Community (unverified)",
      trust: "community",
      provenance: null,
      bundled: false,
      installed: installed.has(s.id),
    };
  });
  return {
    skills: m.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      license: s.license,
      trust: "official",
      provenance: s.provenance,
      capabilities: s.capabilities,
      bundled: true,
      installed: installed.has(s.id),
    })),
    marketplace,
    community,
    referenced: ref.skills || [],
    referenced_docs_url: ref.docs_url || "",
    upstream_commit: m.upstream_commit,
    marketplace_upstream_commit: mkt.upstream_commit || "",
  };
}

function libEntry(id) {
  const m = manifest();
  const entry = m.skills.find((s) => s.id === id);
  if (!entry) throw new Error(`unknown library skill '${id}'`);
  return { entry, commit: m.upstream_commit };
}

// Post-vendoring integrity guard: the OFFICIAL vendored snapshot must still match the
// lock. (Community skills have no manifest lock yet — fetch-on-install + upstream
// byte-diff is DEFERRED; see docs/plan-skills-untrusted-install.md. We still hash the
// community source so the ledger + safe-uninstall work identically.)
function verifyIntegrity(id, entry) {
  const rollup = rollupHash(hashDir(path.join(LIBRARY_DIR, id))); // hashDir throws on symlink
  if (rollup !== rollupHash(entry.files)) {
    throw new Error(`integrity check failed for '${id}' — vendored files do not match the lock`);
  }
  return rollup;
}

// Copy a verified source dir → .claude/skills/<id>, enforcing the no-overwrite collision
// guard, refreshing the catalog, and recording the install in the ledger. `rollup` is the
// authenticity rollup the ledger records (so safe-uninstall can detect later edits).
function landSkill(repo, id, tier, commit, sourceDir, rollup) {
  const dest = path.join(repo, ".claude", "skills", id);
  if (existsSync(dest)) {
    // Collision: only allowed as a clean re-install of the SAME skill —
    // i.e. the ledger recorded this rollup AND the on-disk copy is unmodified.
    const rec = readLedger(repo).skills.find((s) => s.id === id);
    const onDisk = rollupHash(hashDir(dest));
    if (!(rec && rec.sha === rollup && onDisk === rollup)) {
      throw new Error(
        `'${id}' already exists in .claude/skills — refusing to overwrite a non-library or modified skill`
      );
    }
  }
  copyDir(sourceDir, dest);
  ensureGitignore(repo, [".aios/"]); // self-heal: older workspaces may not ignore .aios/
  refreshCatalog(repo);

  const led = readLedger(repo);
  led.skills = led.skills.filter((s) => s.id !== id);
  led.skills.push({
    id,
    tier,
    upstream_commit: commit,
    sha: rollup,
    installedAt: new Date().toISOString(),
  });
  writeLedger(repo, led);
  return { id, installed: true, tier };
}

/**
 * Install a skill. `consent` gates NON-official tiers:
 *   • official    — one-click; consent ignored.
 *   • marketplace — fetched-on-install at the pinned repo@commit and byte-diffed against
 *                   the catalog (refused on mismatch). First-party vetted, so the scan is
 *                   ADVISORY: install requires only consent.accepted === true (no typed
 *                   confirm, even on a `high` scan).
 *   • community   — requires consent.accepted === true; a `high` scan additionally
 *                   requires consent.typed === id (a TYPED confirm). The scan is advisory.
 */
export function installSkill(repo, id, consent = {}) {
  if (!ID_RE.test(id)) throw new Error("bad skill id");
  const { tier, sourceDir, commit } = resolveSource(id);

  if (tier === "official") {
    const rollup = verifyIntegrity(id, libEntry(id).entry);
    return landSkill(repo, id, tier, commit, path.join(LIBRARY_DIR, id), rollup);
  }

  if (tier === "marketplace") {
    // Fetch + byte-diff verify (refuses on mismatch), then advisory scan + simple accept.
    const { entry } = resolveSource(id);
    return withMarketplaceSource(entry, (dir, rollup) => {
      const scan = scanSkill(dir);
      if (!consent || consent.accepted !== true) {
        const err = new Error(
          `'${id}' is a marketplace skill (first-party vetted) — install requires accepting after reviewing the scan`
        );
        err.scan = { riskClass: scan.riskClass, counts: scan.counts, requiresTypedConfirm: false };
        throw err;
      }
      // No typed confirm for marketplace — vetted source; the scan is advisory only.
      return landSkill(repo, id, tier, commit, dir, rollup);
    });
  }

  // Community: run the advisory scan and enforce consent proportional to risk.
  const scan = scanSkill(sourceDir); // hashDir-equivalent walk; throws on symlink below via hashDir
  if (!consent || consent.accepted !== true) {
    const err = new Error(
      `'${id}' is a community (non-official) skill — install requires explicit consent after reviewing the scan`
    );
    err.scan = {
      riskClass: scan.riskClass,
      counts: scan.counts,
      requiresTypedConfirm: scan.riskClass === "high",
    };
    throw err;
  }
  if (scan.riskClass === "high" && consent.typed !== id) {
    const err = new Error(
      `'${id}' scanned HIGH risk — type the skill id to confirm you accept the risk`
    );
    err.scan = { riskClass: scan.riskClass, counts: scan.counts, requiresTypedConfirm: true };
    throw err;
  }
  const rollup = rollupHash(hashDir(sourceDir)); // throws on symlink — same guard as official
  return landSkill(repo, id, tier, commit, sourceDir, rollup);
}

export function uninstallSkill(repo, id) {
  if (!ID_RE.test(id)) throw new Error("bad skill id");
  const dest = path.join(repo, ".claude", "skills", id);
  const led = readLedger(repo);
  const rec = led.skills.find((s) => s.id === id);

  if (!existsSync(dest)) {
    // nothing on disk → drop any stale ledger entry
    led.skills = led.skills.filter((s) => s.id !== id);
    writeLedger(repo, led);
    return { id, installed: false };
  }
  if (!rec)
    throw new Error(
      `'${id}' was not installed from the library — refusing to delete (it may be user-authored)`
    );
  if (rollupHash(hashDir(dest)) !== rec.sha) {
    throw new Error(
      `'${id}' has local edits since install — refusing to delete; remove it by hand if you really mean to`
    );
  }
  rmSync(dest, { recursive: true, force: true });
  led.skills = led.skills.filter((s) => s.id !== id);
  writeLedger(repo, led);
  refreshCatalog(repo);
  return { id, installed: false };
}
