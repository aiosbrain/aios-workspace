// Inbox CLI (I-09 / AIO-390, the G4 gate) — drives the real `aios inbox` read-only command as a
// child process, the same way asks-cli.test.mjs drives `aios asks`.
//
// The EXIT gate is DUAL-READ PARITY: every v1 ask field must be byte-identical between
// `aios asks --json` and the corresponding `aios inbox --json` item, over fixtures that ALSO carry
// legacy-only observations and multi-account collisions — proving the unified merge never corrupts
// or drops an ask field. The rest of the suite covers the protected partition, the `--raw`
// chronological escape hatch, `--json` round-trip, and the honest staleness header.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildObservation,
  appendObservations,
  PARTITION_SEPARATOR,
  RANKER_VERSION,
  RECENCY_WHY,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

function ws() {
  return mkdtempSync(path.join(tmpdir(), "inbox-cli-"));
}
function run(dir, cmd, args) {
  try {
    const stdout = execFileSync("node", [CLI, cmd, ...args, "--repo", dir], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const addAsk = (dir, kind, severity, title) =>
  JSON.parse(
    run(dir, "asks", ["add", "--kind", kind, "--severity", severity, "--title", title, "--json"])
      .stdout
  ).id;

// Seed enriched observations: a multi-account COLLISION (same native id through two accounts → two
// items) plus a single-account email. `tsFor` lets a caller control freshness for the staleness test.
function seedObservations(dir, tsFor = () => new Date().toISOString()) {
  const mk = (connection_id, account, native_id, extra = {}) =>
    buildObservation({
      connection_id,
      account,
      tenant: "acme.com",
      object_kind: "email",
      native_id,
      ts: tsFor(native_id, account),
      snippet: `${account}:${native_id}`,
      ...extra,
    });
  appendObservations(dir, [
    mk("gmail-a", "alice@acme.com", "shared-msg"), // collision A
    mk("gmail-b", "bob@acme.com", "shared-msg"), // collision B (same native id, different account)
    mk("gmail-a", "alice@acme.com", "solo-msg"),
  ]);
}

// Seed legacy activity.jsonl: one record with an enriched twin (absorbed → no dup) and one
// legacy-ONLY record (no twin → its own thread item).
function seedLegacyActivity(dir, occurredAt = new Date().toISOString()) {
  const commsDir = path.join(dir, "1-inbox", "comms");
  mkdirSync(commsDir, { recursive: true });
  const lines = [
    { source: "email", ref: "gmail:shared-msg", occurredAt, summary: "twin of an enriched obs" },
    {
      source: "email",
      ref: "gmail:legacy-only",
      occurredAt,
      summary: "legacy has no enriched twin",
    },
  ];
  writeFileSync(
    path.join(commsDir, "activity.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
}

test("EXIT — dual-read parity: every v1 ask field is byte-identical between `aios asks --json` and `aios inbox --json` (legacy + multi-account fixtures)", () => {
  const dir = ws();
  try {
    // Asks spanning open + resolved, covering severity/status/timestamps/dedupe passthrough.
    const blocker = addAsk(dir, "idle", "blocker", "Need input on deploy");
    addAsk(dir, "status", "fyi", "Nightly ran");
    const decision = addAsk(dir, "review", "decision", "Approve schema change?");
    run(dir, "asks", ["resolve", decision]); // one resolved ask must still round-trip

    // Populate the inbox with observations that must NOT disturb ask parity.
    seedObservations(dir);
    seedLegacyActivity(dir);

    const asks = JSON.parse(run(dir, "asks", ["list", "--status", "all", "--json"]).stdout).asks;
    const view = JSON.parse(run(dir, "inbox", ["--json"]).stdout);
    assert.ok(Array.isArray(asks) && asks.length === 3, "3 asks present (incl. resolved)");

    // Byte-identity: for every ask, the corresponding agent-event item carries it verbatim.
    for (const ask of asks) {
      const item = view.items.find((i) => i.origin === "agent-event" && i.id === ask.id);
      assert.ok(item, `inbox has an agent-event item for ask ${ask.id}`);
      assert.equal(
        JSON.stringify(item.ask),
        JSON.stringify(ask),
        `ask ${ask.id} is byte-identical between asks --json and inbox --json`
      );
      // Field-level belt-and-braces on the spec's named fields.
      for (const f of ["id", "tier", "status", "createdAt", "resolvedAt", "dedupeKey"]) {
        assert.equal(item.ask[f], ask[f], `field ${f} preserved for ${ask.id}`);
      }
    }
    // The blocker (open) is protected; the resolved decision is not.
    assert.equal(view.items.find((i) => i.id === blocker).protected, true);
    assert.equal(view.items.find((i) => i.id === decision).protected, false);

    // Multi-account collision → TWO distinct thread items; legacy-only → its own item; the legacy
    // twin of an enriched observation is absorbed (no duplicate).
    const threads = view.items.filter((i) => i.origin === "thread-state");
    const shared = threads.filter((i) => i.observation.native_id === "shared-msg");
    assert.equal(shared.length, 2, "same native id across two accounts stays TWO items");
    assert.deepEqual(
      [...new Set(shared.map((i) => i.account))].sort(),
      ["alice@acme.com", "bob@acme.com"],
      "the two collision items carry distinct accounts"
    );
    const legacyOnly = threads.filter((i) => i.observation.native_id === "legacy-only");
    assert.equal(legacyOnly.length, 1, "legacy-only record projects one item");
    assert.equal(legacyOnly[0].observation.origin, "legacy");
    // 3 enriched items (shared-msg×2 accounts + solo-msg) + 1 legacy-only; the gmail:shared-msg
    // legacy twin is absorbed by its enriched observation (not a 5th item).
    assert.equal(threads.length, 4, "3 enriched + 1 legacy-only (shared-msg twin absorbed)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protected partition renders above the separator; the rest below it", () => {
  const dir = ws();
  try {
    const blocker = addAsk(dir, "idle", "blocker", "protected one");
    const fyi = addAsk(dir, "status", "fyi", "unprotected one");
    const out = run(dir, "inbox", []).stdout;
    const sepAt = out.indexOf(PARTITION_SEPARATOR);
    assert.ok(sepAt > -1, "separator is rendered");
    assert.ok(
      out.indexOf(blocker) > -1 && out.indexOf(blocker) < sepAt,
      "protected id above separator"
    );
    assert.ok(out.indexOf(fyi) > sepAt, "non-protected id below separator");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry-configured protected sender is promoted into the partition (real ranker, end-to-end)", () => {
  const dir = ws();
  try {
    // Admin-local default registry: one protected counterparty (entity file + active engagement).
    const regDir = path.join(dir, ".aios", "loop", "inbox");
    mkdirSync(regDir, { recursive: true });
    writeFileSync(
      path.join(regDir, "ranking-registry.json"),
      JSON.stringify({
        people: [
          {
            ids: ["vip@client.com"],
            tier: 1,
            projectWeight: 0.9,
            entityFile: true,
            engagement: "active",
          },
        ],
      })
    );
    // A thread observation whose counterparty (role:"from") is the protected sender.
    appendObservations(dir, [
      buildObservation({
        connection_id: "gmail-a",
        account: "me@acme.com",
        tenant: "acme.com",
        object_kind: "email",
        native_id: "vip-msg",
        ts: new Date().toISOString(),
        snippet: "Can you review the contract today?",
        participants: [{ id: "vip@client.com", display: "VIP", role: "from" }],
      }),
    ]);
    // A plain unprotected fyi ask to sit below the fold.
    addAsk(dir, "status", "fyi", "nightly ran");

    const view = JSON.parse(run(dir, "inbox", ["--json"]).stdout);
    assert.equal(view.ranker_version, RANKER_VERSION, "real ranker version stamped");
    const vip = view.items.find(
      (i) => i.origin === "thread-state" && i.observation.native_id === "vip-msg"
    );
    assert.ok(vip, "vip observation present");
    assert.equal(vip.protected, true, "registry-protected sender is protected by the real ranker");
    assert.notEqual(vip.why, RECENCY_WHY, "carries a real ranker why");

    const out = run(dir, "inbox", []).stdout;
    const sepAt = out.indexOf(PARTITION_SEPARATOR);
    assert.ok(sepAt > -1, "separator rendered");
    assert.ok(
      out.indexOf(vip.id) > -1 && out.indexOf(vip.id) < sepAt,
      "registry-protected sender renders above the separator"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broken registry fails open — still the real ranker/version, no crash, nothing wrongly protected", () => {
  const dir = ws();
  try {
    const regDir = path.join(dir, ".aios", "loop", "inbox");
    mkdirSync(regDir, { recursive: true });
    writeFileSync(path.join(regDir, "ranking-registry.json"), "{ not valid json ][");
    addAsk(dir, "status", "fyi", "just an fyi");
    seedObservations(dir);

    const res = run(dir, "inbox", ["--json"]);
    assert.equal(res.code, 0, "broken registry never crashes the CLI");
    const view = JSON.parse(res.stdout);
    assert.equal(view.ranker_version, RANKER_VERSION, "still the real ranker/version on fail-open");
    // No registry entries resolve → no thread item is registry-protected.
    for (const it of view.items.filter((i) => i.origin === "thread-state")) {
      assert.equal(it.protected, false, "fail-open never claims protected for a thread");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json round-trips (parse → re-serialize → deep-equal) and carries the REAL ranker_version + staleness", () => {
  const dir = ws();
  try {
    addAsk(dir, "idle", "blocker", "one");
    seedObservations(dir);
    const raw = run(dir, "inbox", ["--json"]).stdout;
    const parsed = JSON.parse(raw);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed, "round-trips");
    assert.equal(typeof parsed.ranker_version, "string");
    // AIO-429: buildInbox now injects I-04's real deterministic ranker by default (no registry
    // configured in this fixture → fail-open, tier-only, but STILL the real ranker + version).
    assert.equal(parsed.ranker_version, RANKER_VERSION, "real I-04 ranker injected by default");
    assert.notEqual(parsed.ranker_version, "recency-fallback", "not the recency fallback");
    assert.ok(parsed.staleness && typeof parsed.staleness.stale === "boolean", "carries staleness");
    assert.ok("generated_at" in parsed, "carries generated_at");
    // Every row carries a real, non-empty ranker `why` (never the recency-fallback string).
    for (const it of parsed.items) {
      assert.ok(typeof it.why === "string" && it.why.trim().length > 0, "non-empty why on every row");
      assert.notEqual(it.why, RECENCY_WHY, "real ranker why, not the recency fallback");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--raw lists the identical item ids in pure timestamp order", () => {
  const dir = ws();
  try {
    addAsk(dir, "idle", "blocker", "b");
    addAsk(dir, "status", "fyi", "f");
    seedObservations(dir);
    seedLegacyActivity(dir);
    const ranked = JSON.parse(run(dir, "inbox", ["--json"]).stdout).items;
    const rawItems = JSON.parse(run(dir, "inbox", ["--raw", "--json"]).stdout).items;

    // Same item SET.
    assert.deepEqual(
      new Set(rawItems.map((i) => i.id)),
      new Set(ranked.map((i) => i.id)),
      "raw covers the identical item set"
    );
    // Pure chronological order (ts asc, id tiebreak) — no protected partition.
    const expected = [...ranked]
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((i) => i.id);
    assert.deepEqual(
      rawItems.map((i) => i.id),
      expected,
      "raw is pure timestamp order"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("staleness header appears only when the newest observation is older than the SLO window", () => {
  const fresh = ws();
  const stale = ws();
  try {
    // Fresh: observation stamped ~now → within the 5-min SLO → not stale.
    seedObservations(fresh, () => new Date().toISOString());
    const freshView = JSON.parse(run(fresh, "inbox", ["--json"]).stdout);
    assert.equal(freshView.staleness.stale, false, "fresh fixture is not stale");
    assert.ok(!/STALE/.test(run(fresh, "inbox", []).stdout), "no stale header when fresh");

    // Stale: observation stamped an hour ago → beyond the SLO → stale.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    seedObservations(stale, () => hourAgo);
    const staleView = JSON.parse(run(stale, "inbox", ["--json"]).stdout);
    assert.equal(staleView.staleness.stale, true, "hour-old fixture is stale");
    assert.ok(staleView.staleness.age_ms > staleView.staleness.slo_ms);
    assert.ok(/STALE/.test(run(stale, "inbox", []).stdout), "stale header shown when stale");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});

test("exits 0 on an empty fixture workspace (no asks, no observations)", () => {
  const dir = ws();
  try {
    const res = run(dir, "inbox", []);
    assert.equal(res.code, 0, "empty inbox still exits 0");
    assert.equal(JSON.parse(run(dir, "inbox", ["--json"]).stdout).items.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
