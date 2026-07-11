/**
 * constitution.mjs — load the repo's engineering-constitution digest for prompt injection.
 *
 * docs/ENGINEERING-CONSTITUTION.md carries a short machine-readable digest between
 * agent-digest markers. Prompt builders (plan / build / review / simplify) inject that
 * digest so every agent in the pipeline sees the repo's architectural rules without
 * shipping the whole document into each prompt.
 *
 * The constitution ADVISES prompts; it never blocks a ship. A missing file or malformed
 * markers resolve to null and the pipeline proceeds without a constitution section.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export const DIGEST_START = "<!-- agent-digest:start -->";
export const DIGEST_END = "<!-- agent-digest:end -->";
export const CONSTITUTION_RELPATH = path.join("docs", "ENGINEERING-CONSTITUTION.md");

// extractDigest(markdown) → digest string or null. Pure.
export function extractDigest(text) {
  if (!text) return null;
  const start = text.indexOf(DIGEST_START);
  const end = text.indexOf(DIGEST_END);
  if (start === -1 || end === -1 || end <= start) return null;
  const body = text.slice(start + DIGEST_START.length, end).trim();
  return body || null;
}

// loadConstitutionDigest(repo) → digest or null (missing/unreadable file, no markers).
export function loadConstitutionDigest(repo, { readFile = readFileSync } = {}) {
  try {
    return extractDigest(readFile(path.join(repo, CONSTITUTION_RELPATH), "utf8"));
  } catch {
    return null;
  }
}

// constitutionPromptLines(digest) → lines to spread into a join("\n") prompt-parts array.
// Empty array when there is no digest, so builders stay byte-identical without one.
export function constitutionPromptLines(digest) {
  if (!digest) return [];
  return ["", "## Engineering constitution (binding repo architecture/quality rules)", "", digest];
}
