// Unified inbox — ranking shadow-mode acceptance (I-04 / AIO-385).
//
// EXIT / HARD GATE (spec, verbatim): 100% protected recall on the fixture; any miss = defect
// (this file exits non-zero). Plus: shadow-mode zero-byte-change to the I-02 read-model digest,
// non-empty why + ranker_version on every row, determinism, and Appendix-A bucket parity.
//
// CORPUS PROVENANCE: the corpus + registry beside this test are **SYNTHETIC** (deterministically
// generated, ≥200 items / ≥3 channels / ≥30 protected-sender items). They meet the size/shape gate
// so `node --test` needs no live registry. >>> SWAP IN JOHN'S REAL LABELED HISTORY AT G3 <<< — the
// `protected` labels are ground truth from the registry design (entityFile && active engagement);
// re-freeze the golden `expected_bucket` lock against RANKER_VERSION when the real corpus lands.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RANKER_VERSION,
  SHADOW_LOG_BASENAME,
  INBOX_DIR_REL,
  buildRegistry,
  loadRegistry,
  rankItem,
  rankCorpus,
  recordShadowRanking,
  shadowLogPath,
  appendInboxEvent,
  rebuildReadModel,
} from "../../dist/operator-loop/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const REGISTRY_FIXTURE = path.join(FIXTURES, "inbox-ranking-registry.fixture.json");
const CORPUS_FIXTURE = path.join(FIXTURES, "inbox-ranking-corpus.fixture.json");

const registry = loadRegistry(REGISTRY_FIXTURE);
const corpus = JSON.parse(readFileSync(CORPUS_FIXTURE, "utf8"));
const ITEMS = corpus.items;

function ws(tag = "inbox-rank-") {
  return mkdtempSync(path.join(tmpdir(), tag));
}

// ── the corpus is real enough to gate on ──────────────────────────────────────────────────────────

test("corpus meets the pre-registered size/shape gate (≥200 items, ≥3 channels, ≥30 protected)", () => {
  assert.ok(ITEMS.length >= 200, `≥200 items (got ${ITEMS.length})`);
  const channels = new Set(ITEMS.map((it) => it.input.channel));
  assert.ok(channels.size >= 3, `≥3 channels (got ${channels.size}: ${[...channels]})`);
  const protectedCount = ITEMS.filter((it) => it.label.protected).length;
  assert.ok(protectedCount >= 30, `≥30 protected-sender items (got ${protectedCount})`);
  assert.ok(registry.present, "registry fixture loaded");
});

// ── EXIT GATE: 100% protected recall ──────────────────────────────────────────────────────────────

test("EXIT GATE — 100% protected recall: every protected-labeled item ranks in the protected partition", () => {
  const misses = [];
  for (const it of ITEMS) {
    if (!it.label.protected) continue;
    const r = rankItem(it.input, registry);
    if (r.protected !== true) {
      misses.push({ correlationId: it.input.correlationId, sender: it.input.sender, why: r.why });
    }
  }
  // Any miss is a defect — never averaged away.
  assert.equal(
    misses.length,
    0,
    `protected recall must be 100%; ${misses.length} miss(es): ${JSON.stringify(misses.slice(0, 5))}`
  );
  const protectedCount = ITEMS.filter((it) => it.label.protected).length;
  console.log(`protected recall: ${protectedCount}/${protectedCount} = 100%`);
});

test("protected partition precedes unprotected in the ranked order (regardless of signal)", () => {
  const ranked = rankCorpus(
    ITEMS.map((it) => it.input),
    registry
  );
  let seenUnprotected = false;
  for (const row of ranked) {
    if (!row.result.protected) seenUnprotected = true;
    else
      assert.ok(
        !seenUnprotected,
        `a protected item (${row.input.correlationId}) ranked BELOW an unprotected one — partition violated`
      );
  }
  // And the ranker's protected verdict matches the ground-truth label for protected items.
  const byId = new Map(ranked.map((r) => [r.input.correlationId, r.result.protected]));
  for (const it of ITEMS) {
    if (it.label.protected) assert.equal(byId.get(it.input.correlationId), true);
  }
});

// ── every row carries a why + ranker_version ──────────────────────────────────────────────────────

test("every ranked row carries a non-empty why and the current ranker_version", () => {
  for (const it of ITEMS) {
    const r = rankItem(it.input, registry);
    assert.ok(
      typeof r.why === "string" && r.why.trim().length > 0,
      `empty why for ${it.input.correlationId}`
    );
    assert.equal(
      r.ranker_version,
      RANKER_VERSION,
      `ranker_version stamped on ${it.input.correlationId}`
    );
    assert.ok(["URGENT", "IMPORTANT", "FYI", "AWARENESS"].includes(r.bucket));
    assert.equal(typeof r.features, "object");
  }
});

// ── determinism: same input → same output ─────────────────────────────────────────────────────────

test("determinism — two runs over the corpus produce identical RankResult sets", () => {
  const a = ITEMS.map((it) => rankItem(it.input, registry));
  const b = ITEMS.map((it) => rankItem(it.input, registry));
  assert.deepEqual(a, b, "identical inputs must yield identical RankResults");
  // rankCorpus ordering is stable too.
  const o1 = rankCorpus(
    ITEMS.map((it) => it.input),
    registry
  ).map((r) => r.input.correlationId);
  const o2 = rankCorpus(
    ITEMS.map((it) => it.input),
    registry
  ).map((r) => r.input.correlationId);
  assert.deepEqual(o1, o2, "ranked order is deterministic");
});

// ── golden regression lock on the frozen corpus ───────────────────────────────────────────────────

test("golden bucket lock — the frozen corpus reproduces its expected_bucket assignments", () => {
  const mismatches = [];
  for (const it of ITEMS) {
    const r = rankItem(it.input, registry);
    if (r.bucket !== it.label.expected_bucket) {
      mismatches.push({
        id: it.input.correlationId,
        got: r.bucket,
        want: it.label.expected_bucket,
      });
    }
  }
  assert.equal(
    mismatches.length,
    0,
    `golden bucket lock drift: ${JSON.stringify(mismatches.slice(0, 8))}`
  );
});

// ── Appendix-A parity: hand-derived buckets from the digest rules ──────────────────────────────────
// Small inline registry so these cases isolate the Appendix-A bucket logic (protection is orthogonal).

const PARITY_REGISTRY = buildRegistry({
  people: [
    { ids: ["p1"], tier: 1, projectWeight: 0.8, entityFile: true, engagement: "active" },
    { ids: ["p2"], tier: 2, projectWeight: 0.5 },
    { ids: ["p3"], tier: 3, projectWeight: 0.2 },
  ],
});
const NOW = "2026-07-14T12:00:00.000Z";
const daysAgo = (d) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();

function mk(overrides) {
  return {
    channel: "whatsapp",
    sender: { account: null, handle: null, email: null, display: null },
    body: "",
    chatName: null,
    subject: null,
    fromAddress: null,
    threadKind: "dm",
    fromMe: false,
    correlationId: "parity",
    sentAt: daysAgo(0.5),
    now: NOW,
    ...overrides,
  };
}

const PARITY_CASES = [
  // from-me-last → AWARENESS
  [
    "from-me",
    mk({ sender: { account: "p1" }, fromMe: true, body: "Can you approve this by tomorrow?" }),
    "AWARENESS",
  ],
  // noise gate → AWARENESS
  ["empty body", mk({ sender: { account: "p1" }, body: "" }), "AWARENESS"],
  ["system line", mk({ sender: { account: "p1" }, body: "Missed video call" }), "AWARENESS"],
  ["one-word ack", mk({ sender: { account: "p1" }, body: "noted" }), "AWARENESS"],
  ["one-word ack thanks", mk({ sender: { account: "p1" }, body: "thanks so much" }), "AWARENESS"],
  ["emoji-only", mk({ sender: { account: "p1" }, body: "👍🎉" }), "AWARENESS"],
  // groups
  [
    "group high-actionability",
    mk({
      threadKind: "group",
      chatName: "Team",
      sender: { account: "p1" },
      body: "Can you review this by tomorrow?",
    }),
    "IMPORTANT",
  ],
  [
    "group low-actionability",
    mk({
      threadKind: "group",
      chatName: "Team",
      sender: { account: "p1" },
      body: "I finished the report.",
    }),
    "AWARENESS",
  ],
  [
    "group vendorish",
    mk({
      threadKind: "group",
      chatName: "Resort",
      sender: { account: "p2" },
      body: "How can we help? Please confirm your reservation.",
    }),
    "AWARENESS",
  ],
  // DMs — URGENT / IMPORTANT / FYI / AWARENESS cascade
  [
    "dm tier1 recent urgent",
    mk({
      sender: { account: "p1" },
      body: "Can you approve this by tomorrow? Urgent.",
      sentAt: daysAgo(0.5),
    }),
    "URGENT",
  ],
  [
    "dm tier1 needs but old",
    mk({
      sender: { account: "p1" },
      body: "Can you approve this by tomorrow? Urgent.",
      sentAt: daysAgo(5),
    }),
    "IMPORTANT",
  ],
  [
    "dm tier1 needs age-unknown coarser",
    mk({
      sender: { account: "p1" },
      body: "Can you approve this by tomorrow? Urgent.",
      sentAt: null,
    }),
    "IMPORTANT",
  ],
  [
    "dm tier2 moderate-actionability needs",
    mk({ sender: { account: "p2" }, body: "what about it" }),
    "IMPORTANT",
  ],
  [
    "dm unknown sender low-act",
    mk({ sender: { handle: "stranger" }, body: "Just sharing an update here." }),
    "AWARENESS",
  ],
  [
    "dm tier3 low-act fyi",
    mk({ sender: { account: "p3" }, body: "Just sharing an update here." }),
    "FYI",
  ],
  [
    "dm vendorish",
    mk({
      sender: { account: "p2" },
      body: "Your booking is confirmed, thank you for choosing us.",
    }),
    "AWARENESS",
  ],
  // email stage-0 mutes
  [
    "email auto-reply subject",
    mk({
      channel: "gmail",
      threadKind: "email-thread",
      sender: { account: "p1" },
      subject: "Out of office",
      body: "I am away until Monday.",
    }),
    "AWARENESS",
  ],
  [
    "email bulk sender",
    mk({
      channel: "gmail",
      threadKind: "email-thread",
      sender: { email: "x@y.com" },
      fromAddress: "no-reply@list.com",
      subject: "News",
      body: "Weekly digest.",
    }),
    "AWARENESS",
  ],
];

test("Appendix-A parity — hand-derived bucket assignments reproduce exactly", () => {
  for (const [name, input, expected] of PARITY_CASES) {
    const r = rankItem(input, PARITY_REGISTRY);
    assert.equal(
      r.bucket,
      expected,
      `parity[${name}] expected ${expected}, got ${r.bucket} (why: ${r.why})`
    );
  }
});

test("Appendix-A parity — signal formula = importance^0.5 · (0.3 + 0.7·actionability)", () => {
  const r = rankItem(
    mk({ sender: { account: "p1" }, body: "Can you approve this by tomorrow? Urgent." }),
    PARITY_REGISTRY
  );
  const imp = r.features.importance;
  const act = r.features.actionability;
  const expected = Math.round(Math.sqrt(imp) * (0.3 + 0.7 * act) * 1e4) / 1e4;
  assert.equal(r.signal, expected, "signal must match the Appendix-A formula");
});

// ── SHADOW MODE: zero byte-change to the I-02 read-model digest ────────────────────────────────────

test("shadow-mode zero-byte-change — ranking + recording leaves the I-02 read-model digest identical", () => {
  const root = ws("inbox-shadow-");
  try {
    // Build a non-trivial read model from the journal (I-02 canonical projection).
    const cid = "corr-shadow";
    appendInboxEvent(root, {
      kind: "observation-correlation",
      correlation_id: cid,
      payload: { source: "email", native_id: "n1", thread_id: "t1" },
    });
    appendInboxEvent(root, {
      kind: "user-intent",
      correlation_id: cid,
      payload: { intent: "surface" },
    });
    appendInboxEvent(root, {
      kind: "user-intent",
      correlation_id: cid,
      payload: { intent: "acknowledge" },
    });
    const before = rebuildReadModel(root);

    // Run the ranker over the corpus and RECORD shadow rows (the shadow harness).
    const ranked = rankCorpus(
      ITEMS.map((it) => it.input),
      registry
    );
    const written = recordShadowRanking(root, ranked);
    assert.equal(written.length, ITEMS.length, "every ranked row recorded");

    // The shadow sidecar lives in the admin-tier LOCAL inbox dir — NOT the canonical projection.
    const sidecar = shadowLogPath(root);
    assert.ok(existsSync(sidecar), "shadow sidecar written");
    assert.ok(
      sidecar.includes(path.join(INBOX_DIR_REL)),
      "sidecar is under admin-tier local .aios/loop/inbox"
    );
    assert.equal(path.basename(sidecar), SHADOW_LOG_BASENAME);
    assert.ok(statSync(sidecar).size > 0, "sidecar non-empty");

    // Every recorded row carries why + ranker_version + numeric features (tier-safe local artifact).
    const lines = readFileSync(sidecar, "utf8").trim().split("\n");
    assert.equal(lines.length, ITEMS.length);
    for (const line of lines) {
      const row = JSON.parse(line);
      assert.ok(row.why && row.why.length > 0, "recorded why non-empty");
      assert.equal(row.ranker_version, RANKER_VERSION);
      assert.equal(typeof row.features, "object");
    }

    // ZERO byte-change: rebuild the read model and assert the canonical digest is byte-identical.
    const after = rebuildReadModel(root);
    assert.equal(
      after.digest,
      before.digest,
      "shadow ranking must NOT perturb the I-02 read-model digest"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── fail-open: absent/broken registry never crashes and never claims protected ────────────────────

test("fail-open — absent registry ranks everything unprotected (tier-only), never crashes", () => {
  const emptyReg = loadRegistry(path.join(FIXTURES, "does-not-exist.json"));
  assert.equal(emptyReg.present, false);
  for (const it of ITEMS) {
    const r = rankItem(it.input, emptyReg);
    assert.equal(r.protected, false, "no registry → never a silent protected claim");
    assert.ok(r.why.length > 0);
    assert.ok(["URGENT", "IMPORTANT", "FYI", "AWARENESS"].includes(r.bucket));
  }
});
