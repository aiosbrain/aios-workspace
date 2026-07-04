// test/helpers/seed-spec-rubric.mjs — copy the repo spec-readiness rubric into a temp workspace.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUBRIC_SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.claude/rubrics/spec-readiness.md"
);

export function seedSpecRubric(repo) {
  const dest = path.join(repo, ".claude/rubrics/spec-readiness.md");
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(RUBRIC_SRC, "utf8"));
}
