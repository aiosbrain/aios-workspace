import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  existingTranscriptsById,
  frontmatterValue,
  isRedacted,
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

// AIO-503: a hand-redacted transcript (shorter by construction) carries
// `redacted: true` and must survive a re-pull that would otherwise "grow" it back
// to the full, unredacted content — byte-identical, tier untouched.
function redact(markdown, marker = "redacted: true") {
  return markdown.replace(/^access: (.*)$/m, `access: $1\n${marker}`);
}

test("a redacted transcript is never clobbered even when the incoming body is longer", () => {
  const existing = {
    file: "/tmp/existing.md",
    markdown: redact(
      renderTranscript(note("redacted"), "team"),
      "redacted: true      # ← connector will never overwrite this file (skip-redacted)"
    ),
  };
  const plan = planTranscriptWrite({
    note: note("full unredacted transcript with the sensitive detail restored"),
    destination: "/tmp/new.md",
    existing,
    accessTier: "team",
  });
  assert.equal(plan.action, "skip-redacted");
  assert.equal(plan.file, existing.file);
  assert.equal(plan.markdown, existing.markdown); // byte-identical — untouched
  assert.doesNotMatch(plan.markdown, /sensitive detail restored/);
});

test("redaction marker parsing accepts comments and quotes but denies unknown values", () => {
  const marked = (value) =>
    redact(renderTranscript(note("redacted"), "team"), `redacted: ${value}`);
  for (const value of ["true # protected", "YES", '"true"', "'yes' # protected"]) {
    assert.equal(isRedacted(marked(value)), true, value);
  }
  for (const value of ["false", "enabled", "true#not-a-comment", '"true # protected"']) {
    assert.equal(isRedacted(marked(value)), false, value);
  }
  assert.equal(isRedacted(renderTranscript(note("redacted"), "team")), false, "missing marker");
});

test("--force still overrides the redaction marker (explicit escape hatch)", () => {
  const existing = {
    file: "/tmp/existing.md",
    markdown: redact(renderTranscript(note("redacted"), "private")),
  };
  const plan = planTranscriptWrite({
    note: note("full unredacted"),
    destination: "/tmp/new.md",
    existing,
    accessTier: "team",
    force: true,
  });
  assert.equal(plan.action, "overwrite");
  assert.equal(frontmatterValue(plan.markdown, "access"), "private");
  assert.match(plan.markdown, /full unredacted/);
});

test("--force overwrites connector content but preserves the local access tier", () => {
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
  assert.equal(frontmatterValue(plan.markdown, "access"), "private");
});
