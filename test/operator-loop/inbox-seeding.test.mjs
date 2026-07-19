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
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  readSeedJournal,
  foldSeedStatus,
  seedRegistryPath,
  seedEntitiesDir,
  listEntityFiles,
  tierForConfidence,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const DIST_INDEX = pathToFileURL(path.join(ROOT, "dist", "operator-loop", "index.js")).href;
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

    // Only after an explicit merge do the files appear — and the status transitions to `merged`. Use
    // a FRESH workspace: rejecting a suggestion is now durable (authoritative in the journal), so the
    // same id cannot later be merged without an unmerge — merging a rejected id is a conflict.
    const root2 = ws();
    const history2 = seedHistory(root2);
    const target = generateSuggestions(root2, history2).find((s) => s.kind === "person");
    const res = mergeSuggestion(root2, target);
    assert.equal(res.status, "merged");
    assert.equal(target.status, "merged", "merge performs the proposed→merged transition");
    assert.equal(existsSync(seedRegistryPath(root2)), true, "merge is the writer of the registry");
    assert.equal(listEntityFiles(root2).length, 1, "merge wrote exactly one entity file");

    // A rejected id cannot be merged (durable reject wins) — a distinct, deterministic conflict.
    const rejectedPerson = readSuggestions(root, history).find(
      (s) => s.kind === "person" && s.status === "rejected"
    );
    assert.throws(
      () => mergeSuggestion(root, { ...rejectedPerson, status: "proposed" }),
      (e) => e.name === "SeedConflictError" && e.currentStatus === "rejected",
      "merging a durably-rejected id conflicts"
    );

    // A second merge of an already-merged suggestion is refused (no silent double-write) — the gate
    // is authoritative from the journal, so even a fresh `proposed`-looking object cannot re-merge.
    assert.throws(
      () => mergeSuggestion(root2, target),
      (e) => e.name === "SeedConflictError" && /already merged/.test(e.message)
    );
    const stale = { ...target, status: "proposed" };
    assert.throws(
      () => mergeSuggestion(root2, stale),
      (e) => e.name === "SeedConflictError" && e.currentStatus === "merged",
      "a stale proposed snapshot cannot bypass the authoritative in-lock gate"
    );
    rmSync(root2, { recursive: true, force: true });
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

    // A merged person is still LISTED (so her sibling suggestions stay reviewable) but shows the
    // durable `merged` status from the seed journal — she is never re-PROPOSED.
    const after = JSON.parse(runCli(root, ["--json", "--owner", OWNER]).stdout);
    const afterPerson = after.suggestions.find((s) => s.kind === "person" && s.id === person.id);
    assert.ok(afterPerson, "a merged person still appears in the review list");
    assert.equal(afterPerson.status, "merged", "…with her durable merged status (not proposed)");
    // Her sibling relationship-tier suggestion is still generated and still proposed (mergeable).
    const siblingTier = after.suggestions.find(
      (s) =>
        s.kind === "relationship-tier" &&
        s.proposed_entry.ids.some((id) => person.proposed_entry.ids.includes(id))
    );
    assert.ok(siblingTier, "the merged person's tier suggestion is still generated");
    assert.equal(siblingTier.status, "proposed", "…and still proposed (not orphaned)");

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

// ── concurrency: merge vs reject race, in SEPARATE processes, on the SAME suggestion ────────────────
//
// The review flagged that the proposed-status gate used to sit OUTSIDE the lock, so two racing
// callers could both pass the check and leave the registry/filesystem contradicting the journal.
// The gate is now re-checked from the authoritative journal INSIDE `withInboxLock`. This test proves
// the invariant end-to-end by racing a `merge` child against a `reject` child on the same id.

// A child that loads the (deterministic) suggestion by id, then — CRUCIALLY — waits at a two-child
// readiness barrier until BOTH children have loaded the SAME suggestion from the still-pristine
// registry, and only THEN races the locked merge|reject op. Without the barrier the harness is
// flaky: a merge winner completes and the cold-start skip filters the now-known person out of
// generation, so a reject child that hadn't loaded yet would re-generate and find nothing
// (`no-suggestion`). The barrier makes "both poised, then race" deterministic — it does NOT touch
// product code or weaken semantics; the actual merge/reject contention still resolves under the
// real inbox lock. Prints one JSON line: {winner:true,status} on success, or
// {winner:false,conflict,currentStatus} on SeedConflictError. Any other failure exits non-zero.
function writeRaceChild(root) {
  const file = path.join(root, "seed-race-child.mjs");
  writeFileSync(
    file,
    `import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const dist = await import(${JSON.stringify(DIST_INDEX)});
const [root, action, id, owner, barrierDir] = process.argv.slice(2);

// 1. Load the suggestion while the registry is still pristine (both children reach this pre-race).
const { observations } = dist.readObservations(root);
const history = dist.observationsToHistory(observations, { ownerIds: [owner] });
const s = dist.generateSuggestions(root, history).find((x) => x.id === id);
if (!s) { console.log(JSON.stringify({ error: "no-suggestion" })); process.exit(2); }

// 2. Readiness barrier: announce this child is loaded + poised, then block until BOTH are.
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
mkdirSync(barrierDir, { recursive: true });
writeFileSync(join(barrierDir, "ready-" + action), String(process.pid));
const deadline = Date.now() + 15000;
while (!(existsSync(join(barrierDir, "ready-merge")) && existsSync(join(barrierDir, "ready-reject")))) {
  if (Date.now() > deadline) { console.log(JSON.stringify({ error: "barrier-timeout", action })); process.exit(3); }
  sleep(5);
}

// 3. Both poised — race the locked op on the ALREADY-LOADED suggestion (no re-generation).
try {
  const r = action === "merge" ? dist.mergeSuggestion(root, s) : dist.rejectSuggestion(root, s);
  console.log(JSON.stringify({ winner: true, action, status: r.status }));
} catch (e) {
  if (e && e.name === "SeedConflictError")
    console.log(JSON.stringify({ winner: false, action, conflict: true, currentStatus: e.currentStatus }));
  else { console.log(JSON.stringify({ error: String((e && e.message) || e) })); process.exit(1); }
}
`
  );
  return file;
}

function runRaceChild(childFile, root, action, id, owner, barrierDir) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [childFile, root, action, id, owner, barrierDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0 && code !== null)
        return reject(new Error(`child ${action} exited ${code}: ${err}${out}`));
      try {
        resolve(JSON.parse(out.trim().split("\n").pop()));
      } catch {
        reject(new Error(`child ${action} bad output: ${out} / ${err}`));
      }
    });
  });
}

test("concurrency: racing merge vs reject — exactly one wins; registry, journal, and replay agree", async () => {
  // Repeat the race many times so scheduling can land either order (merge-first or reject-first).
  for (let round = 0; round < 24; round++) {
    const root = ws();
    try {
      const history = seedHistory(root);
      const target = generateSuggestions(root, history).find((s) => s.kind === "person");
      const child = writeRaceChild(root);
      const barrierDir = path.join(root, `race-barrier-${round}`);

      // Fire both children concurrently on the SAME suggestion id; they rendezvous at the barrier
      // (both loaded + poised) before contending for the inbox lock.
      const [a, b] = await Promise.all([
        runRaceChild(child, root, "merge", target.id, OWNER, barrierDir),
        runRaceChild(child, root, "reject", target.id, OWNER, barrierDir),
      ]);
      const results = [a, b];
      assert.ok(
        !results.some((r) => r.error),
        `no unexpected child error (round ${round}): ${JSON.stringify(results)}`
      );

      // EXACTLY ONE transition won; the other observed a deterministic conflict.
      const winners = results.filter((r) => r.winner === true);
      const losers = results.filter((r) => r.winner === false && r.conflict === true);
      assert.equal(
        winners.length,
        1,
        `exactly one winner (round ${round}): ${JSON.stringify(results)}`
      );
      assert.equal(losers.length, 1, `exactly one conflicted loser (round ${round})`);
      const winner = winners[0];

      // The seed journal holds EXACTLY ONE terminal event for the id (the loser appended nothing).
      const events = readSeedJournal(root);
      const terminal = events.filter(
        (e) => e.suggestion_id === target.id && (e.op === "merge" || e.op === "reject")
      );
      assert.equal(terminal.length, 1, `one terminal journal event (round ${round})`);
      assert.equal(terminal[0].op, winner.action, "the journal event is the winner's op");

      // The loser correctly saw the winner's status as the current authoritative status.
      assert.equal(losers[0].currentStatus, winner.status, "loser saw the winner's status");

      // Registry ⇄ journal agreement: merge-win ⇒ registry present + folds `merged`; reject-win ⇒
      // registry ABSENT + folds `rejected`. The two never contradict.
      const folded = foldSeedStatus(events).get(target.id);
      if (winner.action === "merge") {
        assert.equal(folded, "merged");
        assert.equal(existsSync(seedRegistryPath(root)), true, "merge winner wrote the registry");
        const reg = JSON.parse(readFileSync(seedRegistryPath(root), "utf8"));
        assert.ok(
          reg.people.some((p) => p.ids.some((idv) => target.proposed_entry.ids.includes(idv))),
          "the registry contains the merged person"
        );
      } else {
        assert.equal(folded, "rejected");
        assert.equal(existsSync(seedRegistryPath(root)), false, "reject winner wrote no registry");
      }

      // Replay is deterministic + idempotent: re-folding is stable, and re-running the LOSER's op
      // again still conflicts and appends nothing (no second terminal event). Run this in-process
      // against the RETAINED `target` — after a merge win the person is filtered from generation
      // (cold-start skip), so re-deriving her by id is intentionally impossible.
      assert.equal(
        foldSeedStatus(readSeedJournal(root)).get(target.id),
        folded,
        "fold is stable on replay"
      );
      assert.throws(
        () =>
          winner.action === "merge"
            ? rejectSuggestion(root, { ...target, status: "proposed" })
            : mergeSuggestion(root, { ...target, status: "proposed" }),
        (e) => e.name === "SeedConflictError" && e.currentStatus === winner.status,
        "re-running the loser still conflicts (idempotent)"
      );
      const eventsAfter = readSeedJournal(root).filter(
        (e) => e.suggestion_id === target.id && (e.op === "merge" || e.op === "reject")
      );
      assert.equal(eventsAfter.length, 1, "no new terminal event on idempotent replay");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ── LIFO unmerge: the whole-registry inverse snapshot must never roll back later merges ────────────

test("unmerge is LIFO-only: merge A, merge B, unmerge A → error; unmerge B then A → works", () => {
  const root = ws();
  try {
    const history = seedHistory(root);
    const people = generateSuggestions(root, history).filter((s) => s.kind === "person");
    const a = people.find((s) => s.proposed_entry.ids.includes("anna@client.com"));
    const b = people.find((s) => s.proposed_entry.ids.includes("ben@client.com"));
    assert.ok(a && b, "two distinct person suggestions");

    mergeSuggestion(root, a);
    mergeSuggestion(root, b);
    const withBoth = readFileSync(seedRegistryPath(root), "utf8");
    assert.match(withBoth, /ben@client\.com/, "B is in the registry after both merges");

    // Out-of-order unmerge would restore A's snapshot (which predates B) and silently revert B.
    assert.throws(
      () => unmergeSuggestion(root, a.id),
      (e) => e.name === "SeedValidationError" && /LIFO/.test(e.message) && e.message.includes(b.id),
      "unmerging A while B is un-reversed must refuse with a clear LIFO error"
    );
    assert.equal(
      readFileSync(seedRegistryPath(root), "utf8"),
      withBoth,
      "a refused unmerge changes nothing"
    );

    // Stack order works: unmerge B, then A — back to no registry (neither existed before).
    unmergeSuggestion(root, b.id);
    assert.doesNotMatch(
      readFileSync(seedRegistryPath(root), "utf8"),
      /ben@client\.com/,
      "B reversed"
    );
    unmergeSuggestion(root, a.id);
    assert.equal(existsSync(seedRegistryPath(root)), false, "A reversed — registry back to absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── merged person's sibling suggestions stay mergeable (no orphaning) ──────────────────────────────

test("merge person, then merge their relationship-tier suggestion → works; counts stay correct", () => {
  const root = ws();
  try {
    const history = seedHistory(root);
    const person = generateSuggestions(root, history).find(
      (s) => s.kind === "person" && s.proposed_entry.ids.includes("anna@client.com")
    );
    mergeSuggestion(root, person);

    // The tier suggestion must still be generated for the now-known person, still `proposed`.
    const tier = readSuggestions(root, history).find(
      (s) => s.kind === "relationship-tier" && s.proposed_entry.ids.includes("anna@client.com")
    );
    assert.ok(tier, "the merged person's tier suggestion is still generated");
    assert.equal(tier.status, "proposed");

    // …and it merges: the registry person now carries the banded tier.
    const r = mergeSuggestion(root, tier);
    assert.equal(r.status, "merged");
    const registry = JSON.parse(readFileSync(seedRegistryPath(root), "utf8"));
    const entry = registry.people.find((p) => p.ids.includes("anna@client.com"));
    assert.equal(entry.tier, tier.proposed_entry.tier, "the tier landed on the registry person");

    // Review counts fold from the journal overlay: person + tier merged, nothing double-counted.
    const statuses = foldSeedStatus(readSeedJournal(root));
    assert.equal(statuses.get(person.id), "merged");
    assert.equal(statuses.get(tier.id), "merged");
    const listed = readSuggestions(root, history);
    assert.equal(listed.filter((s) => s.status === "merged").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
