// gui/server/skill-library.mjs — trusted official-library install logic.
//
// v1 installs ONLY vendored, official, Apache-2.0 skills (gui/server/skill-library/),
// so safety rests on provenance + integrity, not on vetting untrusted code:
//   • install verifies the vendored snapshot against the committed lock (tamper guard)
//   • never overwrites a user-authored/edited skill (collision + edit checks)
//   • records each install in an atomic ledger so uninstall is safe-only
//   • rejects symlinks (via hashDir) and only ever touches ids matching ^[a-z0-9-]+$

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { LIBRARY_DIR, hashDir, rollupHash } from "../../scripts/lock-skill-library.mjs";
import { copyDir, ensureGitignore } from "../../scripts/connector.mjs";
import { readSkills } from "../../scripts/gen-catalog.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GEN_CATALOG = path.join(SCRIPT_DIR, "..", "..", "scripts", "gen-catalog.mjs");
const ID_RE = /^[a-z0-9-]+$/;

function manifest() { return JSON.parse(readFileSync(path.join(LIBRARY_DIR, "index.json"), "utf8")); }
function referenced() {
  try { return JSON.parse(readFileSync(path.join(LIBRARY_DIR, "referenced.json"), "utf8")); }
  catch { return { skills: [], docs_url: "" }; }
}
function ledgerPath(repo) { return path.join(repo, ".aios", "skills-installed.json"); }
function readLedger(repo) {
  try { const j = JSON.parse(readFileSync(ledgerPath(repo), "utf8")); if (Array.isArray(j.skills)) return j; } catch { /* fresh */ }
  return { skills: [] };
}
function writeLedger(repo, led) {
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  const tmp = ledgerPath(repo) + ".tmp";
  writeFileSync(tmp, JSON.stringify(led, null, 2) + "\n");
  renameSync(tmp, ledgerPath(repo)); // atomic
}
function refreshCatalog(repo) {
  try { execFileSync(process.execPath, [GEN_CATALOG, "--repo", repo], { stdio: "ignore" }); } catch { /* best-effort */ }
}

/** Library skills (with installed status) + the non-installable Anthropic-hosted pointers. */
export function listLibrary(repo) {
  const installed = new Set(readSkills(repo).map((s) => s.id));
  const m = manifest();
  const ref = referenced();
  return {
    skills: m.skills.map((s) => ({
      id: s.id, name: s.name, description: s.description, category: s.category,
      license: s.license, provenance: s.provenance, capabilities: s.capabilities,
      bundled: true, installed: installed.has(s.id),
    })),
    referenced: ref.skills || [],
    referenced_docs_url: ref.docs_url || "",
    upstream_commit: m.upstream_commit,
  };
}

function libEntry(id) {
  const m = manifest();
  const entry = m.skills.find((s) => s.id === id);
  if (!entry) throw new Error(`unknown library skill '${id}'`);
  return { entry, commit: m.upstream_commit };
}

// Post-vendoring integrity guard: the vendored snapshot must still match the lock.
function verifyIntegrity(id, entry) {
  const rollup = rollupHash(hashDir(path.join(LIBRARY_DIR, id))); // hashDir throws on symlink
  if (rollup !== rollupHash(entry.files)) {
    throw new Error(`integrity check failed for '${id}' — vendored files do not match the lock`);
  }
  return rollup;
}

export function installSkill(repo, id) {
  if (!ID_RE.test(id)) throw new Error("bad skill id");
  const { entry, commit } = libEntry(id);
  const rollup = verifyIntegrity(id, entry);

  const dest = path.join(repo, ".claude", "skills", id);
  if (existsSync(dest)) {
    // Collision: only allowed as a clean re-install of the SAME library skill —
    // i.e. the ledger recorded this rollup AND the on-disk copy is unmodified.
    const rec = readLedger(repo).skills.find((s) => s.id === id);
    const onDisk = rollupHash(hashDir(dest));
    if (!(rec && rec.sha === rollup && onDisk === rollup)) {
      throw new Error(`'${id}' already exists in .claude/skills — refusing to overwrite a non-library or modified skill`);
    }
  }

  copyDir(path.join(LIBRARY_DIR, id), dest);
  ensureGitignore(repo, [".aios/"]); // self-heal: older workspaces may not ignore .aios/
  refreshCatalog(repo);

  const led = readLedger(repo);
  led.skills = led.skills.filter((s) => s.id !== id);
  led.skills.push({ id, upstream_commit: commit, sha: rollup, installedAt: new Date().toISOString() });
  writeLedger(repo, led);
  return { id, installed: true };
}

export function uninstallSkill(repo, id) {
  if (!ID_RE.test(id)) throw new Error("bad skill id");
  const dest = path.join(repo, ".claude", "skills", id);
  const led = readLedger(repo);
  const rec = led.skills.find((s) => s.id === id);

  if (!existsSync(dest)) { // nothing on disk → drop any stale ledger entry
    led.skills = led.skills.filter((s) => s.id !== id);
    writeLedger(repo, led);
    return { id, installed: false };
  }
  if (!rec) throw new Error(`'${id}' was not installed from the library — refusing to delete (it may be user-authored)`);
  if (rollupHash(hashDir(dest)) !== rec.sha) {
    throw new Error(`'${id}' has local edits since install — refusing to delete; remove it by hand if you really mean to`);
  }
  rmSync(dest, { recursive: true, force: true });
  led.skills = led.skills.filter((s) => s.id !== id);
  writeLedger(repo, led);
  refreshCatalog(repo);
  return { id, installed: false };
}
