#!/usr/bin/env node
// Reuses gen-catalog.mjs's own pure builder functions (the same ones
// scripts/context-health.mjs's checkCatalogDrift() calls) instead of shelling
// out to the CLI against a scratch copy of the workspace. Prints "true" or
// "false" to stdout: whether .claude/skills/INDEX.md matches what
// renderSkillsIndexMd(readSkills(...)) would generate right now.
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readSkills, renderSkillsIndexMd } from "../../../scripts/gen-catalog.mjs";

const workspace = process.argv[2];
const indexPath = path.join(workspace, ".claude", "skills", "INDEX.md");
const actual = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
const expected = renderSkillsIndexMd(readSkills(workspace));

process.stdout.write(actual === expected ? "true" : "false");
