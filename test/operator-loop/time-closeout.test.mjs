import { test } from "node:test";
import assert from "node:assert/strict";
import { runShareable, runCloseout } from "../../dist/operator-loop/index.js";

// A team decision (so the stub drafter has a normal claim) + time rows carrying "leaky" repo
// aliases and block ids that must NEVER reach shareable text / prompts / verifier JSON.
const SECRET_REPO = "SECRET-CLIENT-REPO";
const decision = {
  kind: "decision",
  source: "decision-log",
  tier: "team",
  occurredAt: "2026-06-30T09:00:00.000Z",
  ref: { path: "3-log/decision-log.md", row: "1", tier: "team" },
  summary: "Shipped the operator loop",
  payload: {},
};
const timeSig = (id, tier, tag, min, repo) => ({
  kind: "time",
  source: "session",
  tier,
  occurredAt: "2026-06-30T09:00:00.000Z",
  ref: { path: "3-log/time-log.md", row: id, tier },
  summary: `${tag} — ${min}m`,
  payload: { repo, durationMin: min, tag },
});

const manifest = () => ({
  member: "alex",
  project: "acme",
  window: { cadence: "weekly", from: "2026-06-24T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" },
  windowed: true,
  generatedAt: "2026-07-01T00:00:00.000Z",
  signals: [
    decision,
    timeSig("blk_secret1", "team", "engineering", 40, SECRET_REPO),
    timeSig("blk_secret2", "team", "research", 20, SECRET_REPO),
    timeSig("blk_admin", "admin", "admin", 30, "personal-life"),
  ],
  excluded: [],
});

test("closeout: team digest shows runtime-by-tag aggregate, and NO repo/id/admin content", async () => {
  const r = await runShareable({ fullManifest: manifest(), audience: "team" });
  const md = r.digestMarkdown;
  assert.match(md, /Agent runtime \(by tag\)/);
  assert.match(md, /engineering: 0\.7h/);
  assert.match(md, /research: 0\.3h/);
  // aggregate only — none of these may appear:
  for (const leak of [
    SECRET_REPO,
    "personal-life",
    "blk_secret1",
    "blk_secret2",
    "blk_admin",
    "time-log.md",
  ]) {
    assert.ok(!md.includes(leak), `digest must not contain "${leak}"`);
  }
  // admin row (personal-life, 30m) is stripped from the team aggregate entirely
  assert.ok(!md.includes("admin: 0.5h"));
  // verifier JSON + actions carry no time content
  assert.ok(!JSON.stringify(r.result).includes(SECRET_REPO));
  assert.ok(!JSON.stringify(r.nextWeekActions).includes("time-log.md"));
});

test("closeout: time signals never reach the remote drafter prompt/catalogue", async () => {
  let prompt = "";
  const complete = async ({ system, user }) => {
    prompt += "\n" + (system ?? "") + "\n" + (user ?? "");
    return { claims: [], actions: [] };
  };
  await runShareable({ fullManifest: manifest(), audience: "team", complete });
  for (const leak of [SECRET_REPO, "time-log.md", "blk_secret1", "[time/"]) {
    assert.ok(!prompt.includes(leak), `drafter prompt must not contain "${leak}"`);
  }
});

test("closeout: owner brief includes admin runtime; team/external shareables do not leak", async () => {
  const c = await runCloseout({
    fullManifest: manifest(),
    shareableAudiences: ["team", "external"],
  });
  // owner sees all three tags incl. admin
  assert.match(c.briefMarkdown, /Agent runtime \(by tag\)/);
  assert.match(c.briefMarkdown, /admin: 0\.5h/);

  for (const s of c.shareables) {
    assert.ok(!s.digestMarkdown.includes(SECRET_REPO));
    assert.ok(!s.digestMarkdown.includes("personal-life"));
    assert.ok(!s.digestMarkdown.includes("blk_"));
  }
  const team = c.shareables.find((s) => s.audience === "team");
  assert.match(team.digestMarkdown, /Agent runtime/);
  assert.ok(!team.digestMarkdown.includes("admin: 0.5h")); // admin block absent from team aggregate
});
