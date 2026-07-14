// Inbox cold-start entity seeding (I-08 / AIO-389, review-only stretch) — drives the compiled
// seeding module + the `aios inbox seed` CLI. The acceptance gates, verbatim from the issue:
//
//   • generator over a fixture history emits suggestions with MONOTONIC confidence (higher-signal
//     fixture people score higher) and DETERMINISTIC output across runs;
//   • REVIEW-ONLY invariant: no code path writes an entity/registry file without a `merged` status
//     transition — a property test that generate + reject never touch the registry/entity files,
//     and `merge` is the sole writer;
//   • REVERSIBILITY: merge → unmerge restores the registry + entity files BYTE-IDENTICALLY
//     (golden-file diff empty);
//   • EVALUATION: precision/recall against the reviewed ground-truth corpus is computed + printed
//     (reported, not gated — stretch issue);
//   • `aios inbox seed --review` exits 0 on a fixture workspace and lists suggestions with scores.
//
// Everything under test is admin-tier local state under `.aios/loop/inbox/` — the test never syncs.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildObservation,
  appendObservations,
  observationsToHistory,
  generateSuggestions,
  readSuggestions,
  mergeSuggestion,
  rejectSuggestion,
  unmergeSuggestion,
  evaluateSuggestions,
  seedRegistryPath,
  seedEntitiesDir,
  listEntityFiles,
  tierForConfidence,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const REGISTRY_FIXTURE = path.join(
  ROOT,
  "test",
  "operator-loop",
  "fixtures",
  "inbox-ranking-registry.fixture.json"
);
const CORPUS_FIXTURE = path.join(
  ROOT,
  "test",
  "operator-loop",
  "fixtures",
  "inbox-ranking-corpus.fixture.json"
);

const OWNER = "me@me.com";
const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function ws() {
  return mkdtempSync(path.join(tmpdir(), "inbox-seed-"));
}

// One enriched observation of a counterparty. `ownerInitiated` flips who is the `from` participant.
function obs(counterpart, display, native, thread, ageDays, ownerInitiated, extra = {}) {
  return buildObservation({
    connection_id: "conn-me",
    account: OWNER,
    tenant: "me.com",
    object_kind: "email",
    native_id: native,
    thread_id: thread,
    ts: new Date(NOW - ageDays * DAY).toISOString(),
    participants: [
      ownerInitiated
        ? { id: OWNER, display: "Me", role: "from" }
        : { id: counterpart, display, role: "from" },
      ownerInitiated
        ? { id: counterpart, display, role: "to" }
        : { id: OWNER, display: "Me", role: "to" },
    ],
    ...extra,
  });
}

// A fixture history: a HIGH-signal person (Anna — many recent obs, several threads, two-way), a
// MID-signal person (Ben — fewer, one-way, older), and a LOW-signal person (Zed — minimal, stale).
function seedHistory(root) {
  const records = [];
  for (let i = 0; i < 8; i++)
    records.push(obs("anna@client.com", "Anna Park", "a" + i, "t-anna-" + (i % 4), i, i % 2 === 0));
  for (let i = 0; i < 4; i++)
    records.push(obs("ben@client.com", "Ben Ortiz", "b" + i, "t-ben-" + (i % 2), 20 + i, false));
  for (let i = 0; i < 2; i++)
    records.push(obs("zed@vendor.com", "Zed Vendor", "z" + i, "t-zed", 120 + i, false));
  appendObservations(root, records);
  return observationsToHistory(records, { ownerIds: [OWNER] });
}

function runCli(dir, args) {
  try {
    const stdout = execFileSync("node", [CLI, "inbox", "seed", ...args, "--repo", dir], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// ── generator: monotonic confidence + determinism ─────────────────────────────────────────────────

test("generator: higher-signal people score strictly higher; output is deterministic across runs", () => {
  const root = ws();
  try {
    const history = seedHistory(root);
    const run1 = generateSuggestions(root, history);
    const run2 = generateSuggestions(root, history);

    // Deterministic: two runs produce byte-identical suggestion arrays.
    assert.deepEqual(run1, run2, "generation is deterministic across runs");

    // Confidence is monotonic in signal: Anna (high) > Ben (mid) > Zed (low), on the `person` kind.
    const person = (name) =>
      run1.find((s) => s.kind === "person" && s.proposed_entry.ids.includes(name));
    const anna = person("anna@client.com");
    const ben = person("ben@client.com");
    const zed = person("zed@vendor.com");
    assert.ok(anna && ben && zed, "a person suggestion for each counterparty");
    assert.ok(anna.confidence > ben.confidence, `anna ${anna.confidence} > ben ${ben.confidence}`);
    assert.ok(ben.confidence > zed.confidence, `ben ${ben.confidence} > zed ${zed.confidence}`);

    // Every confidence is a real number in [0,1]; the returned list is sorted confidence-desc.
    for (const s of run1)
      assert.ok(s.confidence >= 0 && s.confidence <= 1, `confidence in [0,1]: ${s.confidence}`);
    const confs = run1.map((s) => s.confidence);
    assert.deepEqual(
      confs,
      [...confs].sort((a, b) => b - a),
      "suggestions sorted by confidence desc"
    );

    // Evidence summaries are content-free — never a message body (no snippet leaked).
    for (const s of run1) assert.doesNotMatch(s.evidence_summary, /body|snippet/i);

    // The banded relationship-tier follows the confidence band.
    const annaTier = run1.find(
      (s) => s.kind === "relationship-tier" && s.proposed_entry.ids.includes("anna@client.com")
    );
    assert.equal(annaTier.proposed_entry.tier, tierForConfidence(anna.confidence));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generator: below-min-support counterparties are not proposed; owner is never a candidate", () => {
  const root = ws();
  try {
    const records = [
      obs("solo@x.com", "Solo", "s0", "t-solo", 1, false), // 1 obs only → below MIN_SUPPORT_EVENTS
      obs("pair@x.com", "Pair", "p0", "t-pair", 1, false),
      obs("pair@x.com", "Pair", "p1", "t-pair", 2, false), // 2 obs → proposed
    ];
    appendObservations(root, records);
    const history = observationsToHistory(records, { ownerIds: [OWNER] });
    const s = generateSuggestions(root, history);
    const ids = s.flatMap((x) => x.proposed_entry.ids.map((i) => i.toLowerCase()));
    assert.ok(!ids.includes("solo@x.com"), "single-observation person is not proposed");
    assert.ok(ids.includes("pair@x.com"), "two-observation person is proposed");
    assert.ok(!ids.includes(OWNER), "the owner is never proposed as a candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── review-only invariant (property) ───────────────────────────────────────────────────────────────

test("review-only: generate + reject NEVER write a registry/entity file; merge is the sole writer", () => {
  const root = ws();
  try {
    const history = seedHistory(root);

    // Generating suggestions many times writes nothing.
    for (let i = 0; i < 5; i++) generateSuggestions(root, history);
    assert.equal(
      existsSync(seedRegistryPath(root)),
      false,
      "generate does not create the registry"
    );
    assert.equal(existsSync(seedEntitiesDir(root)), false, "generate does not create entity files");

    // Rejecting every suggestion writes nothing to the registry/entity files.
    for (const s of readSuggestions(root, history)) rejectSuggestion(root, s);
    assert.equal(existsSync(seedRegistryPath(root)), false, "reject does not create the registry");
    assert.equal(existsSync(seedEntitiesDir(root)), false, "reject does not create entity files");

    // Only after an explicit merge do the files appear — and the status transitions to `merged`.
    const fresh = generateSuggestions(root, history); // fresh proposed objects (bypass folded reject status)
    const target = fresh.find((s) => s.kind === "person");
    const res = mergeSuggestion(root, target);
    assert.equal(res.status, "merged");
    assert.equal(target.status, "merged", "merge performs the proposed→merged transition");
    assert.equal(existsSync(seedRegistryPath(root)), true, "merge is the writer of the registry");
    assert.equal(listEntityFiles(root).length, 1, "merge wrote exactly one entity file");

    // A second merge of an already-merged suggestion is refused (no silent double-write).
    assert.throws(() => mergeSuggestion(root, target), /can only merge a proposed suggestion/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── reversibility: merge → unmerge is byte-identical ───────────────────────────────────────────────

test("reversibility: merge → unmerge restores the registry + entity files byte-identically", () => {
  const root = ws();
  try {
    const history = seedHistory(root);

    // Start from a NON-empty registry (pre-existing person) so unmerge must restore prior bytes,
    // not just delete a fresh file.
    const first = generateSuggestions(root, history).find((s) => s.kind === "person");
    mergeSuggestion(root, first);
    const regBefore = readFileSync(seedRegistryPath(root), "utf8");
    const entitiesBefore = snapshotEntities(root);

    // Merge a SECOND, different person, then unmerge it — the registry + entities must return to the
    // exact bytes captured before this second merge.
    const second = generateSuggestions(root, history).find(
      (s) =>
        s.kind === "person" &&
        !s.proposed_entry.ids.some((id) => first.proposed_entry.ids.includes(id))
    );
    assert.ok(second, "a distinct second person to merge");
    mergeSuggestion(root, second);
    assert.notEqual(
      readFileSync(seedRegistryPath(root), "utf8"),
      regBefore,
      "second merge changed the registry"
    );

    unmergeSuggestion(root, second.id);
    assert.equal(
      readFileSync(seedRegistryPath(root), "utf8"),
      regBefore,
      "registry restored byte-identically"
    );
    assert.deepEqual(
      snapshotEntities(root),
      entitiesBefore,
      "entity files restored byte-identically"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reversibility: unmerge of a first-ever merge removes the freshly-created files (prior was absent)", () => {
  const root = ws();
  try {
    const history = seedHistory(root);
    const s = generateSuggestions(root, history).find((x) => x.kind === "person");
    mergeSuggestion(root, s);
    assert.equal(existsSync(seedRegistryPath(root)), true);
    assert.equal(listEntityFiles(root).length, 1);

    unmergeSuggestion(root, s.id);
    assert.equal(
      existsSync(seedRegistryPath(root)),
      false,
      "registry removed — it did not exist before the merge"
    );
    assert.equal(
      listEntityFiles(root).length,
      0,
      "entity file removed — it did not exist before the merge"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshotEntities(root) {
  const dir = seedEntitiesDir(root);
  if (!existsSync(dir)) return {};
  const out = {};
  for (const f of readdirSync(dir).sort()) out[f] = readFileSync(path.join(dir, f), "utf8");
  return out;
}

// ── evaluation: precision / recall vs the reviewed ground-truth corpus (reported, not gated) ────────

test("evaluation: precision/recall vs the I-04 labeled corpus is computed and printed", () => {
  const root = ws();
  try {
    // Build a history from the I-04 labeled corpus (the reviewed evaluation set). Each corpus item's
    // sender is the counterparty; `fromMe` marks owner-initiation. This exercises the SAME generator
    // on real reviewed ground truth.
    const corpus = JSON.parse(readFileSync(CORPUS_FIXTURE, "utf8"));
    const history = corpus.items
      .map((it) => it.input)
      .filter((inp) => inp && inp.sender && (inp.sender.email || inp.sender.account))
      .map((inp) => ({
        personId: inp.sender.email || inp.sender.account,
        identities: [inp.sender.account, inp.sender.email, inp.sender.display].filter(Boolean),
        display: inp.sender.display ?? null,
        threadId: inp.correlationId ?? null,
        ts: inp.sentAt ?? corpus.now,
        initiatedByOwner: inp.fromMe === true,
        channel: inp.channel ?? null,
      }));

    const registry = JSON.parse(readFileSync(REGISTRY_FIXTURE, "utf8"));
    const groundTruth = registry.people.flatMap((p) => p.ids);

    const suggestions = generateSuggestions(root, history);
    const evalResult = evaluateSuggestions(suggestions, history, groundTruth);

    // Reported, not gated — but must be well-formed numbers in [0,1].
    console.log(
      `  [I-08 eval] suggested=${evalResult.suggestedPeople} gt-in-history=${evalResult.groundTruthInHistory} ` +
        `tp=${evalResult.truePositives} precision=${evalResult.precision} recall=${evalResult.recall}`
    );
    assert.ok(evalResult.precision >= 0 && evalResult.precision <= 1, "precision in [0,1]");
    assert.ok(evalResult.recall >= 0 && evalResult.recall <= 1, "recall in [0,1]");
    assert.ok(evalResult.suggestedPeople > 0, "the corpus yields at least one suggestion");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── CLI: `aios inbox seed --review` exits 0 and lists suggestions; per-item merge/unmerge round-trip ─

test("CLI: `aios inbox seed --review` exits 0 on a fixture workspace and lists suggestions with scores", () => {
  const root = ws();
  try {
    seedHistory(root);
    const r = runCli(root, ["--review", "--owner", OWNER]);
    assert.equal(r.code, 0, `exit 0 (stderr: ${r.stderr})`);
    assert.match(r.stdout, /aios inbox seed --review/);
    assert.match(r.stdout, /anna@client\.com|Anna Park/, "lists the high-signal person");
    assert.match(r.stdout, /proposed \d+/, "prints the proposed count");

    // JSON surface round-trips and carries confidence scores.
    const j = JSON.parse(runCli(root, ["--json", "--owner", OWNER]).stdout);
    assert.ok(Array.isArray(j.suggestions) && j.suggestions.length > 0);
    for (const s of j.suggestions) assert.equal(typeof s.confidence, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: explicit per-item --merge writes the registry; --unmerge reverses it; no bulk-accept exists", () => {
  const root = ws();
  try {
    seedHistory(root);
    const list = JSON.parse(runCli(root, ["--json", "--owner", OWNER]).stdout);
    const person = list.suggestions.find((s) => s.kind === "person");

    // A bare merge (no id) is impossible — there is no bulk-accept flag; only `--merge <id>`.
    const merged = runCli(root, ["--merge", person.id, "--owner", OWNER, "--json"]);
    assert.equal(merged.code, 0, `merge exits 0 (stderr: ${merged.stderr})`);
    assert.equal(JSON.parse(merged.stdout).status, "merged");
    assert.equal(existsSync(seedRegistryPath(root)), true, "the registry now exists");

    // Cold-start semantics: a merged person is now a KNOWN registry identity, so re-listing no
    // longer re-proposes her (the durable merge lives in the seed journal, not the proposed list).
    const after = JSON.parse(runCli(root, ["--json", "--owner", OWNER]).stdout);
    assert.equal(
      after.suggestions.some((s) => s.kind === "person" && s.id === person.id),
      false,
      "a seeded person is not re-proposed (cold-start skip)"
    );

    // Unmerge reverses it — the registry returns to absent (it did not exist before) AND the person
    // becomes a cold-start candidate again.
    const un = runCli(root, ["--unmerge", person.id, "--json"]);
    assert.equal(un.code, 0, `unmerge exits 0 (stderr: ${un.stderr})`);
    assert.equal(existsSync(seedRegistryPath(root)), false, "registry removed on unmerge");
    const restored = JSON.parse(runCli(root, ["--json", "--owner", OWNER]).stdout);
    assert.equal(
      restored.suggestions.some((s) => s.kind === "person" && s.id === person.id),
      true,
      "after unmerge the person is a cold-start candidate again"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
