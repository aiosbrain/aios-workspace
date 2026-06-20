#!/usr/bin/env node
// test/suggest-connectors.test.mjs — assertions for the onboarding connector matcher
// (scaffold/.claude/skills/workspace-setup/suggest-connectors.mjs). It builds a catalog
// from the scaffold's real descriptors + integrations.json, then drives suggest() with
// crafted tools_mentioned lists.
//
// Zero-dep. Run: node test/suggest-connectors.test.mjs   (exit 0 = pass)

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalize,
  loadCatalog,
  toolsFromExtract,
  suggest,
} from "../scaffold/.claude/skills/workspace-setup/suggest-connectors.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
// The matcher reads <repo>/.claude/... — the scaffold dir IS such a repo root.
const SCAFFOLD = path.join(DIR, "..", "scaffold");

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}
const ids = (r) => r.connectable.map((c) => c.id);
const recNames = (r) => r.recognized_not_connectable.map((c) => c.name);
const extract = (tools) => ({ results: [{ extracted: { tools_mentioned: tools } }] });

const baseCatalog = loadCatalog(SCAFFOLD);
// clone helper so tests can mutate status without polluting other tests
function catalogWithStatus(id, status) {
  const descriptors = baseCatalog.descriptors.map((d) =>
    d.id === id ? { ...d, status } : { ...d }
  );
  // rebuild indexes referencing the cloned descriptor objects
  const connectableIndex = new Map();
  for (const d of descriptors) {
    connectableIndex.set(normalize(d.id), d);
    connectableIndex.set(normalize(d.name), d);
  }
  const jira = descriptors.find((d) => d.id === "jira");
  if (jira) connectableIndex.set(normalize("atlassian"), jira);
  return { descriptors, connectableIndex, recognizedIndex: baseCatalog.recognizedIndex };
}

console.log("suggest-connectors: catalog loads the 6 descriptors");
{
  check(
    "descriptors include slack/jira/notion/linear/granola/firecrawl",
    ["slack", "jira", "notion", "linear", "granola", "firecrawl"].every((id) =>
      baseCatalog.descriptors.some((d) => d.id === id)
    )
  );
}

console.log("suggest-connectors: raw strings match by name");
{
  const r = suggest(baseCatalog, ["Slack", "Notion"]);
  check("slack + notion connectable", ids(r).includes("slack") && ids(r).includes("notion"));
  check("nothing in recognized_not_connectable", r.recognized_not_connectable.length === 0);
}

console.log("suggest-connectors: alias atlassian -> jira");
{
  const r = suggest(baseCatalog, ["Atlassian"]);
  check("atlassian resolves to jira", ids(r).includes("jira"));
}

console.log("suggest-connectors: dedupe by id");
{
  // multiple distinct strings that all map to jira → one entry
  const r = suggest(baseCatalog, ["Jira", "jira", "Atlassian", "JIRA"]);
  check("jira appears exactly once", ids(r).filter((x) => x === "jira").length === 1);
}

console.log("suggest-connectors: case + punctuation normalization");
{
  check("normalize strips case/punct", normalize("  Sl@ack! ") === "slack");
  const r = suggest(baseCatalog, ["  sL A-C-K "]);
  check("'sL A-C-K' matches slack", ids(r).includes("slack"));
}

console.log("suggest-connectors: wired connectors are filtered out");
{
  const cat = catalogWithStatus("slack", "wired");
  const r = suggest(cat, ["Slack", "Jira"]);
  check("wired slack excluded", !ids(r).includes("slack"));
  check("available jira still included", ids(r).includes("jira"));
}

console.log("suggest-connectors: descriptor-less tools -> recognized_not_connectable only");
{
  const r = suggest(baseCatalog, ["GitHub", "Gmail / Google Workspace", "Slack"]);
  check("github NOT connectable", !ids(r).includes("github"));
  check("google NOT connectable", !ids(r).includes("google"));
  check("slack IS connectable", ids(r).includes("slack"));
  check("github in recognized_not_connectable", recNames(r).includes("GitHub"));
  check(
    "google in recognized_not_connectable",
    recNames(r).some((n) => /Google/.test(n))
  );
}

console.log("suggest-connectors: stable catalog order (not tools order)");
{
  // tools_mentioned in reverse-alpha; output must follow descriptor (catalog) order
  const r = suggest(baseCatalog, ["Slack", "Notion", "Linear", "Jira", "Granola", "Firecrawl"]);
  const sorted = [...ids(r)].sort();
  check(
    "connectable ids are in stable (sorted catalog) order",
    JSON.stringify(ids(r)) === JSON.stringify(sorted)
  );
}

console.log("suggest-connectors: toolsFromExtract parses results[].extracted.tools_mentioned");
{
  const tools = toolsFromExtract({
    results: [
      { extracted: { tools_mentioned: ["Slack"] } },
      { extracted: { tools_mentioned: ["Jira"] } },
      { error: "boom" },
    ],
  });
  check(
    "collects across results, skips errors",
    JSON.stringify(tools) === JSON.stringify(["Slack", "Jira"])
  );
  check(
    "malformed extract -> []",
    toolsFromExtract({}).length === 0 && toolsFromExtract(null).length === 0
  );
}

console.log("suggest-connectors: end-to-end via extract shape");
{
  const r = suggest(baseCatalog, toolsFromExtract(extract(["We use Slack, Jira and GitHub"])));
  // single comma string is one token → matches nothing; ensures we don't tokenize sentences
  check("a sentence is not split into matches", ids(r).length === 0 && recNames(r).length === 0);
  const r2 = suggest(baseCatalog, toolsFromExtract(extract(["Slack", "Jira", "GitHub"])));
  check(
    "discrete tokens match",
    ids(r2).includes("slack") && ids(r2).includes("jira") && recNames(r2).includes("GitHub")
  );
}

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}suggest-connectors tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}suggest-connectors tests FAILED — ${failed} assertion(s)${NC}`);
process.exit(1);
