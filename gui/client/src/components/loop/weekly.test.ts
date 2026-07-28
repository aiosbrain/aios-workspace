import { describe, expect, test } from "vitest";
import {
  askPromptForItem,
  classifyBriefItem,
  parseBrief,
  parseBriefHeader,
  plainTitle,
  type WeeklyGroup,
} from "./weekly";

/**
 * A brief shaped exactly like `renderBrief` in src/operator-loop/closeout.ts emits one.
 *
 * FULLY SYNTHETIC — invented member, client and people, matching the `alex`/`acme` convention in
 * test/operator-loop/closeout.test.mjs. This fixture must never be copied from a real closeout:
 * a brief is admin-tier by construction and this repo is public. What matters here is the SHAPE
 * (bold + [Type-N] decisions, evidence suffixes, the commit-mirror path form, bare `---` noise),
 * not the words.
 */
const BRIEF = [
  "---",
  "access: admin",
  "---",
  "",
  "# Private operator brief — alex",
  "_2026-07-20 → 2026-07-27 · verifier: PASS · signals team:664  admin:45  external:2_",
  "",
  "> Owner-only. Contains admin-tier content. Never synced; never shared.",
  "",
  "## The honest picture",
  "- **Pause the widget rewrite** — v1 stays on the CLI. [Type-2] _(evidence: 3-log/decision-log.md)_",
  "- **Adapter for the sync tool** so sam keeps their flow. [Type-1] _(evidence: 3-log/decision-log.md)_",
  "- Acme — Stakeholder Analysis _(evidence: 2-work/clients/acme/2026-07-20-assessment.md)_",
  "- Commit 003d26540a — acme-brain _(evidence: 1-inbox/from-brain/commits__commits__acme-brain__003d26540a.md)_",
  "- Commit 01e8b08eaf — acme-brain _(evidence: 1-inbox/from-brain/commits__commits__acme-brain__01e8b08eaf.md)_",
  "- Acme Team Brain _(evidence: 1-inbox/from-brain/_projects/acme-brain.md)_",
  '- Meeting: "Design sync" with riley _(evidence: .aios/loop/comms/calendar/admin/_.ndjson)_',
  '- Email needing reply: "Re: Q3 rollout" _(evidence: .aios/loop/comms/email/admin/_.ndjson)_',
  "- Tasks — Acme _(evidence: 3-log/tasks.md)_",
  "- Role — riley @ Acme _(evidence: 0-context/role.md)_",
  "- ---",
  "- ---",
  "",
  "## Next week",
  "- [admin] Close the Q3 rollout thread — open admin-tier item from this week",
  "- [team] Prep the partner narrative deck",
  "",
].join("\n");

describe("parseBriefHeader", () => {
  test("reads member, window, verifier and per-tier signal counts", () => {
    const h = parseBriefHeader(BRIEF);
    expect(h.member).toBe("alex");
    expect(h.from).toBe("2026-07-20");
    expect(h.to).toBe("2026-07-27");
    expect(h.verifier).toBe("PASS");
    expect(h.tierCounts).toEqual([
      { tier: "team", count: 664 },
      { tier: "admin", count: 45 },
      { tier: "external", count: 2 },
    ]);
    expect(h.foldedCommits).toBe(0);
  });

  test("picks up the drafter's commit-mirror fold count", () => {
    const h = parseBriefHeader(
      `${BRIEF}\n_289 mirrored commit signal(s) folded out of this picture._`
    );
    expect(h.foldedCommits).toBe(289);
  });

  test("survives a brief that is missing its header entirely", () => {
    const h = parseBriefHeader("## The honest picture\n- something _(evidence: 2-work/x.md)_");
    expect(h.member).toBeNull();
    expect(h.verifier).toBeNull();
    expect(h.tierCounts).toEqual([]);
  });
});

describe("classifyBriefItem", () => {
  const cases: Array<[string, WeeklyGroup]> = [
    ["3-log/decision-log.md", "decision"],
    ["2-work/clients/acme/notes.md", "work"],
    [".aios/loop/comms/email/admin/_.ndjson", "reply"],
    [".aios/loop/comms/calendar/admin/_.ndjson", "meeting"],
    ["3-log/tasks.md", "task"],
    ["3-log/tasks-team.md", "task"],
    ["1-inbox/from-brain/_projects/acme-brain.md", "brain"],
    ["1-inbox/clients/acme/emails/update.md", "brain"],
    ["0-context/role.md", "context"],
    ["4-shared/company.md", "context"],
    ["1-inbox/from-brain/commits__commits__acme__00659d9094.md", "mirror"],
    ["some/unknown/place.md", "other"],
  ];
  for (const [path, group] of cases) {
    test(`${path} → ${group}`, () => {
      expect(classifyBriefItem([path], "a claim")).toBe(group);
    });
  }

  test("the commit mirror wins over the brain group it lives inside", () => {
    // Both patterns match this path; burial under "From the brain" is the bug being fixed.
    expect(classifyBriefItem(["1-inbox/from-brain/commits__commits__a__b.md"], "Commit b")).toBe(
      "mirror"
    );
  });

  test("a [Type-N] tag classifies a decision that cites no known path", () => {
    expect(classifyBriefItem([], "**Ship v1** [Type-2]")).toBe("decision");
  });

  test("evidence path beats claim text — prose about commits is not the commit mirror", () => {
    expect(classifyBriefItem(["2-work/commit-conventions.md"], "Commit conventions")).toBe("work");
  });

  test("a pulled copy of someone else's decision log is a brain artefact, not your decision", () => {
    // Provenance beats filename: this is a mirror of another workspace's log, and listing it under
    // Decisions puts other people's records beside the ones this operator actually took.
    expect(
      classifyBriefItem(
        ["1-inbox/from-brain/peer-workspace__3-log__decision-log.md"],
        "Decision Log"
      )
    ).toBe("brain");
    // The operator's OWN log still classifies as a decision.
    expect(classifyBriefItem(["3-log/decision-log.md"], "Pause the GUI")).toBe("decision");
  });
});

describe("plainTitle", () => {
  test("strips the decision tag and bold emphasis", () => {
    expect(plainTitle("**Pause the widget rewrite** — v1 stays on the CLI. [Type-2]")).toBe(
      "Pause the widget rewrite — v1 stays on the CLI."
    );
  });
});

describe("parseBrief", () => {
  const parsed = parseBrief(BRIEF);

  test("groups render in declaration order, empty groups omitted", () => {
    expect(parsed.groups.map((g) => g.group)).toEqual([
      "decision",
      "work",
      "reply",
      "meeting",
      "task",
      "brain",
      "context",
      "mirror",
    ]);
  });

  test("decisions keep their type tag and lose the markdown", () => {
    const decisions = parsed.groups.find((g) => g.group === "decision")!;
    expect(decisions.items).toHaveLength(2);
    expect(decisions.items[0].title).toBe("Pause the widget rewrite — v1 stays on the CLI.");
    expect(decisions.items[0].decisionType).toBe("Type-2");
    expect(decisions.items[1].decisionType).toBe("Type-1");
  });

  test("the commit mirror is collected and collapsed, not dropped", () => {
    const mirror = parsed.groups.find((g) => g.group === "mirror")!;
    expect(mirror.items).toHaveLength(2);
    expect(mirror.defaultOpen).toBe(false);
  });

  test("high-signal groups open expanded", () => {
    for (const g of ["decision", "work", "reply", "meeting", "task"] as const) {
      expect(parsed.groups.find((b) => b.group === g)!.defaultOpen).toBe(true);
    }
  });

  test("received-feed groups open collapsed so they cannot bury owed work", () => {
    for (const g of ["brain", "context", "mirror"] as const) {
      expect(parsed.groups.find((b) => b.group === g)!.defaultOpen).toBe(false);
    }
  });

  test("evidence refs survive parsing", () => {
    const work = parsed.groups.find((g) => g.group === "work")!;
    expect(work.items[0].evidence).toEqual(["2-work/clients/acme/2026-07-20-assessment.md"]);
  });

  test("horizontal-rule noise bullets are dropped", () => {
    const titles = parsed.groups.flatMap((g) => g.items.map((i) => i.title));
    expect(titles).not.toContain("---");
    // 12 bullets in the fixture, 2 of them bare horizontal rules.
    expect(parsed.itemCount).toBe(10);
  });

  test("next-week actions parse with their tier", () => {
    expect(parsed.nextWeek).toEqual([
      {
        key: "next:0:Close the Q3 rollout thread — open admin-tier item from this week",
        tier: "admin",
        title: "Close the Q3 rollout thread — open admin-tier item from this week",
      },
      {
        key: "next:1:Prep the partner narrative deck",
        tier: "team",
        title: "Prep the partner narrative deck",
      },
    ]);
  });

  test("the empty-state sentence yields no actions", () => {
    const empty = parseBrief("## Next week\n_No next-week actions proposed._\n");
    expect(empty.nextWeek).toEqual([]);
  });

  test("a claim cited twice collapses to one row", () => {
    const dup = parseBrief(
      [
        "## The honest picture",
        "- Same claim _(evidence: 2-work/a.md)_",
        "- Same claim _(evidence: 2-work/a.md)_",
      ].join("\n")
    );
    expect(dup.itemCount).toBe(1);
  });

  test("an empty brief parses to nothing rather than throwing", () => {
    const empty = parseBrief("");
    expect(empty.groups).toEqual([]);
    expect(empty.nextWeek).toEqual([]);
    expect(empty.itemCount).toBe(0);
  });
});

describe("askPromptForItem", () => {
  test("carries the group and the evidence ref", () => {
    const item = parseBrief(BRIEF).groups.find((g) => g.group === "reply")!.items[0];
    const prompt = askPromptForItem(item);
    expect(prompt).toContain("From my weekly closeout (needs reply)");
    expect(prompt).toContain(".aios/loop/comms/email/admin/_.ndjson");
  });

  test("says so plainly when a claim cited no evidence", () => {
    expect(
      askPromptForItem({
        key: "k",
        group: "other",
        title: "t",
        evidence: [],
        decisionType: null,
      })
    ).toContain("(no evidence ref)");
  });
});
