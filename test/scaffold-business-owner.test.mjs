// AIO-351 — third scaffold context: business-owner. A real (non-interactive)
// `scaffold-project.sh --context business-owner` run must:
//   1. create the sanctioned 6-business/ sibling root (7 subdirs, each with a README.md)
//   2. keep 6-business OUT of aios.yaml's sync_include (a real, generated file — not
//      the template) — the second layer of defense beyond any file's access: tag
//   3. ship .claude/rules/access-control.md documenting the 6-business exclusion
//   4. stamp docs (README.md / .claude/CLAUDE.md / AGENTS.md) that frame all three
//      contexts (consultant / employee / business-owner) as first-class choices
// It also regression-guards that consultant/employee scaffolds are unaffected (no
// 6-business/, no leftover {{SIXBUSINESS_LINE}} placeholder).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");

function scaffold(context, output) {
  execFileSync(
    "bash",
    [
      SCAFFOLD_SCRIPT,
      "--context",
      context,
      "--slug",
      "test-ws",
      "--owner",
      "tester",
      "--output",
      output,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
}

function tmpOut(prefix) {
  const output = mkdtempSync(path.join(tmpdir(), prefix));
  rmSync(output, { recursive: true, force: true }); // scaffold refuses a non-empty existing dir
  return output;
}

const BUSINESS_SUBDIRS = [
  "engagements",
  "bookkeeping",
  "administration",
  "entities",
  "insurance",
  "partnerships",
  "portfolio",
];

test("business-owner: 6-business/ sibling root with all 7 subdirs + README each", () => {
  const output = tmpOut("scaffold-bo-tree-");
  try {
    scaffold("business-owner", output);
    assert.ok(existsSync(path.join(output, "6-business", "README.md")));
    for (const d of BUSINESS_SUBDIRS) {
      const readme = path.join(output, "6-business", d, "README.md");
      assert.ok(existsSync(readme), `6-business/${d}/README.md missing`);
      const content = readFileSync(readme, "utf8");
      assert.match(content, /access: private/, `${d}/README.md should default to access: private`);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("business-owner: 6-business is NOT in the stamped aios.yaml sync_include", () => {
  const output = tmpOut("scaffold-bo-sync-");
  try {
    scaffold("business-owner", output);
    const yaml = readFileSync(path.join(output, "aios.yaml"), "utf8");
    const includeBlock = yaml.slice(yaml.indexOf("sync_include:"), yaml.indexOf("sync_exclude:"));
    assert.doesNotMatch(includeBlock, /6-business/, "sync_include must never list 6-business");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("business-owner: access-control.md rule ships and documents the 6-business exclusion", () => {
  const output = tmpOut("scaffold-bo-rule-");
  try {
    scaffold("business-owner", output);
    const rulePath = path.join(output, ".claude", "rules", "access-control.md");
    assert.ok(existsSync(rulePath));
    const rule = readFileSync(rulePath, "utf8");
    assert.match(rule, /6-business/);
    assert.match(rule, /sync_include/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("business-owner: stamped docs frame all three contexts as first-class choices", () => {
  const output = tmpOut("scaffold-bo-docs-");
  try {
    scaffold("business-owner", output);
    const claudeMd = readFileSync(path.join(output, ".claude", "CLAUDE.md"), "utf8");
    const readme = readFileSync(path.join(output, "README.md"), "utf8");
    const agentsMd = readFileSync(path.join(output, "AGENTS.md"), "utf8");
    for (const doc of [claudeMd, readme, agentsMd]) {
      assert.match(doc, /consultant/i);
      assert.match(doc, /employee/i);
      assert.match(doc, /business-owner/i);
    }
    // No leftover unfilled placeholder in any stamped doc.
    for (const doc of [claudeMd, readme, agentsMd]) {
      assert.doesNotMatch(doc, /\{\{SIXBUSINESS_LINE\}\}/);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("consultant/employee scaffolds are unaffected: no 6-business/, no leftover placeholder", () => {
  for (const context of ["consultant", "employee"]) {
    const output = tmpOut(`scaffold-${context}-noleak-`);
    try {
      scaffold(context, output);
      assert.equal(
        existsSync(path.join(output, "6-business")),
        false,
        `${context} must not get 6-business/`
      );
      const readme = readFileSync(path.join(output, "README.md"), "utf8");
      const claudeMd = readFileSync(path.join(output, ".claude", "CLAUDE.md"), "utf8");
      const agentsMd = readFileSync(path.join(output, "AGENTS.md"), "utf8");
      for (const doc of [readme, claudeMd, agentsMd]) {
        assert.doesNotMatch(doc, /\{\{SIXBUSINESS_LINE\}\}/);
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }
});
