#!/usr/bin/env node
// npm-menu.mjs — categorized `npm run` script discovery. A bare `npm run` dumps ~18
// scripts in package.json declaration order with zero grouping (the onboarding audit's
// "THERE ARE A LOT OF NPM RUN COMMANDS!"). `npm run help` — declared first in
// package.json so it's the first thing anyone notices — prints this instead.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Hand-maintained categorization. Exported (not just used by main()) so a test can
 * assert every script in package.json's `scripts` appears in exactly one category here
 * — the cheap regression guard for "someone added a script and forgot to categorize it."
 */
export const CATEGORIES = {
  Core: {
    description: "day-to-day use, once your workspace is set up",
    scripts: ["help", "gui", "aios", "setup"],
  },
  Dev: {
    description: "contributing to this toolkit",
    scripts: ["lint", "lint:fix", "format", "format:check", "test", "test:ux"],
  },
  Build: {
    description: "packaging the desktop app / GUI bundle",
    scripts: ["gui:build", "app:dev", "app:build", "app:icon"],
  },
  "Internal / CI": {
    description: "maintainers and automation — you rarely need these directly",
    scripts: ["gen:catalog", "build:loop", "check:docs", "check:v1-linear", "pr:backlog"],
  },
};

export function loadScriptNames(root = ROOT) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return Object.keys(pkg.scripts || {});
}

/** Scripts present in package.json but not assigned to any category above. */
export function uncategorized(scriptNames) {
  const known = new Set(Object.values(CATEGORIES).flatMap((c) => c.scripts));
  return scriptNames.filter((s) => !known.has(s));
}

function main() {
  console.log("aios-workspace — npm scripts, by category (run: npm run <name>)\n");
  for (const [name, { description, scripts }] of Object.entries(CATEGORIES)) {
    console.log(`${name} — ${description}`);
    for (const s of scripts) console.log(`  npm run ${s}`);
    console.log("");
  }
  const missing = uncategorized(loadScriptNames());
  if (missing.length) {
    console.log(`(uncategorized — see scripts/npm-menu.mjs: ${missing.join(", ")})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
