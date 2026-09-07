/** Exact-defect mutations in isolated copies; never modify a developer's live checker. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modules = [
  "check-workflow-policy",
  "workflow-policy-rules",
  "workflow-policy-expressions",
  "workflow-policy-values",
  "workflow-policy-catalogue",
  "workflow-policy-allowlist",
  "workflow-yaml",
];
const mutations = [
  [
    "shell env case collision",
    "values",
    "? Object.entries(env) : []",
    "? Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]) : []",
  ],
  [
    "unknown values accepted",
    "values",
    "return knownReferences(text, resolveEnv);",
    'return "safe";',
  ],
  [
    "matrix accepted",
    "values",
    "if (SAFE_PATHS.has(key))",
    'if (parts[0] === "matrix") return "safe"; if (SAFE_PATHS.has(key))',
  ],
  [
    "whole outputs accepted",
    "values",
    "if (SAFE_PATHS.has(key))",
    'if (["steps", "needs"].includes(parts[0])) return "safe"; if (SAFE_PATHS.has(key))',
  ],
  [
    "safe prefix accepted",
    "values",
    "if (SAFE_PATHS.has(key))",
    'if ([...SAFE_PATHS].some((safe) => key.startsWith(safe))) return "safe"; if (SAFE_PATHS.has(key))',
  ],
  [
    "missing env accepted",
    "values",
    'if (!definitions.has(key) || visiting.has(key)) return "unknown";',
    'if (!definitions.has(key) || visiting.has(key)) return "safe";',
  ],
  [
    "shadowing ignored",
    "values",
    "for (const key of definitions.keys()) values.delete(key);",
    "// defect: inherited values win",
  ],
  ["local actions allowed", "rules", "if (/^\\.\\.?\\//.test(uses))", "if (false)"],
  [
    "remote inputs unchecked",
    "rules",
    "auditInputs(step, jobId, tainted, add, skip);",
    "// defect: no action inputs",
  ],
  [
    "reusable inputs unchecked",
    "rules",
    "if (isPrTarget) auditInputs(job, jobId, tainted, add);",
    "// defect: no reusable inputs",
  ],
  ["missing permissions allowed", "rules", "if (effective === undefined)", "if (false)"],
  [
    "invalid permissions allowed",
    "rules",
    'Object.hasOwn(job, "permissions") && !validPermissions(job.permissions)',
    "false",
  ],
  ["job override ignored", "rules", "inherits ? doc.permissions : undefined", "doc.permissions"],
  ["secret case escape", "rules", "/gi;", "/g;"],
  ["whole secret escape", "rules", "|(?![\\s]*[.[\\w])", ""],
  [
    "missing directory accepted",
    "cli",
    "if (!statSync(dir).isDirectory())",
    "if (!existsSync(dir)) return []; if (!statSync(dir).isDirectory())",
  ],
  ["empty directory accepted", "cli", "!files.length && !parsed.opts.allowEmpty", "false"],
];

test(
  "each hardening mutation is killed by its executable policy controls",
  { timeout: 60_000 },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "workflow-mutants-"));
    try {
      mkdirSync(path.join(dir, "scripts"));
      mkdirSync(path.join(dir, "test"));
      for (const name of modules)
        copyFileSync(
          path.join(root, "scripts", `${name}.mjs`),
          path.join(dir, "scripts", `${name}.mjs`)
        );
      copyFileSync(
        path.join(root, "test/check-workflow-policy-hardening.test.mjs"),
        path.join(dir, "test/check-workflow-policy-hardening.test.mjs")
      );
      const run = () =>
        spawnSync(
          process.execPath,
          ["--test", "--test-reporter=tap", "test/check-workflow-policy-hardening.test.mjs"],
          {
            cwd: dir,
            encoding: "utf8",
            timeout: 10_000,
            env: Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST_"))
            ),
          }
        );
      const control = run();
      assert.equal(control.status, 0, control.stdout + control.stderr);
      for (const [label, module, before, after] of mutations) {
        const name = module === "cli" ? "check-workflow-policy" : `workflow-policy-${module}`;
        const file = path.join(dir, "scripts", `${name}.mjs`);
        const original = readFileSync(file, "utf8");
        assert.ok(original.includes(before), `${label}: mutation anchor missing`);
        writeFileSync(file, original.replace(before, after));
        const result = run();
        writeFileSync(file, original);
        assert.equal(
          result.status,
          1,
          `${label} survived or crashed: ${result.stdout}\n${result.stderr}`
        );
        assert.match(result.stdout, /not ok/, `${label}: must fail assertions`);
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /SyntaxError/,
          `${label}: invalid mutation`
        );
      }
      assert.equal(run().status, 0, "restored controls must pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
