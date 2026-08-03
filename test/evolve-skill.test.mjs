import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const analyzer = path.join(repo, ".claude/skills/evolve/scripts/analyze_history.py");

function writeJsonl(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
}

function addSkill(root, name, description = "Test skill") {
  const file = path.join(root, name, "SKILL.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8"
  );
}

function buildFixture(root) {
  const project = path.join(root, "project");
  const sessions = path.join(root, "sessions");
  const archived = path.join(root, "archived");
  mkdirSync(project);
  addSkill(path.join(project, ".claude/skills"), "ai-code-review");
  addSkill(path.join(project, ".claude/skills"), "evolve");
  addSkill(path.join(project, ".agents/skills"), "ai-code-review");
  const history = path.join(root, "history.jsonl");
  writeJsonl(history, [
    {
      session_id: "session-one",
      ts: 2_000_000_000,
      text: "Review this pull request; token=abcdefghijklmnopqrstuvwxyz",
    },
    { session_id: "other-session", ts: 2_000_000_001, text: "Unrelated task" },
  ]);
  writeJsonl(path.join(archived, "session-one.jsonl"), [
    { type: "session_meta", payload: { session_id: "session-one", cwd: project } },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input:
          `sed -n '1,200p' RESOLVER.md CLAUDE.md ` +
          `${project}/.agents/skills/ai-code-review/SKILL.md /tmp/*/SKILL.md ` +
          `SKILL.md workdir: "${project}/.agents/skills/relative-skill"`,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: "rg unrelated src && git status AGENTS.md",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I'm using the AI code-review workflow." }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Skill usage is healthy.\nYou should consider using evolve later.",
          },
        ],
      },
    },
  ]);
  writeJsonl(path.join(sessions, "other.jsonl"), [
    {
      type: "session_meta",
      payload: { session_id: "other-session", cwd: path.join(root, "other") },
    },
  ]);
  return { project, sessions, archived, history };
}

test("evolve reports skill, routing, archive, redaction, and catalog evidence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evolve-skill-"));
  try {
    const { project, sessions, archived, history } = buildFixture(root);

    const stdout = execFileSync(
      "python3",
      [
        analyzer,
        "--history",
        history,
        "--sessions-dir",
        sessions,
        "--archived-sessions-dir",
        archived,
        "--project-root",
        project,
        "--include-prompts",
        "--json",
      ],
      { encoding: "utf8" }
    );
    const report = JSON.parse(stdout);
    assert.equal(report.session_count, 1);
    assert.equal(report.skill_usage.sessions_with_skill_evidence, 1);
    const aiReview = report.skill_usage.top_skills.find((item) => item.name === "ai-code-review");
    assert.equal(aiReview.instruction_read_occurrences, 1);
    assert.equal(aiReview.sessions_with_declaration, 1);
    assert.ok(!report.skill_usage.top_skills.some((item) => item.name === "*"));
    assert.deepEqual(report.skill_usage.routing_file_mention_sessions, {
      "AGENTS.md": 1,
      "CLAUDE.md": 1,
      "RESOLVER.md": 1,
    });
    assert.deepEqual(report.skill_usage.routing_file_likely_read_sessions, {
      "CLAUDE.md": 1,
      "RESOLVER.md": 1,
    });
    assert.deepEqual(report.skill_catalog.project_catalog_parity.claude_only, ["evolve"]);
    assert.deepEqual(report.sessions[0].usage_evidence.declared_skills, ["ai-code-review"]);
    assert.equal(report.sessions[0].usage_evidence.skill_instruction_reads["relative-skill"], 1);
    assert.match(report.sessions[0].prompts[0].text, /\[REDACTED\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evolve rejects non-positive limits", () => {
  const result = spawnSync("python3", [analyzer, "--max-sessions", "0"], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be positive/);
});
