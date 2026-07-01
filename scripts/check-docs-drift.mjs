#!/usr/bin/env node
/**
 * Workspace docs drift guard.
 *
 * Derives V1 Operator Loop structural inventories from code/spec files and checks they
 * match the marker blocks in docs/v1-operator-loop/README.md. Like the Team Brain guard,
 * this validates enumerable structure only; prose, diagrams, and release judgment stay
 * reviewer-owned.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOC = path.join(ROOT, "docs", "v1-operator-loop", "README.md");

const COMPONENT_ISSUES = {
  C1: "AIO-123",
  C2: "AIO-124",
  C3: "AIO-125",
  C4: "AIO-127",
  C5: "AIO-128",
  C6: "AIO-129",
  C7: "AIO-126",
  C8: "AIO-130",
};
const VALID_COMPONENT_STATUS = new Set(["done", "in_review", "todo", "planned", "partial"]);

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function inlineCodeBlock(content, name, accept = /.+/) {
  const re = new RegExp(`<!--\\s*drift:${name}\\s*-->([\\s\\S]*?)<!--\\s*/drift:${name}\\s*-->`);
  const match = content.match(re);
  if (!match) return null;
  const items = [];
  for (const token of match[1].matchAll(/`([^`]+)`/g)) {
    if (accept.test(token[1])) items.push(token[1]);
  }
  return new Set(items);
}

function deriveComponents() {
  const dir = path.join(ROOT, "docs", "v1-operator-loop");
  const items = new Set();
  for (const file of readdirSync(dir)) {
    const match = file.match(/^(c[1-8])-.*\.md$/);
    if (!match) continue;
    const id = match[1].toUpperCase();
    items.add(`${id}|${COMPONENT_ISSUES[id]}|${file}`);
  }
  return items;
}

function normalizeDocumentedComponents(tokens) {
  if (tokens === null) return null;
  const out = new Set();
  const errors = [];
  for (const token of tokens) {
    const [id, issue, status, spec, ...rest] = token.split("|");
    if (rest.length || !id || !issue || !status || !spec) {
      errors.push(`malformed component token: ${token}`);
      continue;
    }
    if (!VALID_COMPONENT_STATUS.has(status)) {
      errors.push(
        `invalid status '${status}' for ${id}; expected one of ${[...VALID_COMPONENT_STATUS].join(", ")}`
      );
    }
    out.add(`${id}|${issue}|${spec}`);
  }
  return { items: out, errors };
}

function deriveLoopCommands() {
  const src = read("scripts/aios.mjs");
  // Bound cmdLoop to its OWN body: stop at the first section comment after its closing brace,
  // so an unrelated function inserted between cmdLoop and `// ── main` (e.g. cmdTime) is not
  // swallowed into the match and mis-attributed as an `aios loop` subcommand.
  const cmdLoop = src.match(/async function cmdLoop[\s\S]*?\n}\n\n\/\/ ──/);
  const items = new Set();
  if (!cmdLoop) return items;
  for (const match of cmdLoop[0].matchAll(/if\s*\(\s*sub\s*===\s*"([a-z]+)"\s*\)/g)) {
    const sub = match[1];
    items.add(sub === "manifest" ? "aios loop manifest --explain" : `aios loop ${sub}`);
  }
  return items;
}

function deriveMcpTools() {
  const src = read("scripts/brain-mcp.mjs");
  const tools = src.match(/export const TOOLS = \[[\s\S]*?\n\];/);
  const items = new Set();
  if (!tools) return items;
  for (const match of tools[0].matchAll(/name:\s*"([^"]+)"/g)) items.add(match[1]);
  return items;
}

function deriveLoopSources() {
  const src = read("src/operator-loop/collector.ts");
  const block = src.match(/const SOURCES:[\s\S]*?=\s*\{([\s\S]*?)\};/);
  const items = new Set();
  if (!block) return items;
  for (const match of block[1].matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gm)) items.add(match[1]);
  return items;
}

function deriveOperatorRubrics() {
  const dir = path.join(ROOT, ".claude", "rubrics");
  const items = new Set();
  if (!existsSync(dir)) return items;
  for (const file of readdirSync(dir).filter((f) => /^operator-loop-.*\.md$/.test(f))) {
    const src = readFileSync(path.join(dir, file), "utf8");
    const appliesTo = src.match(/^applies_to:\s*([a-z0-9-]+)/m)?.[1];
    items.add(appliesTo ?? file.replace(/\.md$/, ""));
  }
  return items;
}

function diff(label, actual, documented) {
  if (documented === null) {
    console.error(
      `x ${label}: missing <!-- drift:${label} --> block in docs/v1-operator-loop/README.md`
    );
    return false;
  }
  const missing = [...actual].filter((x) => !documented.has(x)).sort();
  const extra = [...documented].filter((x) => !actual.has(x)).sort();
  if (!missing.length && !extra.length) {
    console.log(`ok ${label}: ${actual.size} item(s) in sync`);
    return true;
  }
  if (missing.length)
    console.error(`x ${label}: in code/spec but NOT documented -> ${missing.join(", ")}`);
  if (extra.length)
    console.error(`x ${label}: documented but NOT in code/spec -> ${extra.join(", ")}`);
  return false;
}

const doc = readFileSync(DOC, "utf8");
const componentTokens = inlineCodeBlock(
  doc,
  "operator-components",
  /^C[1-8]\|AIO-\d+\|[a-z_]+\|c[1-8]-.*\.md$/
);
const documentedComponents = normalizeDocumentedComponents(componentTokens);

const checks = [
  documentedComponents === null
    ? diff("operator-components", deriveComponents(), null)
    : diff("operator-components", deriveComponents(), documentedComponents.items),
  diff("loop-commands", deriveLoopCommands(), inlineCodeBlock(doc, "loop-commands")),
  diff("mcp-tools", deriveMcpTools(), inlineCodeBlock(doc, "mcp-tools")),
  diff("loop-sources", deriveLoopSources(), inlineCodeBlock(doc, "loop-sources")),
  diff("operator-rubrics", deriveOperatorRubrics(), inlineCodeBlock(doc, "operator-rubrics")),
];

if (documentedComponents?.errors.length) {
  for (const error of documentedComponents.errors) console.error(`x operator-components: ${error}`);
  checks.push(false);
}

if (checks.every(Boolean)) {
  console.log("\nDocs are congruent with the V1 operator-loop surfaces.");
  process.exit(0);
}

console.error(
  "\nDocs drift detected. Update docs/v1-operator-loop/README.md drift blocks to match code/specs."
);
process.exit(1);
