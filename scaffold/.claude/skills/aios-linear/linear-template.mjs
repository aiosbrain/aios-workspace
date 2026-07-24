import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Resolve aios-issue-template from toolkit docs or workspace copy. */
export function resolveLinearTemplate(name = "aios") {
  if (name !== "aios" && name !== "pick-up-able") return null;
  const rel = path.join("docs", "agentic-ergonomics", "aios-issue-template.md");
  const candidates = [
    path.join(HERE, "..", "..", "..", "..", rel),
    path.join(process.cwd(), rel),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return null;
}

/** Apply SEARCH/REPLACE patch blocks to description text. */
export function applyDescriptionPatch(original, patchText) {
  const blockRe =
    /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
  let text = original;
  let count = 0;
  let m;
  while ((m = blockRe.exec(patchText)) !== null) {
    const search = m[1];
    const replace = m[2];
    if (!text.includes(search)) {
      throw new Error(`patch SEARCH block not found in description (${search.slice(0, 60)}…)`);
    }
    text = text.replace(search, replace);
    count++;
  }
  if (!count) {
    throw new Error("patch file has no <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks");
  }
  return text;
}
