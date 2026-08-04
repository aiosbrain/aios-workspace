import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compactSkillIndex,
  loadSkillContext,
  loadSkillSuite,
  normalizeSkillText,
  parseDeclaredSkills,
  routeSkillPrompt,
  skillSha256,
} from "../scripts/skill-context.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");

function entry(id, overrides = {}) {
  return {
    id,
    path: `${id}/SKILL.md`,
    stages: ["builder", "interactive"],
    routing: { positive: [`use ${id}`], negative: [`do not use ${id}`] },
    mutability: "local-write",
    max_bytes: 6000,
    conflicts: [],
    prerequisites: [],
    explicit_invocation_required: false,
    ...overrides,
  };
}

function tempSuite(entries = [entry("alpha-skill")], bodies = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "delivery-skill-suite-"));
  mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
  for (const skill of entries) {
    const dir = path.join(repo, ".claude", "skills", skill.id);
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "SKILL.md"),
      bodies[skill.id] ??
        `---\nname: ${skill.id}\ndescription: Use for ${skill.id} tests.\n---\n\n# ${skill.id}\n`
    );
  }
  writeFileSync(
    path.join(repo, ".claude", "skill-suite.json"),
    JSON.stringify({
      version: 1,
      limits: {
        compact_index_bytes: 1500,
        stage_skill_bytes: 6000,
        builder_total_bytes: 10000,
        builder_skill_count: 2,
      },
      skills: entries,
    })
  );
  return repo;
}

test("first-party suite loads canonical skills and keeps its pointer under budget", () => {
  const suite = loadSkillSuite({ repo: REPO });
  assert.equal(suite.skills.length, 14);
  assert.ok(suite.skills.every((skill) => skill.id === path.basename(path.dirname(skill.file))));
  const compact = compactSkillIndex({ repo: REPO });
  assert.ok(compact.bytes <= 1500);
});

test("line endings are normalized before exact byte hashing", () => {
  const body = "---\r\nname: alpha-skill\r\ndescription: Alpha.\r\n---\r\n\r\n# Alpha\r\n";
  const repo = tempSuite([entry("alpha-skill")], { "alpha-skill": body });
  try {
    const skill = loadSkillSuite({ repo }).skills[0];
    assert.equal(skill.body, normalizeSkillText(body));
    assert.equal(skill.sha256, skillSha256(normalizeSkillText(body)));
    assert.equal(skill.bytes, Buffer.byteLength(normalizeSkillText(body)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("loader rejects symlinked skill paths before reading them", () => {
  const repo = tempSuite();
  const target = path.join(repo, "outside.md");
  writeFileSync(target, "---\nname: alpha-skill\ndescription: Outside.\n---\n");
  rmSync(path.join(repo, ".claude", "skills", "alpha-skill", "SKILL.md"));
  symlinkSync(target, path.join(repo, ".claude", "skills", "alpha-skill", "SKILL.md"));
  try {
    assert.throws(() => loadSkillSuite({ repo }), /symlink is not allowed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("selection rejects unknown, conflicting, and stage-incompatible skills", () => {
  const entries = [
    entry("alpha-skill", { conflicts: ["beta-skill"] }),
    entry("beta-skill", { conflicts: ["alpha-skill"] }),
    entry("review-only", { stages: ["review"] }),
  ];
  const repo = tempSuite(entries);
  try {
    assert.throws(
      () => loadSkillContext({ repo, ids: ["missing"], stage: "builder" }),
      /unknown skill/
    );
    assert.throws(
      () => loadSkillContext({ repo, ids: ["alpha-skill", "beta-skill"], stage: "builder" }),
      /conflicts/
    );
    assert.throws(
      () => loadSkillContext({ repo, ids: ["review-only"], stage: "builder" }),
      /not allowed/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("builder selection enforces count and aggregate byte caps without truncation", () => {
  const entries = [entry("alpha-skill"), entry("beta-skill"), entry("gamma-skill")];
  const repo = tempSuite(entries);
  try {
    assert.throws(
      () =>
        loadSkillContext({
          repo,
          ids: ["alpha-skill", "beta-skill", "gamma-skill"],
          stage: "builder",
        }),
      /exceeds 2 skills/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("spec declarations parse list and inline forms and reject duplicates", () => {
  assert.deepEqual(
    parseDeclaredSkills("---\nskills:\n  - alpha-skill\n  - beta-skill\n---\n# Spec"),
    ["alpha-skill", "beta-skill"]
  );
  assert.deepEqual(parseDeclaredSkills("---\nskills: [alpha-skill, beta-skill]\n---"), [
    "alpha-skill",
    "beta-skill",
  ]);
  assert.throws(
    () => parseDeclaredSkills("---\nskills: [alpha-skill, alpha-skill]\n---"),
    /duplicates/
  );
});

test("external-write skills never route semantically but explicit invocation works", () => {
  const suite = loadSkillSuite({ repo: REPO });
  assert.equal(routeSkillPrompt({ suite, prompt: "publish this spec to Linear" }), null);
  for (const prompt of [
    "Use $linear-publish-spec for AIO-1.",
    "Use /linear-publish-spec for AIO-1.",
    "$linear-publish-spec",
    "Please (use $linear-publish-spec).",
    "Try `/linear-publish-spec`.",
  ]) {
    assert.equal(routeSkillPrompt({ suite, prompt })?.id, "linear-publish-spec", prompt);
  }

  for (const prompt of [
    "Use $linear-publish-spec-typo.",
    "Use /linear-publish-spec-typo.",
    "See https://example.test/linear-publish-spec",
    "Read docs/linear-publish-spec/SKILL.md",
    "Ignore prefix$linear-publish-spec",
    "Ignore prefix/linear-publish-spec",
    "Use /linear-publish-spec/SKILL.md",
  ]) {
    assert.equal(routeSkillPrompt({ suite, prompt }), null, prompt);
  }
});
