import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSpecAuthor, checkAuthoringConsistency } from "../scripts/spec-author.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const STRONG = readFileSync(path.join(DIR, "fixtures", "spec-eval", "strong-spec.md"), "utf8");
const RUBRIC = { raw: "rubric", frontmatter: {}, rows: [] };

test("authoring fans independent slices out to the bounded concurrency pool", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spec-author-"));
  const slices = path.join(root, "slices");
  mkdirSync(slices);
  for (const name of ["one.md", "two.md", "three.md"])
    writeFileSync(path.join(slices, name), `# ${name}`);
  let active = 0;
  let peak = 0;
  try {
    const run = await runSpecAuthor({
      plan: "# plan",
      slices: ["one.md", "two.md", "three.md"].map((name) => path.join(slices, name)),
      repo: REPO,
      rubric: RUBRIC,
      authorCfg: { model: "claude-opus-4-8" },
      concurrency: 2,
      authorFn: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
        return STRONG;
      },
    });
    assert.equal(run.results.length, 3);
    assert.equal(peak, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consistency pass deterministically surfaces duplicate titles and shared paths", () => {
  const warnings = checkAuthoringConsistency([
    { file: "a.md", specText: "# Same\n\n`src/shared.ts`" },
    { file: "b.md", specText: "# Same\n\n`src/shared.ts`" },
  ]);
  assert.deepEqual(warnings.map((warning) => warning.kind).sort(), [
    "duplicate_title",
    "shared_path",
  ]);
});
