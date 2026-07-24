import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDailyOrientation } from "../../dist/operator-loop/daily.js";
import { summarizeTranscriptReview } from "../../dist/operator-loop/meetings/index.js";
import { renderDaily } from "../../scripts/daily-render.mjs";

const GENERATED_AT = "2026-07-22T12:00:00.000Z";

function manifest() {
  return {
    member: "alex",
    project: "acme",
    generatedAt: GENERATED_AT,
    window: {
      cadence: "daily",
      from: "2026-07-21T12:00:00.000Z",
      to: GENERATED_AT,
    },
    windowed: false,
    signals: [],
    excluded: [],
  };
}

const REVIEW = {
  pendingStages: 2,
  decisions: 3,
  tasks: 4,
  failedRubric: 1,
  gradingErrors: 2,
  unreadableStages: 1,
};

test("owner orientation includes only the injected transcript-review aggregate", () => {
  // Given a precomputed local aggregate and an otherwise empty manifest.
  const baseline = buildDailyOrientation({ manifest: manifest(), prior: null });

  // When the pure daily builder receives that aggregate for its owner projection.
  const withReview = buildDailyOrientation({
    manifest: manifest(),
    prior: null,
    audience: "owner",
    transcriptReview: REVIEW,
  });

  // Then only the optional owner field changes; C1 state and the durable snapshot are untouched.
  assert.deepEqual(withReview.orientation.transcriptReview, REVIEW);
  assert.deepEqual(withReview.orientation.counts, baseline.orientation.counts);
  assert.deepEqual(withReview.orientation.changed, baseline.orientation.changed);
  assert.deepEqual(withReview.orientation.excluded, baseline.orientation.excluded);
  assert.deepEqual(withReview.nextSnapshot, baseline.nextSnapshot);
});

test("shareable and zero-work projections omit transcriptReview entirely", () => {
  // Given live review work plus an all-zero aggregate.
  const zero = {
    pendingStages: 0,
    decisions: 0,
    tasks: 0,
    failedRubric: 0,
    gradingErrors: 0,
    unreadableStages: 0,
  };

  // When the same aggregate is projected for owner, team, and external audiences.
  const ownerZero = buildDailyOrientation({
    manifest: manifest(),
    prior: null,
    audience: "owner",
    transcriptReview: zero,
  }).orientation;
  const team = buildDailyOrientation({
    manifest: manifest(),
    prior: null,
    audience: "team",
    transcriptReview: REVIEW,
  }).orientation;
  const external = buildDailyOrientation({
    manifest: manifest(),
    prior: null,
    audience: "external",
    transcriptReview: REVIEW,
  }).orientation;

  // Then the property is absent, not zeroed or redacted into the shareable shape.
  assert.equal(Object.hasOwn(ownerZero, "transcriptReview"), false);
  assert.equal(Object.hasOwn(team, "transcriptReview"), false);
  assert.equal(Object.hasOwn(external, "transcriptReview"), false);
  assert.equal(team.counts.withheld, 0);
  assert.equal(external.counts.withheld, 0);
});

test("diagnostic-only transcript review remains owner-visible", () => {
  // Given no pending candidates but local failures requiring owner action.
  const diagnostics = {
    pendingStages: 0,
    decisions: 0,
    tasks: 0,
    failedRubric: 2,
    gradingErrors: 1,
    unreadableStages: 3,
  };

  // When the owner orientation is built.
  const orientation = buildDailyOrientation({
    manifest: manifest(),
    prior: null,
    transcriptReview: diagnostics,
  }).orientation;

  // Then the actionable diagnostic counts survive without any stage detail.
  assert.deepEqual(orientation.transcriptReview, diagnostics);
  assert.deepEqual(Object.keys(orientation.transcriptReview).sort(), Object.keys(REVIEW).sort());
});

test("owner text renders review commands after asks and diagnostics prevent the clear state", () => {
  // Given an owner orientation with one ask and both pending and diagnostic review work.
  const ask = {
    id: "ask-1",
    dedupeKey: null,
    kind: "decision",
    severity: "decision",
    title: "Pick a database",
    body: "",
    ref: null,
    source: "cli",
    sessionId: null,
    tailHash: null,
    transcriptPath: null,
    tier: "admin",
    createdAt: GENERATED_AT,
    status: "open",
    resolvedAt: null,
  };
  const orientation = buildDailyOrientation({
    manifest: manifest(),
    prior: null,
    asks: [ask],
    transcriptReview: REVIEW,
  }).orientation;
  const output = [];
  const originalLog = console.log;
  console.log = (...values) => output.push(values.join(" "));

  // When the human daily renderer writes the owner view.
  try {
    renderDaily(orientation);
  } finally {
    console.log = originalLog;
  }
  const text = output.join("\n");

  // Then only aggregate counts and fixed commands appear immediately after the asks controls.
  assert.match(
    text,
    /3 decisions \+ 4 tasks pending review — aios transcripts list; approve with aios transcripts approve <file>/
  );
  assert.match(
    text,
    /1 rubric failure \+ 2 grading errors \+ 1 unreadable stage — inspect with aios transcripts list/
  );
  assert.ok(text.indexOf("Resolve: `aios asks") < text.indexOf("Transcript review"));
  assert.ok(text.indexOf("Transcript review") < text.indexOf("Blocked (0)"));
  assert.doesNotMatch(text, /You're clear|No classifiable daily items/);
});

test("diagnostic-only owner text is actionable rather than clear", () => {
  // Given an otherwise empty owner orientation with only unreadable review stages.
  const orientation = buildDailyOrientation({
    manifest: manifest(),
    prior: null,
    transcriptReview: {
      pendingStages: 0,
      decisions: 0,
      tasks: 0,
      failedRubric: 0,
      gradingErrors: 0,
      unreadableStages: 2,
    },
  }).orientation;
  const output = [];
  const originalLog = console.log;
  console.log = (...values) => output.push(values.join(" "));

  // When the owner view is rendered.
  try {
    renderDaily(orientation);
  } finally {
    console.log = originalLog;
  }
  const text = output.join("\n");

  // Then the diagnostic count and inspection command replace the misleading clear state.
  assert.match(text, /2 unreadable stages — inspect with aios transcripts list/);
  assert.doesNotMatch(text, /You're clear|No classifiable daily items/);
});

test("directory discovery failure remains an owner-only unreadable orientation", () => {
  // Given a real staging directory whose enumeration deterministically fails.
  const root = mkdtempSync(path.join(tmpdir(), "aio370-daily-directory-failure-"));
  mkdirSync(path.join(root, ".aios", "staging", "transcript-decisions"), {
    recursive: true,
  });
  try {
    const review = summarizeTranscriptReview(root, () => {
      const error = new Error("synthetic EACCES directory enumeration failure");
      error.code = "EACCES";
      throw error;
    });

    // When the aggregate is projected and rendered for each audience.
    const owner = buildDailyOrientation({
      manifest: manifest(),
      prior: null,
      audience: "owner",
      transcriptReview: review,
    }).orientation;
    const team = buildDailyOrientation({
      manifest: manifest(),
      prior: null,
      audience: "team",
      transcriptReview: review,
    }).orientation;
    const external = buildDailyOrientation({
      manifest: manifest(),
      prior: null,
      audience: "external",
      transcriptReview: review,
    }).orientation;
    const output = [];
    const originalLog = console.log;
    console.log = (...values) => output.push(values.join(" "));
    try {
      renderDaily(owner);
    } finally {
      console.log = originalLog;
    }

    // Then the owner keeps a usable diagnostic orientation while shareable views stay private.
    assert.deepEqual(review, {
      pendingStages: 0,
      decisions: 0,
      tasks: 0,
      failedRubric: 0,
      gradingErrors: 0,
      unreadableStages: 1,
    });
    assert.deepEqual(owner.transcriptReview, review);
    assert.match(output.join("\n"), /1 unreadable stage — inspect with aios transcripts list/);
    assert.equal(Object.hasOwn(team, "transcriptReview"), false);
    assert.equal(Object.hasOwn(external, "transcriptReview"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
