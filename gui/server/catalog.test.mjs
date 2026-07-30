import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { firstSentence, listPersonalities, mapCatalog, blueprintResponse } from "./catalog.mjs";

test("firstSentence: cuts at the first sentence boundary, collapses whitespace", () => {
  assert.equal(firstSentence("One. Two."), "One.");
  assert.equal(firstSentence("  spread\n over lines  "), "spread over lines");
  assert.equal(firstSentence(), "");
});

test("listPersonalities: scans .claude/personalities with safe ids and flat frontmatter", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-pers-"));
  try {
    const dir = path.join(repo, ".claude", "personalities");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "coach.md"),
      "---\nname: Coach\ndescription: Warm and encouraging. Asks questions.\n---\n# Voice\n"
    );
    writeFileSync(path.join(dir, "no-frontmatter.md"), "# bare\n");
    writeFileSync(path.join(dir, "Bad Name.md"), "---\nname: nope\n---\n"); // unsafe id → skipped
    writeFileSync(path.join(dir, "notes.txt"), "not a personality");

    const out = listPersonalities(repo);
    assert.deepEqual(out, [
      { id: "coach", name: "Coach", description: "Warm and encouraging." },
      { id: "no-frontmatter", name: "no-frontmatter", description: "" },
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("listPersonalities: empty when the directory is absent", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-pers-"));
  try {
    assert.deepEqual(listPersonalities(repo), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("blueprintResponse: merges pull outcome with a 200 connector envelope", () => {
  const envelope = {
    status: 200,
    body: { blueprint: { connectors: {} }, connectors: [{ id: "x" }] },
  };
  assert.deepEqual(blueprintResponse(false, "", envelope), {
    status: 200,
    body: { ok: true, blueprint: { connectors: {} }, connectors: [{ id: "x" }], note: null },
  });
  // pull failure is a soft note; empty/absent fields default only on genuine success
  assert.deepEqual(blueprintResponse(true, "pull failed", { status: 200, body: {} }), {
    status: 200,
    body: { ok: false, blueprint: null, connectors: [], note: "pull failed" },
  });
});

test("blueprintResponse: a failed connector-seam spawn propagates its error status", () => {
  // The exact envelope aios-json.mjs produces for a failed spawn / non-JSON output —
  // it must surface as a 500, never flatten into a 200 with `connectors: []`.
  const failure = { status: 500, body: { ok: false, error: "aios CLI failed" } };
  assert.deepEqual(blueprintResponse(false, "", failure), failure);
  assert.equal("connectors" in blueprintResponse(true, "note", failure).body, false);
});

test("mapCatalog: reduces skills to card fields, tolerates malformed payloads", () => {
  const mapped = mapCatalog({
    skills: [{ id: "x", name: "X", kind: "skill", description: "Does X. In depth.", extra: 1 }],
    integrations: [{ name: "Tool" }],
  });
  assert.deepEqual(mapped, {
    skills: [{ name: "X", kind: "skill", description: "Does X." }],
    integrations: [{ name: "Tool" }],
  });
  assert.deepEqual(mapCatalog(null), { skills: [], integrations: [] });
  assert.deepEqual(mapCatalog({ skills: "nope" }), { skills: [], integrations: [] });
});
