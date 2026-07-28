// Baseline (name-free) leak-gate rules — the layer that protects a contributor who has no
// private term set, and therefore the layer that would have prevented the real incident.
//
// Context: the gate used to `exit 0` with "SKIPPED" whenever no term set was configured. An
// external contributor CANNOT have that file (shipping it would enumerate the protected names),
// so for every contributor the gate was decorative — while CONTRIBUTING.md told them to run it
// and expect a clean result. A client prospect brief reached a branch of this PUBLIC repo that
// way. These tests pin the fix: baseline rules always run, and they key on SHAPE, so an
// unregistered client is caught too.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "leak-gate.sh"
);

/** Run the gate with NO term set — i.e. exactly a contributor's machine. */
function runGateWithoutTerms(root) {
  const env = { ...process.env, AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file" };
  delete env.AIOS_LEAK_TERMS_B64;
  try {
    const stdout = execFileSync("bash", [GATE, root], { encoding: "utf8", env, stdio: "pipe" });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function runGateWithEncodedTerms(root, terms) {
  const env = {
    ...process.env,
    AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file",
    AIOS_LEAK_TERMS_B64: Buffer.from(terms).toString("base64"),
  };
  try {
    const stdout = execFileSync("bash", [GATE, root], { encoding: "utf8", env, stdio: "pipe" });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function runGateWithMalformedEncodedTerms(root) {
  const env = {
    ...process.env,
    AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file",
    AIOS_LEAK_TERMS_B64: "%%%not-base64%%%",
  };
  const result = spawnSync("bash", [GATE, root], { encoding: "utf8", env });
  return { code: result.status, stdout: `${result.stdout}${result.stderr}` };
}

/**
 * A throwaway git repo containing exactly `files` ({ relPath: contents }), carrying the
 * toolkit's signature (`scaffold/` + `scripts/leak-gate.sh`).
 *
 * That signature matters: the baseline rules describe what may not appear in THE PRODUCT REPO,
 * and the same gate is also run against workspace-shaped roots (`aios promote` passes one
 * deliverable copied out of a workspace) where `2-work/` and `clients/<name>/` are normal. See
 * the companion test below that pins the non-product case.
 */
function repoWith(files, { productRepo = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "aios-leak-baseline-"));
  execFileSync("git", ["init", "-q", root], { stdio: "pipe" });
  const all = productRepo
    ? { "scaffold/.keep": "", "scripts/leak-gate.sh": "#!/usr/bin/env bash\n", ...files }
    : files;
  for (const [rel, body] of Object.entries(all)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  execFileSync("git", ["-C", root, "add", "-A"], { stdio: "pipe" });
  return root;
}

test("a clean tree passes, and the run states that identifiers were NOT checked", () => {
  const root = repoWith({ "src/index.ts": "export const x = 1;\n" });
  try {
    const { code, stdout } = runGateWithoutTerms(root);
    assert.equal(code, 0, "a clean tree must pass");
    // Deliberately NOT the word "CLEAN": with no term set nothing about identifiers was
    // verified, and claiming clean is precisely the false assurance this change removes.
    assert.doesNotMatch(stdout, /CLEAN/, "must not claim CLEAN when identifiers went unchecked");
    assert.match(stdout, /baseline rules passed/);
    // The old message said only "CLEAN"/"SKIPPED", which is what let a contributor believe a
    // no-op run had checked something. Coverage must be stated, not implied.
    assert.match(stdout, /NOT checked/, "must disclose that no term set was loaded");
    // The SKIPPED marker must survive on the last line: scripts/timeline.mjs keys on it to
    // withhold an EXTERNAL render when the identifier sweep could not run.
    const lastLine = stdout.trim().split("\n").at(-1).trim();
    assert.match(lastLine, /^leak-gate: SKIPPED\b/, "marker line shape is a pinned contract");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real incident is caught with NO term set and NO client name in the file", () => {
  // The prospect brief that leaked was identifiable from its LOCATION alone. Contents here are
  // deliberately innocuous to prove the baseline does not depend on knowing any name.
  const root = repoWith({
    "docs/bd/prospect-someone-somecorp.md": "---\ntitle: brief\n---\n\nNothing sensitive here.\n",
  });
  try {
    const { code, stdout } = runGateWithoutTerms(root);
    assert.equal(code, 1, "a BD prospect brief must not pass the gate");
    assert.match(stdout, /workspace\/client material in the product repo/);
    assert.match(stdout, /FAILED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an UNREGISTERED client directory is caught — the gap a name list cannot close", () => {
  const root = repoWith({ "2-work/clients/never-registered/notes.md": "meeting notes\n" });
  try {
    assert.equal(runGateWithoutTerms(root).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a personal workspace spine committed into the product repo is caught", () => {
  const root = repoWith({ "3-log/decision-log.md": "| id | decision |\n" });
  try {
    assert.equal(runGateWithoutTerms(root).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink at a confidential product path is caught without following its target", () => {
  const root = repoWith({ "safe-target.md": "safe\n" });
  try {
    mkdirSync(path.join(root, "docs", "bd"), { recursive: true });
    symlinkSync("../../safe-target.md", path.join(root, "docs", "bd", "prospect.md"));
    assert.equal(runGateWithoutTerms(root).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a protected identifier in a symlink payload is scanned without following the link", () => {
  const root = repoWith({});
  try {
    mkdirSync(path.join(root, "notes"), { recursive: true });
    symlinkSync("sensitiveclient-name", path.join(root, "notes", "reference"));
    const { code } = runGateWithEncodedTerms(root, "STRONG='sensitiveclient-name'\n");
    assert.equal(code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-only frontmatter outside the teaching trees is caught", () => {
  const root = repoWith({ "notes/private-thing.md": "---\naccess: admin\n---\n\nowner only\n" });
  try {
    assert.equal(runGateWithoutTerms(root).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-only frontmatter with an inline comment is caught", () => {
  const root = repoWith({
    "notes/private-thing.md": "---\naccess: private # owner-only scratch\n---\n\nowner only\n",
  });
  try {
    assert.equal(runGateWithoutTerms(root).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-only frontmatter is caught however long the frontmatter block is", () => {
  // A fixed line window let a long header push `access:` out of view. Frontmatter is a fenced
  // block with no length limit, so the scan follows the fence, not a line count.
  const filler = Array.from({ length: 40 }, (_, i) => `field_${i}: value\n`).join("");
  const root = repoWith({
    "notes/private-thing.md": `---\n${filler}access: admin\n---\n\nowner only\n`,
  });
  try {
    assert.equal(runGateWithoutTerms(root).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prose merely discussing an access key is not mistaken for a tier-marked file", () => {
  // The widened scan must not start flagging documentation. Frontmatter ends at its fence.
  const root = repoWith({
    "notes/guide.md": "---\ntitle: How tiers work\n---\n\nWrite `access: admin` to mark a file.\n",
  });
  try {
    assert.equal(runGateWithoutTerms(root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quoted, case-insensitive owner-only frontmatter is caught", () => {
  const root = repoWith({
    "notes/private-thing.md": '---\naccess: " ADMIN "\n---\n\nowner only\n',
  });
  try {
    assert.equal(runGateWithoutTerms(root).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty term payload never claims that a term-set sweep ran", () => {
  const root = repoWith({ "src/index.ts": "export const x = 1;\n" });
  try {
    const { code, stdout } = runGateWithEncodedTerms(root, "# no usable patterns\n");
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /baseline \+ term set/);
    assert.match(stdout, /SKIPPED — identifier sweep did not run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed encoded term payload fails closed", () => {
  const root = repoWith({ "src/index.ts": "export const x = 1;\n" });
  try {
    const { code, stdout } = runGateWithMalformedEncodedTerms(root);
    assert.equal(code, 2);
    assert.match(stdout, /could not be decoded safely/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the exemptions, which are what keep the gate credible ────────────────────
// A gate that fires on legitimate work gets switched off. scaffold/, examples/ and test/ have
// spine dirs and admin frontmatter as their literal subject matter.
for (const rel of [
  "scaffold/3-log/decision-log.md.tmpl",
  "examples/2-work/clients/acme/brief.md",
  "test/fixtures/1-inbox/sample.md",
]) {
  test(`exempt: ${rel} does not trip the baseline`, () => {
    const root = repoWith({ [rel]: "---\naccess: admin\n---\n\ntemplate/fixture content\n" });
    try {
      assert.equal(runGateWithoutTerms(root).code, 0, `${rel} must be exempt`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a workspace-shaped root is NOT judged by product-repo rules", () => {
  // `aios promote` scans a deliverable copied out of a workspace, and `aios timeline` a render
  // dir. There, `2-work/` and `access: admin` are the correct, expected shape — flagging them
  // would fire the gate on legitimate content, which is how a gate earns being switched off.
  const root = repoWith(
    {
      "2-work/clients/acme/brief.md":
        "---\naccess: admin\n---\n\nreal client work, correctly filed\n",
    },
    { productRepo: false }
  );
  try {
    assert.equal(runGateWithoutTerms(root).code, 0, "workspace content must not trip baseline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docs/ may carry admin frontmatter — the governance docs legitimately do", () => {
  const root = repoWith({
    "docs/v1-operator-loop/domains/inbox-governance/data-inventory.md":
      "---\naccess: admin\n---\n\ntier documentation\n",
  });
  try {
    assert.equal(runGateWithoutTerms(root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
