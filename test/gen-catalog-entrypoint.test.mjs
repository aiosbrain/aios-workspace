// test/gen-catalog-entrypoint.test.mjs — gen-catalog must actually RUN when spawned the way
// `aios update` spawns it: from a pinned snapshot under os.tmpdir().
//
// The bug this pins: the entrypoint guard compared `path.resolve(process.argv[1])` (symlinks
// intact) against `import.meta.url` (symlinks resolved by Node's module loader). On macOS
// os.tmpdir() sits behind `/var -> /private/var`, so the comparison was always false, main()
// never ran, and the process still exited 0 — so update.mjs's `catalogFailed` branch could
// not detect it either. Catalogs went stale after every `aios update`, silently.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GEN_CATALOG = path.join(ROOT, "scripts", "gen-catalog.mjs");

/** A minimal workspace with two skills and a deliberately stale INDEX.md. */
function fixtureWorkspace() {
  const ws = mkdtempSync(path.join(tmpdir(), "aios-catalog-ws-"));
  for (const name of ["alpha", "beta"]) {
    mkdirSync(path.join(ws, ".claude/skills", name), { recursive: true });
    writeFileSync(
      path.join(ws, ".claude/skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`
    );
  }
  writeFileSync(path.join(ws, ".claude/skills/INDEX.md"), "STALE — never regenerated\n");
  return ws;
}

test("gen-catalog regenerates INDEX.md when invoked through a symlinked path", () => {
  const ws = fixtureWorkspace();
  const link = mkdtempSync(path.join(tmpdir(), "aios-catalog-link-"));
  try {
    // Reach the SAME script through a symlink — the shape `aios update` always produces,
    // since its pinned snapshot lives under os.tmpdir().
    const linkedScripts = path.join(link, "scripts");
    symlinkSync(path.join(ROOT, "scripts"), linkedScripts, "dir");

    const out = execFileSync(process.execPath, [path.join(linkedScripts, "gen-catalog.mjs"), "--repo", ws], {
      encoding: "utf8",
    });

    assert.match(out, /catalog: 2 skill\(s\)/, "gen-catalog silently no-oped");
    const index = readFileSync(path.join(ws, ".claude/skills/INDEX.md"), "utf8");
    assert.doesNotMatch(index, /STALE/, "INDEX.md was never rewritten");
    assert.match(index, /alpha/);
    assert.match(index, /beta/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(link, { recursive: true, force: true });
  }
});

test("gen-catalog still runs when invoked by its real path, and stays silent when imported", () => {
  const ws = fixtureWorkspace();
  try {
    const out = execFileSync(process.execPath, [GEN_CATALOG, "--repo", ws], { encoding: "utf8" });
    assert.match(out, /catalog: 2 skill\(s\)/);

    // Importing must NOT trigger the CLI — the guard's original purpose.
    const probe = path.join(ws, "probe.mjs");
    writeFileSync(
      probe,
      `import { catalogJson } from ${JSON.stringify(GEN_CATALOG)};\n` +
        `console.log(catalogJson(${JSON.stringify(ws)}).skills.length);\n`
    );
    const imported = execFileSync(process.execPath, [probe], { encoding: "utf8" });
    assert.equal(imported.trim(), "2");
    assert.doesNotMatch(imported, /catalog: /, "importing the module ran its CLI");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
