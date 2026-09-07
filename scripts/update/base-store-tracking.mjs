import path from "node:path";
import { readFileSync } from "node:fs";
import { atomicWrite } from "../cli.mjs";
import { assertDestPathSafe } from "./manifest-walk.mjs";

// Only the index and content-addressed blobs are versioned. Other .aios state,
// including rollback/config snapshots and arbitrary files in the store, stays private.
const RULES = [
  "# AIOS versioned merge bases (all other .aios state remains ignored)",
  "!/.aios/",
  "/.aios/*",
  "!/.aios/toolkit-bases/",
  "/.aios/toolkit-bases/*",
  "!/.aios/toolkit-bases/index.json",
  `!/.aios/toolkit-bases/${"[0-9a-f]".repeat(64)}`,
].join("\n");

/** Upgrade old blanket .aios ignores without replacing any user ignore rules. */
export async function ensureBaseStoreTracked(repo) {
  assertDestPathSafe(repo, ".gitignore", "record the versioned merge-base ignore rules");
  const file = path.join(repo, ".gitignore");
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current.endsWith(`${RULES}\n`)) return;
  await atomicWrite(file, `${current}${current.endsWith("\n") ? "" : "\n"}${RULES}\n`);
}
