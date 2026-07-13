import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  existingTranscriptsById,
  frontmatterValue,
  planTranscriptWrite,
  renderTranscript,
} from "../scaffold/.claude/descriptors/skills/granola-direct/granola-pull.mjs";

function note(body = "short") {
  return {
    id: "meeting-123",
    title: "Weekly Sync",
    created: "2026-07-13T09:00:00Z",
    participants: ["John"],
    transcriptText: body,
  };
}

test("re-pull matches by granola_id and preserves an equal existing transcript", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "granola-clobber-"));
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "locally-renamed.md");
    writeFileSync(file, renderTranscript(note(), "private"));
    const existing = existingTranscriptsById(dir).get("meeting-123");
    const plan = planTranscriptWrite({
      note: note(),
      destination: path.join(dir, "new-name.md"),
      existing,
      accessTier: "team",
    });
    assert.equal(plan.action, "skip");
    assert.equal(plan.file, file);
    assert.equal(frontmatterValue(plan.markdown, "access"), "private");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a grown transcript updates the body but preserves the local access tier", () => {
  const existing = { file: "/tmp/existing.md", markdown: renderTranscript(note(), "admin") };
  const plan = planTranscriptWrite({
    note: note("short, with a genuinely longer continuation"),
    destination: "/tmp/new.md",
    existing,
    accessTier: "team",
  });
  assert.equal(plan.action, "update");
  assert.equal(plan.file, existing.file);
  assert.equal(frontmatterValue(plan.markdown, "access"), "admin");
  assert.match(plan.markdown, /genuinely longer continuation/);
});

test("--force intentionally overwrites the tier and connector content", () => {
  const existing = {
    file: "/tmp/existing.md",
    markdown: renderTranscript(note("long"), "private"),
  };
  const plan = planTranscriptWrite({
    note: note("new"),
    destination: "/tmp/new.md",
    existing,
    accessTier: "team",
    force: true,
  });
  assert.equal(plan.action, "overwrite");
  assert.equal(frontmatterValue(plan.markdown, "access"), "team");
});
