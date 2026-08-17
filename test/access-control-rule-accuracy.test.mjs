// The access-control rule is a SAFETY doc: a workspace owner reads it to decide what is
// safe to leave on their machine. It said `1-inbox/` was "already outside" `sync_include`.
// It is not — `1-inbox/transcripts` is whitelisted in `scaffold/aios.yaml.tmpl`, so meeting
// transcripts filed there really do leave the machine once tagged. `3-log/` was implicitly
// treated the same way while only three named files inside it are whitelisted.
//
// A wrong safety doc is worse than no safety doc, and prose drifts silently against a
// template nobody re-reads. So this pins the two directions that matter:
//   1. every `sync_include` path under a folder the rule discusses must be NAMED in the rule
//      (add `1-inbox/notes` to the whitelist and this reddens until you document it);
//   2. the whole-root exclusions the rule promises must actually be absent from the whitelist.
//
// It deliberately checks the TEMPLATE, which is what every future workspace is stamped from.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "scaffold", "aios.yaml.tmpl");
const RULE = path.join(ROOT, "scaffold", ".claude", "rules", "access-control.md");

/** The `sync_include:` list from the scaffold template, in order. */
function syncInclude() {
  const lines = readFileSync(TEMPLATE, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === "sync_include:");
  assert.notEqual(start, -1, "sync_include: must exist in the template");
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!m) break; // the list ends at the first non-item line
    out.push(m[1]);
  }
  assert.ok(out.length > 0, "sync_include must not be empty");
  return out;
}

test("the access-control rule names every whitelisted path in the folders it discusses", () => {
  const rule = readFileSync(RULE, "utf8");
  // These are the spine roots the rule makes per-path claims about. A path whitelisted
  // under one of them and NOT named in the rule is exactly the drift that made the rule
  // wrong about `1-inbox/transcripts`.
  const discussed = ["1-inbox/", "3-log/"];
  for (const entry of syncInclude()) {
    if (!discussed.some((d) => entry.startsWith(d))) continue;
    assert.ok(
      rule.includes(entry),
      `sync_include whitelists '${entry}' but .claude/rules/access-control.md never mentions it — ` +
        `the rule would tell an owner that folder is safe when it is not`
    );
  }
});

test("the rule's whole-root exclusions really are outside sync_include", () => {
  const include = syncInclude();
  for (const root of ["5-personal", "6-business"]) {
    assert.ok(
      !include.some((entry) => entry === root || entry.startsWith(`${root}/`)),
      `the rule promises '${root}' is outside sync_include, but the template whitelists it`
    );
  }
});

test("the rule says out loud that transcripts leave the machine", () => {
  const rule = readFileSync(RULE, "utf8");
  // Test 1 only proves the path is MENTIONED. This proves the mention is the warning it
  // needs to be: an owner filing a client call recording has to read that it syncs.
  assert.match(rule, /`1-inbox\/transcripts` IS\s+whitelisted/);
  assert.doesNotMatch(
    rule,
    /`5-personal\/` are already outside it by default/,
    "the retired claim — it lumped 1-inbox in with 5-personal and was wrong about it"
  );
});
