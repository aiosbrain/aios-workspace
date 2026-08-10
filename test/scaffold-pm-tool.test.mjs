// test/scaffold-pm-tool.test.mjs — the pm_tool seam at SCAFFOLD time (AIO-844).
//
// `aios update` enforces the same rule through MANAGED_PATHS' `pmTool` field, covered in
// test/toolkit-update.test.mjs. These are deliberately two independent implementations (bash
// vs JS) of one rule, so both need their own coverage — a green test over one proves nothing
// about the other.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");

/** The three assets pm_tool gates, workspace-relative. */
const LINEAR_ASSETS = [
  ".claude/rules/linear-factory.md",
  ".claude/skills/aios-linear",
  "docs/agentic-ergonomics/aios-issue-template.md",
];
const RUBRIC = ".claude/rubrics/spec-readiness.md";

function scaffold(output, extraArgs = []) {
  execFileSync(
    "bash",
    [
      SCAFFOLD_SCRIPT,
      "--context",
      "consultant",
      "--slug",
      "test-ws",
      "--owner",
      "tester",
      "--output",
      output,
      ...extraArgs,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
}

function freshOutput(prefix) {
  const output = mkdtempSync(path.join(tmpdir(), prefix));
  rmSync(output, { recursive: true, force: true });
  return output;
}

const yaml = (output) => readFileSync(path.join(output, "aios.yaml"), "utf8");

test("--pm-tool linear stamps a complete, working Linear factory harness", () => {
  const output = freshOutput("scaffold-pm-linear-");
  try {
    scaffold(output, ["--pm-tool", "linear"]);
    assert.match(yaml(output), /^pm_tool: linear$/m);
    for (const asset of LINEAR_ASSETS) {
      assert.ok(existsSync(path.join(output, asset)), `${asset} was not stamped`);
    }

    // The gap this whole change exists to close: linear-factory.md points the agent at both
    // of these, and before AIO-844 neither was shipped to a scaffolded workspace at all.
    const rubric = readFileSync(path.join(output, RUBRIC), "utf8");
    assert.equal(
      rubric,
      readFileSync(path.join(ROOT, RUBRIC), "utf8"),
      "the stamped rubric must be the canonical one, byte for byte"
    );
    // Criteria are TABLE ROWS (`| SR1  | … |`), not `### SR` headings — a heading-shaped
    // check silently matches zero rows and passes for the wrong reason.
    assert.ok((rubric.match(/^\| SR\d+/gm) || []).length >= 19);

    const rule = readFileSync(path.join(output, ".claude/rules/linear-factory.md"), "utf8");
    assert.match(rule, /pm_tool: linear/, "the rule must state its own precondition");
    assert.doesNotMatch(rule, /SR\d+[–-]SR\d+/, "no hardcoded SR range may survive");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

for (const pmTool of ["clickup", "none"]) {
  test(`--pm-tool ${pmTool} keeps Linear governance out of the agent's context`, () => {
    const output = freshOutput(`scaffold-pm-${pmTool}-`);
    try {
      scaffold(output, ["--pm-tool", pmTool]);
      assert.match(yaml(output), new RegExp(`^pm_tool: ${pmTool}$`, "m"));
      for (const asset of LINEAR_ASSETS) {
        assert.ok(
          !existsSync(path.join(output, asset)),
          `${asset} leaked into a ${pmTool} workspace`
        );
      }
      // The rubric is NOT gated: grading a spec is PM-tool-agnostic, and every workspace
      // needs it for `aios spec eval` whatever tracker the team uses.
      assert.ok(existsSync(path.join(output, RUBRIC)), "the rubric must ship regardless");
      // A skill catalog listing a skill that isn't there would misroute the agent.
      const index = path.join(output, ".claude/skills/INDEX.md");
      if (existsSync(index)) assert.doesNotMatch(readFileSync(index, "utf8"), /aios-linear/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
}

test("a non-interactive scaffold and an unrecognized value both fall back to linear", () => {
  // There is no TTY here, so the prompt cannot run — the default has to come from the code
  // path, not the human. And an unrecognized answer must not silently strip the harness:
  // linear is the only tool with a working implementation.
  for (const args of [[], ["--pm-tool", "jira"], ["--pm-tool", ""]]) {
    const output = freshOutput("scaffold-pm-default-");
    try {
      scaffold(output, args);
      assert.match(yaml(output), /^pm_tool: linear$/m, `args ${JSON.stringify(args)}`);
      for (const asset of LINEAR_ASSETS) assert.ok(existsSync(path.join(output, asset)));
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }
});

test("pm_tool is written exactly once, as a flat top-level scalar", () => {
  // aios.yaml is parsed by a hand-rolled flat-YAML reader (OGR04 constrains it to that
  // subset), and a duplicated key would make the parse order-dependent.
  const output = freshOutput("scaffold-pm-shape-");
  try {
    scaffold(output, ["--pm-tool", "clickup"]);
    const lines = yaml(output)
      .split("\n")
      .filter((l) => /^pm_tool:/.test(l));
    assert.equal(lines.length, 1, `expected one pm_tool line, got ${lines.length}`);
    assert.equal(lines[0], "pm_tool: clickup");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
