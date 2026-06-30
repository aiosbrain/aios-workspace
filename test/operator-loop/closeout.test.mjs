// C5 weekly closeout tests. The leak-critical behavior, proven with an injected fake CompletionFn
// (no network): drafter input is tier-bounded (admin + excluded never sent); the digest renders
// from the POST-correction ledger; and a deterministic C5 sweep catches above-audience TEXT even
// when a claim cites an allowed ref (the gap C3 alone does not cover).

import test from "node:test";
import assert from "node:assert/strict";
import { runCloseout, runShareable } from "../../dist/operator-loop/index.js";

// ── fixtures ────────────────────────────────────────────────────────────────
// Unique sentinels we sweep for. Admin/team summaries + paths must never reach a lower audience.
const ADMIN_SENTINEL = "ZZACQUISITION40M";
const TEAM_SENTINEL = "ZZINTERNALTEAMNOTE";
const EXCLUDED_SENTINEL = "ZZEXCLUDEDSECRETPATH";

const sig = (path, row, tier, kind, summary) => ({
  kind,
  source: kind,
  tier,
  occurredAt: "2026-06-29T00:00:00.000Z",
  ref: { path, row, tier },
  summary,
});

const FULL_MANIFEST = {
  member: "alex",
  project: "acme",
  generatedAt: "2026-06-30T00:00:00.000Z",
  window: { cadence: "weekly", from: "2026-06-23", to: "2026-06-30" },
  signals: [
    sig("4-shared/public.md", "1", "external", "deliverable", "Shipped the public widget"),
    sig("2-work/notes.md", "2", "team", "task", `Team task ${TEAM_SENTINEL}`),
    sig("5-personal/secret.md", "7", "admin", "decision", `Acquisition price ${ADMIN_SENTINEL}`),
  ],
  excluded: [{ ref: `5-personal/${EXCLUDED_SENTINEL}.md`, reason: "no resolvable tier" }],
};

// A fake CompletionFn that RECORDS what it was handed, and returns a scripted draft object.
function fakeComplete(reply, capture = {}) {
  return async (req) => {
    capture.last = req;
    capture.calls = (capture.calls ?? 0) + 1;
    return typeof reply === "function" ? reply(req, capture) : reply;
  };
}

// ── both artifacts at correct tiers ───────────────────────────────────────────
test("runCloseout emits an owner brief (admin) + shareable digest (admin omitted)", async () => {
  const r = await runCloseout({ fullManifest: FULL_MANIFEST, shareableAudiences: ["team"] }); // offline stub
  assert.match(r.briefMarkdown, /access: admin/);
  assert.ok(r.briefMarkdown.includes(ADMIN_SENTINEL), "owner brief shows admin content");
  assert.equal(r.shareables.length, 1);
  const team = r.shareables[0];
  assert.equal(team.audience, "team");
  assert.ok(!team.digestMarkdown.includes(ADMIN_SENTINEL), "team digest must omit admin content");
  assert.ok(team.digestMarkdown.includes(TEAM_SENTINEL), "team digest includes team content");
});

test("external digest excludes BOTH admin and team content; withheld counts render", async () => {
  const r = await runCloseout({ fullManifest: FULL_MANIFEST, shareableAudiences: ["external"] });
  const ext = r.shareables[0];
  assert.ok(!ext.digestMarkdown.includes(ADMIN_SENTINEL), "no admin in external digest");
  assert.ok(!ext.digestMarkdown.includes(TEAM_SENTINEL), "no team in external digest");
  // 1 team + 1 admin signal sit above the external audience → withheld counts must be visible.
  assert.match(ext.digestMarkdown, /Withheld from this audience/);
  assert.match(ext.digestMarkdown, /1 team-tier/);
  assert.match(ext.digestMarkdown, /1 admin-tier/);
});

// ── drafter-input tier binding (the privacy guarantee) ─────────────────────────
test("the drafter is handed ONLY ≤-audience signals; admin + excluded never reach it", async () => {
  const cap = {};
  const complete = fakeComplete(
    {
      claims: [
        { claim: "ok", evidence: [{ path: "4-shared/public.md", row: "1", tier: "external" }] },
      ],
      actions: [],
    },
    cap
  );
  await runShareable({ fullManifest: FULL_MANIFEST, audience: "team", complete });
  const sent = cap.last.user; // the prompt text handed to the model
  assert.ok(!sent.includes(ADMIN_SENTINEL), "admin signal summary must not be sent");
  assert.ok(!sent.includes("5-personal/secret.md"), "admin path must not be sent");
  assert.ok(!sent.includes(EXCLUDED_SENTINEL), "excluded entry must not be sent");
  assert.ok(sent.includes(TEAM_SENTINEL), "team signal IS in the team projection");
});

test("the external drafter sees neither admin nor team signals", async () => {
  const cap = {};
  const complete = fakeComplete({ claims: [], actions: [] }, cap);
  await runShareable({ fullManifest: FULL_MANIFEST, audience: "external", complete });
  const sent = cap.last.user;
  assert.ok(!sent.includes(ADMIN_SENTINEL) && !sent.includes(TEAM_SENTINEL));
  assert.ok(sent.includes("public widget"), "external signal IS present");
});

// ── corrected-ledger rendering + bounded correction ────────────────────────────
test("digest renders from the POST-correction ledger (corrected), not the failing draft", async () => {
  let call = 0;
  const complete = async (_req) => {
    call++;
    if (call === 1) {
      // First draft: a fabricated ref (does not resolve) → V2 must-fail.
      return {
        claims: [
          { claim: "FABRICATED", evidence: [{ path: "nope/x.md", row: "9", tier: "external" }] },
        ],
        actions: [],
      };
    }
    // Correction: a clean, grounded claim.
    return {
      claims: [
        {
          claim: "Corrected public win",
          evidence: [{ path: "4-shared/public.md", row: "1", tier: "external" }],
        },
      ],
      actions: [],
    };
  };
  const ext = await runShareable({ fullManifest: FULL_MANIFEST, audience: "external", complete });
  assert.equal(ext.status, "corrected");
  assert.ok(ext.digestMarkdown.includes("Corrected public win"), "renders the corrected claim");
  assert.ok(!ext.digestMarkdown.includes("FABRICATED"), "the failing draft must not be rendered");
});

test("a corrector that never fixes → failed, non-shippable, bounded by budget", async () => {
  const complete = async () => ({
    claims: [{ claim: "still bad", evidence: [{ path: "nope/x.md", row: "9", tier: "external" }] }],
    actions: [],
  });
  const ext = await runShareable({ fullManifest: FULL_MANIFEST, audience: "external", complete });
  assert.equal(ext.status, "failed");
  assert.equal(ext.shippable, false);
  assert.equal(ext.result.loopsUsed, ext.result.budget); // bounded
});

// ── the C3 GAP: above-audience TEXT with a VALID allowed ref ────────────────────
test("C5 sweep withholds a claim whose TEXT quotes admin content even with a VALID allowed ref", async () => {
  // The claim cites a real external ref (C3 passes it), but its TEXT contains the admin sentinel.
  const complete = async () => ({
    claims: [
      {
        claim: `We shipped the widget — acquisition ${ADMIN_SENTINEL}`,
        evidence: [{ path: "4-shared/public.md", row: "1", tier: "external" }],
      },
    ],
    actions: [],
  });
  const team = await runShareable({ fullManifest: FULL_MANIFEST, audience: "team", complete });
  assert.ok(
    !team.digestMarkdown.includes(ADMIN_SENTINEL),
    "admin text must be withheld from the digest"
  );
  assert.ok(team.leakWithheld >= 1, "the leak sweep recorded a withhold");
  assert.equal(team.shippable, false, "a leak-withheld claim makes the run non-shippable");
  assert.match(team.digestMarkdown, /withheld — claim text referenced above-audience material/);
});

test("C5 sweep also withholds a next-week ACTION whose text quotes above-audience content", async () => {
  const complete = async () => ({
    claims: [
      { claim: "clean", evidence: [{ path: "4-shared/public.md", row: "1", tier: "external" }] },
    ],
    actions: [{ title: `Follow up on ${TEAM_SENTINEL}`, tier: "external", rationale: "x" }],
  });
  const ext = await runShareable({ fullManifest: FULL_MANIFEST, audience: "external", complete });
  assert.ok(
    !ext.digestMarkdown.includes(TEAM_SENTINEL),
    "team text must not survive in external actions"
  );
  assert.ok(ext.leakWithheld >= 1);
});

// ── next-week actions: deterministic admin + dedupe/merge ───────────────────────
test("owner next-week actions include deterministic admin candidates; shareables don't", async () => {
  const adminTask = sig("5-personal/todo.md", "3", "admin", "task", `Admin todo ${ADMIN_SENTINEL}`);
  const manifest = { ...FULL_MANIFEST, signals: [...FULL_MANIFEST.signals, adminTask] };
  const r = await runCloseout({ fullManifest: manifest, shareableAudiences: ["team"] });
  const ownerAdmin = r.ownerNextWeekActions.filter((a) => a.tier === "admin");
  assert.ok(ownerAdmin.length >= 1, "deterministic admin action surfaced in the owner set");
  // the shareable team digest must not carry the admin action text
  assert.ok(!r.shareables[0].digestMarkdown.includes(ADMIN_SENTINEL));
});

test("--all dedupes the same action title across team+external to one, at broadest visibility", async () => {
  // Both pipelines propose the same titled action; external (broadest) should win in the owner set.
  const complete = async (req) => {
    const isExternal =
      req.system.includes('"external"') ||
      (req.user.includes("public widget") && !req.user.includes("notes.md"));
    return {
      claims: [
        { claim: "c", evidence: [{ path: "4-shared/public.md", row: "1", tier: "external" }] },
      ],
      actions: [{ title: "Ship v2", tier: isExternal ? "external" : "team", rationale: "r" }],
    };
  };
  const r = await runCloseout({
    fullManifest: FULL_MANIFEST,
    shareableAudiences: ["team", "external"],
    complete,
  });
  const shipV2 = r.ownerNextWeekActions.filter((a) => a.title.toLowerCase() === "ship v2");
  assert.equal(shipV2.length, 1, "deduped to a single action");
  assert.equal(shipV2[0].tier, "external", "kept the broadest-visibility tier");
});

// ── full anti-leak sweep on the serialized shareable result ─────────────────────
test("a serialized shareable result leaks no admin/team text/path/row for external", async () => {
  const ext = await runShareable({ fullManifest: FULL_MANIFEST, audience: "external" }); // offline stub
  const ser = JSON.stringify({
    digestMarkdown: ext.digestMarkdown,
    result: ext.result,
    nextWeekActions: ext.nextWeekActions,
  });
  assert.ok(!ser.includes(ADMIN_SENTINEL), "no admin text");
  assert.ok(!ser.includes(TEAM_SENTINEL), "no team text");
  assert.ok(!ser.includes("5-personal/secret.md"), "no admin path");
  assert.ok(!ser.includes("2-work/notes.md"), "no team path");
  assert.ok(!ser.includes(EXCLUDED_SENTINEL), "no excluded path");
});

// ── validator-driven hardening ─────────────────────────────────────────────────

test("a tier-mismatched signal (tier=team but ref.tier=admin) is NOT sent to the drafter", async () => {
  const cap = {};
  const complete = fakeComplete({ claims: [], actions: [] }, cap);
  const sneaky = {
    kind: "decision",
    source: "decision",
    tier: "team", // mislabeled
    occurredAt: "2026-06-29T00:00:00.000Z",
    ref: { path: `5-personal/${ADMIN_SENTINEL}.md`, row: "9", tier: "admin" }, // real admin ref
    summary: `Sneaky ${ADMIN_SENTINEL}`,
  };
  const manifest = { ...FULL_MANIFEST, signals: [FULL_MANIFEST.signals[0], sneaky] };
  const res = await runShareable({ fullManifest: manifest, audience: "team", complete });
  assert.ok(!cap.last.user.includes(ADMIN_SENTINEL), "the admin ref must not reach the drafter");
  assert.ok(!res.digestMarkdown.includes(ADMIN_SENTINEL), "and never the digest");
});

test("the sweep catches a short sensitive id (e.g. 40m) quoted with a VALID allowed ref", async () => {
  const manifest = {
    ...FULL_MANIFEST,
    signals: [
      sig("4-shared/public.md", "1", "external", "deliverable", "Shipped the public widget"),
      sig("5-personal/p.md", "2", "admin", "decision", "Acquisition price is 40m total"),
    ],
  };
  const complete = async () => ({
    claims: [
      {
        claim: "We closed 40m in deals",
        evidence: [{ path: "4-shared/public.md", row: "1", tier: "external" }],
      },
    ],
    actions: [],
  });
  const team = await runShareable({ fullManifest: manifest, audience: "team", complete });
  assert.ok(!team.digestMarkdown.includes("40m"), "the sensitive id must be withheld");
  assert.equal(team.shippable, false);
});

test("a single common-word admin summary does NOT brick a valid lower-tier digest (no false positive)", async () => {
  const manifest = {
    ...FULL_MANIFEST,
    signals: [
      sig("4-shared/public.md", "1", "external", "deliverable", "Public launch"),
      sig("5-personal/f.md", "2", "admin", "decision", "Funding"), // single bare common word
    ],
  };
  const complete = async () => ({
    claims: [
      {
        claim: "We closed a funding round this week",
        evidence: [{ path: "4-shared/public.md", row: "1", tier: "external" }],
      },
    ],
    actions: [],
  });
  const team = await runShareable({ fullManifest: manifest, audience: "team", complete });
  assert.equal(team.shippable, true, "a coincidental common word must not withhold a valid claim");
  assert.ok(team.digestMarkdown.includes("funding round"));
});

test("shareable action evidence refs are stripped from the result (no ref reaches --json)", async () => {
  const complete = async () => ({
    claims: [
      { claim: "clean", evidence: [{ path: "4-shared/public.md", row: "1", tier: "external" }] },
    ],
    // an action that tries to smuggle an admin ref tagged as external
    actions: [
      {
        title: "Follow up",
        tier: "external",
        rationale: "x",
        evidence: [{ path: "5-personal/secret.md", row: "7", tier: "external" }],
      },
    ],
  });
  const team = await runShareable({ fullManifest: FULL_MANIFEST, audience: "team", complete });
  const ser = JSON.stringify(team.nextWeekActions);
  assert.ok(!ser.includes("evidence"), "shareable actions carry no evidence refs");
  assert.ok(!ser.includes("5-personal/secret.md"), "no smuggled admin path in actions");
});
