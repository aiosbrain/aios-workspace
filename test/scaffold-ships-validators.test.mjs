// test/scaffold-ships-validators.test.mjs — AIO-965: a scaffolded workspace can run every
// validator its own governance docs cite, in place, without reaching into the toolkit repo.
//
// THE REGRESSION THIS PINS. The scaffold used to copy `validation/secret-patterns.txt` and nothing
// else, while stamping `.claude/` rules and READMEs that instructed the agent to run
// check-rubrics.sh, check-frontmatter.sh and friends. So every workspace claimed guards it did not
// carry — and a claimed check that never runs reads exactly like a passing one. Asserting on a
// hardcoded list of filenames would only re-encode today's answer, so the important test here is
// the DERIVED one: whatever the scaffolded docs cite must be present and runnable.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");

function scaffold(output) {
  execFileSync(
    "bash",
    [
      SCAFFOLD_SCRIPT,
      "--context",
      "employee",
      "--slug",
      "val-ws",
      "--owner",
      "tester",
      "--output",
      output,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
}

function freshOutput(prefix) {
  const output = mkdtempSync(path.join(tmpdir(), prefix));
  rmSync(output, { recursive: true, force: true });
  return output;
}

function markdownFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) markdownFiles(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * Citations the scaffolded docs make that are NOT claims the workspace enforces something. Kept
 * in step with NOT_ENFORCEMENT_CLAIMS in validation/check-citations.mjs — see the rationale there.
 */
const EXEMPT = new Set(["check-modularity.mjs", "check-ledger.sh"]);

test("a scaffolded workspace ships every validator its own .claude/ docs cite", () => {
  const output = freshOutput("scaffold-validators-");
  try {
    scaffold(output);

    const cited = new Map();
    for (const file of markdownFiles(path.join(output, ".claude"))) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /validation\/([A-Za-z0-9_.-]+\.(?:sh|mjs|json|txt))/g
      )) {
        if (!cited.has(m[1])) cited.set(m[1], []);
        cited.get(m[1]).push(path.relative(output, file));
      }
    }
    assert.ok(
      cited.size > 0,
      "no validator citations found — the scan or the scaffold changed shape"
    );

    for (const [validator, docs] of cited) {
      if (EXEMPT.has(validator)) continue;
      const target = path.join(output, "validation", validator);
      assert.ok(
        existsSync(target),
        `${validator} is cited by ${docs.join(", ")} but was not shipped`
      );
      if (/\.(sh|mjs)$/.test(validator)) {
        // Present but not runnable is the same broken promise with extra steps.
        assert.doesNotThrow(
          () => accessSync(target, constants.X_OK),
          `${validator} was shipped but is not executable`
        );
      }
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("OGR16 rejects a missing validator cited by a shipped markdown template", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "citation-template-"));
  try {
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    mkdirSync(path.join(repo, "scaffold", ".claude"), { recursive: true });
    mkdirSync(path.join(repo, "validation"), { recursive: true });
    writeFileSync(
      path.join(repo, "scripts", "toolkit-manifest.mjs"),
      'export const MANAGED_PATHS = [{ dest: "validation/check-frontmatter.sh" }];\n'
    );
    writeFileSync(
      path.join(repo, "scripts", "scaffold-validators.sh"),
      'cp "$REPO_ROOT/validation/check-frontmatter.sh" "$OUTPUT/validation/check-frontmatter.sh"\n'
    );
    writeFileSync(path.join(repo, "scripts", "scaffold-project.sh"), "");
    writeFileSync(path.join(repo, "validation", "check-frontmatter.sh"), "#!/bin/bash\n");
    writeFileSync(
      path.join(repo, "scaffold", ".claude", "CLAUDE.md.tmpl"),
      "Run `validation/check-missing.mjs` before claiming success.\n"
    );

    let code = 0;
    let out = "";
    try {
      out = execFileSync("node", [path.join(ROOT, "validation", "check-citations.mjs"), repo], {
        encoding: "utf8",
      });
    } catch (error) {
      code = error.status ?? 1;
      out = (error.stdout ?? "") + (error.stderr ?? "");
    }

    assert.equal(code, 1, out);
    assert.match(out, /check-missing\.mjs/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the vendored validators resolve their helper imports with no node_modules", () => {
  const output = freshOutput("scaffold-validator-deps-");
  try {
    scaffold(output);
    // A scaffolded workspace has never had an npm install. In THIS repo scripts/git-files.mjs and
    // scripts/runtimes.mjs are shims re-exporting packages/foundation (AIO-601), which a workspace
    // has no copy of — so the real modules must be vendored under the path the importers use.
    assert.ok(
      !existsSync(path.join(output, "node_modules")),
      "scaffold unexpectedly created node_modules"
    );
    for (const helper of ["scripts/git-files.mjs", "scripts/runtimes.mjs"]) {
      const src = readFileSync(path.join(output, helper), "utf8");
      assert.ok(
        !src.includes("packages/foundation"),
        `${helper} was vendored as the re-export shim — it would resolve a packages/ tree the workspace does not have`
      );
    }
    // The importers must actually load. agent-readiness-lib is the one that pulls git-files.
    execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(path.join(output, "validation", "agent-readiness-lib.mjs"))})`,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      }
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("validate-all.sh auto-detects workspace mode and runs to completion", () => {
  const output = freshOutput("scaffold-validate-all-");
  try {
    scaffold(output);
    // Toolkit-only validators must NOT be shipped: four of them take no argv at all and would
    // grade aios-workspace while appearing to grade this workspace.
    for (const toolkitOnly of [
      "check-scaffold-guard.mjs",
      "check-scaffold-git-workflow.mjs",
      "check-opencode-scaffold.mjs",
      "check-runtime-adapters.mjs",
      "check-modularity.mjs",
      "check-delivery-skill-suite.mjs",
    ]) {
      assert.ok(
        !existsSync(path.join(output, "validation", toolkitOnly)),
        `${toolkitOnly} is toolkit-only but was shipped into the workspace`
      );
    }

    // Exit code is deliberately NOT asserted: a fresh workspace can legitimately carry advisory
    // warnings. What matters is that the run COMPLETES rather than dying on a missing script or
    // an unresolvable import, and that it chose workspace mode without being told.
    let stdout = "";
    try {
      stdout = execFileSync("bash", [path.join(output, "validation", "validate-all.sh"), output], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      stdout = err.stdout ?? "";
    }
    assert.match(stdout, /Mode: --workspace/, "validate-all.sh did not auto-detect workspace mode");
    assert.match(stdout, /OGR16/, "the citation check did not run in workspace mode");
    assert.doesNotMatch(
      stdout,
      /No such file or directory/,
      "a shipped validator was missing at run time"
    );
    assert.doesNotMatch(
      stdout,
      /ERR_MODULE_NOT_FOUND/,
      "a shipped validator failed to resolve an import"
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("H1 counting ignores fenced code blocks", async () => {
  // AIO-965: check-skill-export.mjs counted `^# ` with /gm, so a `# comment` inside a ```bash
  // fence read as a heading. Four correct skills in a real workspace failed on it —
  // aios-spec-write reported 6 H1s for one heading plus five shell comments in its worked
  // example. A validator that fires on correct content is one people learn to route around.
  // countH1 is module-private. Re-derive it from source rather than widening the validator's
  // API for a test.
  const src = readFileSync(path.join(ROOT, "validation", "check-skill-export.mjs"), "utf8");
  const body = src.slice(src.indexOf("function countH1"), src.indexOf("\nconst repo ="));
  const { countH1 } = await import(
    `data:text/javascript,${encodeURIComponent(`${body}\nexport { countH1 };`)}`
  );

  assert.equal(countH1("# Title\n\nprose"), 1);
  assert.equal(
    countH1("# Title\n\n```bash\n# 1. step one\n# 2. step two\n```\n"),
    1,
    "shell comments inside a fence must not count"
  );
  assert.equal(countH1("# One\n\n# Two\n"), 2, "two real headings still count as two");
  assert.equal(countH1("# Title\n\n~~~sh\n# fake\n~~~\n"), 1, "tilde fences must be tracked too");
  assert.equal(
    countH1("# Title\n\n````\n```\n# still fenced\n````\n"),
    1,
    "a longer fence is closed only by an equally long marker"
  );
});
