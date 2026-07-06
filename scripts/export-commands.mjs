#!/usr/bin/env node
/**
 * export-commands.mjs — BYOA command export for OpenCode.
 *
 * Reads canonical `.claude/commands/*.md`, wraps each in OpenCode command frontmatter,
 * writes to `.opencode/command/`. Idempotent.
 *
 * Usage:
 *   node scripts/export-commands.mjs [--repo <workspace-root>]
 *   node scripts/export-commands.mjs --scaffold   # regenerate scaffold/.opencode/command/
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");

function parseArgs(argv) {
  const args = { scaffold: false, repo: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--scaffold") args.scaffold = true;
    else if (argv[i] === "--repo" && argv[i + 1]) args.repo = argv[++i];
  }
  return args;
}

function firstLineSummary(body) {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("---"));
  return (line ?? "AIOS workflow command").slice(0, 160);
}

function wrapCommand(name, sourceBody) {
  const description = firstLineSummary(sourceBody);
  return `---\ndescription: ${description.replace(/"/g, '\\"')}\n---\n\n${sourceBody.trim()}\n`;
}

function exportCommands({ commandsDir, outDir }) {
  if (!existsSync(commandsDir)) {
    console.error(`error: commands dir not found: ${commandsDir}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
  const hashes = [];
  for (const file of files.sort()) {
    const src = readFileSync(path.join(commandsDir, file), "utf8");
    if (!src.includes("$ARGUMENTS")) {
      console.warn(`warn: ${file} missing $ARGUMENTS passthrough`);
    }
    const out = wrapCommand(path.basename(file, ".md"), src);
    const outPath = path.join(outDir, file);
    writeFileSync(outPath, out, "utf8");
    hashes.push(createHash("sha256").update(out).digest("hex"));
  }
  return { count: files.length, hash: createHash("sha256").update(hashes.join("")).digest("hex") };
}

const args = parseArgs(process.argv);
const base = args.scaffold ? path.join(REPO, "scaffold") : args.repo ?? process.cwd();
const commandsDir = path.join(base, ".claude", "commands");
const outDir = path.join(base, ".opencode", "command");

const first = exportCommands({ commandsDir, outDir });
const second = exportCommands({ commandsDir, outDir });

if (first.hash !== second.hash) {
  console.error("error: export not idempotent");
  process.exit(1);
}

console.log(`exported ${first.count} command(s) → ${outDir}`);
