import test from "node:test";
import assert from "node:assert/strict";
import {
  extractionPrompt,
  parseModelJson,
  prepareExtractionStage,
  stableCandidateKey,
} from "../scripts/transcript-extraction.mjs";

const transcriptTexts = {
  "1-inbox/transcripts/meeting.md":
    "Alex: We approved launch on August 4. Sam Rivera owns the rollout.",
};

test("model parsing requires an object and normalizes all four arrays", () => {
  assert.deepEqual(parseModelJson('{"decisions":[],"tasks":[]}'), {
    decisions: [],
    tasks: [],
    facts: [],
    stakeholders: [],
  });
  assert.throws(() => parseModelJson("[]"), /JSON object/);
  assert.throws(() => parseModelJson('{"decisions":"not-an-array"}'), /decisions must be an array/);
});

test("prompt demands grounded, storage-neutral output for every candidate kind", () => {
  const prompt = extractionPrompt(["1-inbox/transcripts/meeting.md"]);
  assert.match(prompt, /decisions, tasks, facts, stakeholders/);
  assert.match(prompt, /verbatim sourceQuote/);
  assert.match(prompt, /Classify each supported assertion once/);
  assert.match(prompt, /speaker name alone is insufficient/);
  assert.doesNotMatch(prompt, /3-log\/|4-shared\//);
});

test("stage excludes ungrounded candidates and reports why", () => {
  const stage = prepareExtractionStage({
    extraction: {
      decisions: [],
      tasks: [],
      facts: [
        {
          title: "Launch is August 4",
          factType: "event",
          transcript: "1-inbox/transcripts/meeting.md",
          sourceQuote: "We approved launch on August 4.",
        },
        {
          title: "Invented",
          factType: "fact",
          transcript: "1-inbox/transcripts/meeting.md",
          sourceQuote: "This quote is absent.",
        },
      ],
      stakeholders: [
        {
          name: "Missing Person",
          transcript: "1-inbox/transcripts/missing.md",
          sourceQuote: "Missing Person owns it.",
        },
      ],
    },
    transcriptTexts,
    now: "2026-07-24T00:00:00.000Z",
  });

  assert.equal(stage.version, 2);
  assert.equal(stage.access, "admin");
  assert.equal(stage.facts.length, 1);
  assert.equal(stage.stakeholders.length, 0);
  assert.equal(stage.rejected.length, 2);
  assert.deepEqual(stage.rejected.map((item) => item.reason).sort(), [
    "source_quote_not_found",
    "transcript_not_loaded",
  ]);
});

test("prototype-key transcript names reject as not loaded instead of crashing", () => {
  const stage = prepareExtractionStage({
    extraction: {
      decisions: [],
      tasks: [],
      facts: [
        {
          content: "Injected fact",
          transcript: "constructor",
          sourceQuote: "anything",
        },
      ],
      stakeholders: [],
    },
    transcriptTexts: {},
    now: "2026-07-24T00:00:00.000Z",
  });

  assert.equal(stage.facts.length, 0);
  assert.deepEqual(
    stage.rejected.map((item) => item.reason),
    ["transcript_not_loaded"]
  );
});

test("new evidence defaults admin, uses stable keys, and deduplicates", () => {
  const candidate = {
    name: "Sam Rivera",
    role: "Owner",
    transcript: "1-inbox/transcripts/meeting.md",
    sourceQuote: "Sam Rivera owns the rollout.",
  };
  const stage = prepareExtractionStage({
    extraction: {
      decisions: [],
      tasks: [],
      facts: [],
      stakeholders: [candidate, { ...candidate, name: "  sam   rivera " }],
    },
    transcriptTexts,
    now: "2026-07-24T00:00:00.000Z",
  });

  assert.equal(stage.stakeholders.length, 1);
  assert.equal(stage.stakeholders[0].access, "admin");
  assert.match(stage.stakeholders[0].rowKey, /^stakeholder-[a-f0-9]{16}$/);
  assert.equal(
    stableCandidateKey("stakeholder", candidate),
    stableCandidateKey("stakeholder", { ...candidate, name: "  sam   rivera " })
  );
});

test("existing deterministic row keys are excluded before review", () => {
  const fact = {
    title: "Launch is August 4",
    factType: "event",
    transcript: "1-inbox/transcripts/meeting.md",
    sourceQuote: "We approved launch on August 4.",
  };
  const rowKey = stableCandidateKey("fact", fact);
  const stage = prepareExtractionStage({
    extraction: { decisions: [], tasks: [], facts: [fact], stakeholders: [] },
    transcriptTexts,
    existingRowKeys: new Set([rowKey]),
    now: "2026-07-24T00:00:00.000Z",
  });
  assert.equal(stage.facts.length, 0);
  assert.equal(stage.rejected[0].reason, "already_approved");
});

test("decision and task dedupe ignores punctuation like the filesystem logs", () => {
  const stage = prepareExtractionStage({
    extraction: {
      decisions: [
        {
          decision: "Ship—the launch!",
          transcript: "1-inbox/transcripts/meeting.md",
          sourceQuote: "We approved launch on August 4.",
        },
        {
          decision: "Ship the launch",
          transcript: "1-inbox/transcripts/meeting.md",
          sourceQuote: "We approved launch on August 4.",
        },
      ],
      tasks: [
        {
          task: "Sam: own the rollout.",
          transcript: "1-inbox/transcripts/meeting.md",
          sourceQuote: "Sam Rivera owns the rollout.",
        },
      ],
      facts: [],
      stakeholders: [],
    },
    transcriptTexts,
    existingTaskTexts: new Set(["sam own the rollout"]),
    now: "2026-07-24T00:00:00.000Z",
  });

  assert.equal(stage.decisions.length, 1);
  assert.equal(stage.tasks.length, 0);
  assert.deepEqual(stage.rejected.map((item) => item.reason).sort(), [
    "already_approved",
    "duplicate_in_stage",
  ]);
});

test("decision and task normalization preserves an explicit admin audience", () => {
  const extraction = {
    decisions: [
      {
        decision: "Keep launch notes private",
        audience: "admin",
        transcript: "1-inbox/transcripts/meeting.md",
        sourceQuote: "We approved launch on August 4.",
      },
    ],
    tasks: [
      {
        task: "Privately prepare the rollout",
        audience: "admin",
        transcript: "1-inbox/transcripts/meeting.md",
        sourceQuote: "Sam Rivera owns the rollout.",
      },
    ],
    facts: [],
    stakeholders: [],
  };
  const stage = prepareExtractionStage({
    extraction,
    transcriptTexts,
    now: "2026-07-24T00:00:00.000Z",
  });
  assert.equal(stage.decisions[0].audience, "admin");
  assert.equal(stage.tasks[0].audience, "admin");
});
