#!/usr/bin/env node
// test/ux/json-extract.test.mjs — ZERO-DEPENDENCY unit test for the judge adapter's JSON
// normalizer (test/ux/json-extract.mjs). Regression for the live finding where the judge model
// wrapped every verdict in a ```json fence → strict parse failed → all criteria review_needed.
//
// Run: node test/ux/json-extract.test.mjs

import { extractJsonObject } from "./json-extract.mjs";

let failed = 0;
const RED = "\x1b[0;31m", GREEN = "\x1b[0;32m", NC = "\x1b[0m";
const obj = '{"criterion":"x","verdict":"pass","reason":"ok","confidence":0.9}';
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else { console.log(`  ${RED}✗${NC} ${label}`); failed++; }
}
// A normalized result must (a) JSON.parse and (b) round-trip to the same object.
const parses = (s) => { try { return JSON.parse(s); } catch { return null; } };
const same = (s) => JSON.stringify(parses(s)) === JSON.stringify(JSON.parse(obj));

console.log("extractJsonObject: THE live failure — ```json fence");
{
  check("```json\\n{...}\\n``` → clean JSON", same(extractJsonObject("```json\n" + obj + "\n```")));
  check("bare ``` fence (no language) → clean JSON", same(extractJsonObject("```\n" + obj + "\n```")));
  check("fence with trailing newline/space tolerated", same(extractJsonObject("```json\n" + obj + "\n```   ")));
}

console.log("extractJsonObject: prose / whitespace around the object");
{
  check("leading prose then object", same(extractJsonObject("Here is my verdict:\n" + obj)));
  check("object then trailing prose", same(extractJsonObject(obj + "\n\nLet me know if you need more.")));
  check("surrounding whitespace only", same(extractJsonObject("   \n" + obj + "  \n")));
  check("already-bare object is unchanged", same(extractJsonObject(obj)));
}

console.log("extractJsonObject: fails closed on genuine garbage (keeps the gate strict)");
{
  check("no braces → returned as-is (judge parse will fail)", parses(extractJsonObject("totally not json")) === null);
  check("empty string → empty (parse fails)", extractJsonObject("") === "");
  check("non-string → empty", extractJsonObject(null) === "" && extractJsonObject(undefined) === "");
}

console.log("");
if (failed) { console.log(`${RED}json-extract.test: ${failed} check(s) failed${NC}`); process.exit(1); }
console.log(`${GREEN}json-extract.test: all checks passed${NC}`);
