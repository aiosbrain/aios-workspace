// Backfill CLI (AIO-192) — drives `aios decisions backfill` against a synthetic ~/.claude tree.
// Proves: recovery count, idempotence, non-existent-cwd skip, foreign-origin redaction, and — the
// Blocker-#1 gate — that an NDA-like client repo is skipped by default and NEVER leaks a name/path
// into the store (nor into the report that gets pasted into a public PR body).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const STORE_REL = ".aios/loop/decisions/decisions.ndjson";
const CAP = 20_000; // DECISIONS_HARD_LINE_CAP (mirrored; the CLI reads it from the compiled loop)

function askUse(id, questions) {
  return { type: "tool_use", id, name: "AskUserQuestion", input: { questions } };
}
function planUse(id, plan) {
  return { type: "tool_use", id, name: "ExitPlanMode", input: { plan } };
}
function ask(sessionId, ts, cwd, id, question, answer) {
  return [
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      cwd,
      message: {
        role: "assistant",
        content: [askUse(id, [{ question, header: "H", options: [{ label: answer }] }])],
      },
    },
    {
      type: "user",
      sessionId,
      timestamp: ts,
      cwd,
      toolUseResult: { answers: [{ question, answer }] },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    },
  ];
}
function plan(sessionId, ts, cwd, id, title) {
  return [
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      cwd,
      message: { role: "assistant", content: [planUse(id, `# ${title}\n\nstep 1`)] },
    },
    {
      type: "user",
      sessionId,
      timestamp: ts,
      cwd,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: id, content: "User has approved your plan." },
        ],
      },
    },
  ];
}

function build() {
  const HOME = mkdtempSync(path.join(tmpdir(), "bf-home-"));
  const P = (...seg) => path.join(HOME, "Projects", ...seg);
  // The work repo lives under an allowlisted root: the current-repo protected-root check (review
  // r1 fix-round) refuses backfill from a repo whose contextTag is forbidden/unrecognized.
  const WORK = P("aios", "workbench");
  mkdirSync(WORK, { recursive: true });
  const labs = P("labs", "widget");
  const prod = P("products", "vibrana");
  const client = P("clients", "acme-secret-engagement");
  for (const d of [labs, prod, client]) mkdirSync(d, { recursive: true });
  const gone = P("labs", "deleted-42"); // deliberately NOT created

  const projDir = path.join(HOME, ".claude", "projects");
  const session = (slug, name, records) => {
    const dir = path.join(projDir, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };

  // 4 AskUserQuestion + 2 ExitPlanMode across two safe repos = 6 recoverable.
  session("labs", "s1.jsonl", [
    ...ask("s1", "2026-06-01T10:00:00Z", labs, "a1", "Which database?", "Postgres"),
    ...ask("s1", "2026-06-01T10:01:00Z", labs, "a2", "Which cache?", "Redis"),
    ...plan("s1", "2026-06-01T10:02:00Z", labs, "p1", "Ship the widget"),
  ]);
  session("prod", "s2.jsonl", [
    ...ask("s2", "2026-06-02T10:00:00Z", prod, "a3", "Deploy region?", "us-east"),
    ...ask("s2", "2026-06-02T10:01:00Z", prod, "a4", "Enable billing?", "Yes"),
    ...plan("s2", "2026-06-02T10:02:00Z", prod, "p2", "Wire up checkout"),
  ]);
  // non-existent cwd → skipped + counted
  session("gone", "s3.jsonl", ask("s3", "2026-06-03T10:00:00Z", gone, "a5", "Ghost?", "A"));
  // NDA-like client repo, client-flavoured content → skipped by default + counted, never named
  session(
    "client",
    "s4.jsonl",
    ask("s4", "2026-06-04T10:00:00Z", client, "a6", "Use the acme-secret billing core?", "Yes")
  );

  return { HOME, WORK, clientName: "acme-secret-engagement", clientPath: client };
}

function run(WORK, args) {
  try {
    const out = execFileSync("node", [CLI, "decisions", ...args, "--repo", WORK], {
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

test("backfill --all: dry-run reports 6 recoverable + the skip counts, writes nothing", () => {
  const { HOME, WORK, clientName } = build();
  try {
    const res = run(WORK, ["backfill", "--all", "--home", HOME, "--dry-run", "--json"]);
    assert.equal(res.code, 0);
    const r = JSON.parse(res.out);
    assert.equal(r.recoverable, 6, "4 AskUserQuestion + 2 ExitPlanMode");
    assert.equal(r.appended, 6, "all 6 would be new");
    assert.equal(r.skippedNonexistentCwd, 1);
    assert.equal(r.skippedSensitive, 1, "the NDA client session");
    assert.deepEqual(r.byContext, { labs: 3, products: 3 });
    assert.equal(existsSync(path.join(WORK, STORE_REL)), false, "dry-run writes nothing");
    // The report is PR-body evidence — it must never name the sensitive root.
    assert.ok(!res.out.includes(clientName), "dry-run report never names the NDA repo");
    assert.ok(!res.out.includes("clients"), "no sensitive contextTag in the report");
  } finally {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
  }
});

test("backfill --all: real run appends 6 with correct tags; re-run is idempotent (0 appended)", () => {
  const { HOME, WORK } = build();
  try {
    const first = JSON.parse(run(WORK, ["backfill", "--all", "--home", HOME, "--json"]).out);
    assert.equal(first.appended, 6);
    assert.equal(first.skippedDuplicate, 0);

    const store = readFileSync(path.join(WORK, STORE_REL), "utf8");
    const recs = store
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).decision);
    assert.equal(recs.length, 6);
    assert.equal(recs.filter((r) => r.contextTag === "labs").length, 3);
    assert.equal(recs.filter((r) => r.contextTag === "products").length, 3);
    assert.ok(recs.every((r) => r.source === "backfill"));

    const second = JSON.parse(run(WORK, ["backfill", "--all", "--home", HOME, "--json"]).out);
    assert.equal(second.appended, 0, "idempotent");
    assert.equal(second.skippedDuplicate, 6);
  } finally {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
  }
});

test("backfill --all: NDA repo is skipped and leaves NO name / absolute path / transcriptPath in the store", () => {
  const { HOME, WORK, clientName, clientPath } = build();
  try {
    run(WORK, ["backfill", "--all", "--home", HOME, "--json"]);
    const store = readFileSync(path.join(WORK, STORE_REL), "utf8");
    assert.ok(!/acme/i.test(store), "no client codename anywhere in the store");
    assert.ok(!store.includes(clientName), "no client repo name");
    assert.ok(!store.includes(clientPath), "no client absolute path");
    assert.ok(
      !store.includes(path.join(HOME, "Projects")),
      "no absolute Projects path (foreign origin redacted)"
    );
    assert.ok(!store.includes(".claude/projects"), "no raw transcriptPath from a foreign repo");
  } finally {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
  }
});

test("backfill --all --include clients: forbidden root is REFUSED loudly and ingests nothing from it", () => {
  const { HOME, WORK, clientName } = build();
  try {
    const res = run(WORK, ["backfill", "--all", "--home", HOME, "--include", "clients", "--json"]);
    assert.notEqual(
      res.code,
      0,
      "--include of a protected root fails loud, never silently honored"
    );
    assert.match(res.err ?? "", /cannot re-enable protected root/);
    // Nothing was written — a rejected invocation must not partially ingest.
    if (existsSync(path.join(WORK, STORE_REL))) {
      const store = readFileSync(path.join(WORK, STORE_REL), "utf8");
      assert.ok(!store.includes(clientName), "no client content leaked despite --include");
    }
  } finally {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
  }
});

test("backfill --all --include unknown/personal: protected roots are refused", () => {
  const { HOME, WORK } = build();
  try {
    for (const bad of ["unknown", "personal", "client"]) {
      const res = run(WORK, ["backfill", "--all", "--home", HOME, "--include", bad, "--json"]);
      assert.notEqual(res.code, 0, `--include ${bad} must be refused`);
      assert.match(res.err ?? "", /cannot re-enable protected root/);
    }
    // A genuinely-safe extra root is still honored (no false positive).
    const ok = run(WORK, [
      "backfill",
      "--all",
      "--home",
      HOME,
      "--include",
      "games",
      "--dry-run",
      "--json",
    ]);
    assert.equal(ok.code, 0, "a safe --include tag still works");
  } finally {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
  }
});

test("backfill --all: a foreign safe-repo record redacts cwd/transcriptPath/project but keeps contextTag + sessionId", () => {
  const { HOME, WORK } = build();
  try {
    run(WORK, ["backfill", "--all", "--home", HOME, "--json"]);
    const store = readFileSync(path.join(WORK, STORE_REL), "utf8");
    const recs = store
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).decision);
    const foreign = recs.find((r) => r.contextTag === "products");
    assert.ok(foreign);
    assert.equal(foreign.context.cwd, null);
    assert.equal(foreign.context.transcriptPath, null);
    assert.equal(foreign.context.project, null);
    assert.equal(foreign.context.sessionId, "s2");
    assert.equal(foreign.contextTag, "products");
  } finally {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
  }
});

test("backfill default (no --all): foreign repos are NOT ingested", () => {
  const { HOME, WORK } = build();
  try {
    // WORK is not under HOME/Projects, so no session's cwd is 'current' → nothing recovered.
    const r = JSON.parse(run(WORK, ["backfill", "--home", HOME, "--json"]).out);
    assert.equal(r.recoverable, 0, "default mode ignores other repos");
    assert.equal(r.appended, 0);
  } finally {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
  }
});

// A single transcript can span more than one cwd (resumed session / `cd` mid-session). Each
// decision MUST be classified by its own record's cwd — a safe leading record must not launder a
// later client-cwd decision into the store (the Round-3 High finding).
function mixed(order) {
  const HOME = mkdtempSync(path.join(tmpdir(), "bf-mix-home-"));
  const P = (...seg) => path.join(HOME, "Projects", ...seg);
  const WORK = P("aios", "workbench");
  mkdirSync(WORK, { recursive: true });
  const labs = P("labs", "widget");
  const client = P("clients", "acme-secret-engagement");
  for (const d of [labs, client]) mkdirSync(d, { recursive: true });
  const first = order === "safe-first" ? labs : client;
  const second = order === "safe-first" ? client : labs;
  const projDir = path.join(HOME, ".claude", "projects", "mixed");
  mkdirSync(projDir, { recursive: true });
  // Neutral question text on BOTH — the sensitivity under test is the record CWD (the client PATH),
  // not the prompt. The client decision must be excluded by its cwd whichever slot it sits in.
  const records = [
    ...ask("m1", "2026-06-05T10:00:00Z", first, "mx1", "First question?", "One"),
    ...ask("m1", "2026-06-05T10:01:00Z", second, "mx2", "Second question?", "Two"),
  ];
  writeFileSync(
    path.join(projDir, "m.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
  return { HOME, WORK, clientName: "acme-secret-engagement", clientPath: client };
}

for (const order of ["safe-first", "client-first"]) {
  test(`backfill --all: mixed-cwd transcript (${order}) classifies each decision by its OWN record cwd`, () => {
    const { HOME, WORK, clientName, clientPath } = mixed(order);
    try {
      const r = JSON.parse(run(WORK, ["backfill", "--all", "--home", HOME, "--json"]).out);
      // Exactly the labs decision is ingested; the client decision is skipped regardless of order.
      assert.equal(r.appended, 1, "only the allowlisted labs decision lands");
      assert.equal(r.skippedSensitive, 1, "the client-cwd decision in the same file is skipped");
      assert.deepEqual(r.byContext, { labs: 1 });

      const store = readFileSync(path.join(WORK, STORE_REL), "utf8");
      const recs = store
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).decision);
      assert.equal(recs.length, 1);
      assert.equal(recs[0].contextTag, "labs");
      // The redacted labs record keeps its question; the client one never reaches the store.
      assert.ok(!/acme/i.test(store), "no client codename leaks from the mixed file");
      assert.ok(!store.includes(clientName));
      assert.ok(!store.includes(clientPath));
    } finally {
      rmSync(HOME, { recursive: true, force: true });
      rmSync(WORK, { recursive: true, force: true });
    }
  });
}

test("backfill --since filters by the transcript timestamp", () => {
  const { HOME, WORK } = build();
  try {
    const r = JSON.parse(
      run(WORK, [
        "backfill",
        "--all",
        "--home",
        HOME,
        "--since",
        "2026-06-02T00:00:00Z",
        "--dry-run",
        "--json",
      ]).out
    );
    // Only the products session (2026-06-02) survives; labs (06-01) is filtered out.
    assert.equal(r.recoverable, 3);
    assert.deepEqual(r.byContext, { products: 3 });
    assert.notEqual(
      run(WORK, ["backfill", "--all", "--home", HOME, "--since", "nonsense"]).code,
      0
    );
  } finally {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
  }
});

// Review r1 (GPT, High): the protected-root rule must bind the CURRENT repo too — running
// backfill FROM a client/NDA repo must refuse, not ingest raw client context into its store.
test("backfill refuses to run when the current repo is under a protected root (clients/…)", () => {
  const { HOME, clientPath, clientName } = build();
  try {
    const res = run(clientPath, ["backfill", "--home", HOME, "--dry-run"]);
    assert.notEqual(res.code, 0, "protected current repo → non-zero exit");
    assert.match(res.err ?? "", /protected or unrecognized root/);
    assert.ok(!(res.err ?? "").includes(clientName), "refusal message never names the root");
    assert.ok(!existsSync(path.join(clientPath, STORE_REL)), "nothing written to the client repo");
  } finally {
    rmSync(HOME, { recursive: true, force: true });
  }
});

// Bugbot r1 (Medium): a record with no transcript timestamp must be skipped + counted, never
// stored with a fabricated "now" createdAt (which would also bypass --since).
test("backfill skips + counts decision moments whose record has no timestamp", () => {
  const { HOME, WORK } = build();
  try {
    const projDir = path.join(HOME, ".claude", "projects", "nots");
    mkdirSync(projDir, { recursive: true });
    const records = ask("nt1", "2026-06-06T10:00:00Z", WORK, "nt-a", "Keep me?", "Yes").map(
      (r, i) => (i === 0 ? { ...r, timestamp: undefined } : r)
    );
    writeFileSync(
      path.join(projDir, "n.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n"
    );
    const r = JSON.parse(run(WORK, ["backfill", "--home", HOME, "--dry-run", "--json"]).out);
    assert.equal(r.skippedMissingTimestamp, 1, "the timestampless moment is counted");
    assert.equal(r.recoverable, 0, "…and not recoverable");
  } finally {
    rmSync(HOME, { recursive: true, force: true });
  }
});

// Bugbot r2 (Medium): dry-run must simulate DECISIONS_HARD_LINE_CAP — its "would append" has to
// match what the live batch writer will actually write, never overstate it.
test("backfill --dry-run simulates the store line cap (would-append matches a live run)", () => {
  const { HOME, WORK } = build();
  try {
    // Fill the work repo's store to one line under the cap.
    const storeAbs = path.join(WORK, STORE_REL);
    mkdirSync(path.dirname(storeAbs), { recursive: true });
    writeFileSync(
      storeAbs,
      Array.from({ length: CAP - 1 }, (_, i) => `{"pad":${i}}`).join("\n") + "\n"
    );
    const dry = JSON.parse(
      run(WORK, ["backfill", "--all", "--home", HOME, "--dry-run", "--json"]).out
    );
    assert.equal(dry.recoverable, 6);
    assert.equal(dry.appended, 1, "one slot under the cap → dry-run predicts exactly 1");
    assert.equal(dry.cappedStore, 5, "the other 5 are reported as capped");
    const live = JSON.parse(run(WORK, ["backfill", "--all", "--home", HOME, "--json"]).out);
    assert.equal(live.appended, dry.appended, "live run matches the dry-run prediction");
    assert.equal(live.cappedStore, dry.cappedStore);
  } finally {
    rmSync(HOME, { recursive: true, force: true });
  }
});
