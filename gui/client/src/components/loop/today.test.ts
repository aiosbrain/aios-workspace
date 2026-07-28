import { describe, expect, test } from "vitest";
import {
  askPromptFor,
  buildTodayQueue,
  collapseRows,
  laneCounts,
  rankRows,
  stripSeveritySuffix,
  type TodayRow,
} from "./today";
import type { DailyItem, DailyOrientation } from "../../types/protocol";

function item(partial: Partial<DailyItem> & { summary: string }): DailyItem {
  return {
    kind: "task",
    tier: "admin",
    ref: { path: "3-log/tasks.md", row: "T1", tier: "admin" },
    ...partial,
  } as DailyItem;
}

function daily(partial: Partial<DailyOrientation> = {}): DailyOrientation {
  return {
    member: "john-ellison",
    window: { cadence: "daily", from: "2026-07-27T00:00:00Z", to: "2026-07-28T00:00:00Z" },
    generatedAt: "2026-07-28T10:00:00Z",
    audience: "owner",
    attention: [],
    queuedAsks: [],
    changed: [],
    blocked: [],
    owedToday: [],
    calendar: [],
    commsNeedingReply: [],
    ranByTag: [],
    counts: {
      attention: 0,
      queuedAsks: 0,
      changed: 0,
      blocked: 0,
      owedToday: 0,
      calendar: 0,
      commsNeedingReply: 0,
      withheld: 0,
      excluded: 0,
    },
    excluded: [],
    ...partial,
  } as DailyOrientation;
}

describe("stripSeveritySuffix", () => {
  test("removes the CLI's trailing severity tag, leaves the title otherwise intact", () => {
    expect(stripSeveritySuffix("Reconnect WhatsApp [blocker]")).toBe("Reconnect WhatsApp");
    expect(stripSeveritySuffix("Pick a plan [decision]")).toBe("Pick a plan");
    expect(stripSeveritySuffix("FYI: shipped [fyi]")).toBe("FYI: shipped");
  });

  test("leaves a bracketed phrase that is not a severity tag alone", () => {
    expect(stripSeveritySuffix("Fix the [auth] module")).toBe("Fix the [auth] module");
    expect(stripSeveritySuffix("Ship v1 [urgent]")).toBe("Ship v1 [urgent]");
  });
});

describe("buildTodayQueue", () => {
  test("splits the owed bucket into overdue vs due-today on overdueDays", () => {
    const queue = buildTodayQueue(
      daily({
        owedToday: [
          item({
            summary: "Late thing",
            overdueDays: 15,
            ref: { path: "t.md", row: "T1", tier: "admin" },
          }),
          item({ summary: "Today thing", ref: { path: "t.md", row: "T2", tier: "admin" } }),
        ],
      })
    );
    expect(queue.map((r) => [r.lane, r.title])).toEqual([
      ["overdue", "Late thing"],
      ["due", "Today thing"],
    ]);
  });

  test("ranks blockers above overdue above everything else, most-overdue first", () => {
    const queue = buildTodayQueue(
      daily({
        attention: [
          item({
            kind: "ask",
            summary: "Reconnect WhatsApp [blocker]",
            ref: { path: "a", row: "id1", tier: "admin" },
          }),
        ],
        owedToday: [
          item({
            summary: "3 days late",
            overdueDays: 3,
            ref: { path: "t.md", row: "T1", tier: "admin" },
          }),
          item({
            summary: "15 days late",
            overdueDays: 15,
            ref: { path: "t.md", row: "T2", tier: "admin" },
          }),
        ],
        queuedAsks: [
          item({
            kind: "ask",
            summary: "Slack scopes [fyi]",
            ref: { path: "a", row: "id2", tier: "admin" },
          }),
        ],
        calendar: [item({ kind: "comms", summary: "Standup", ref: { path: "c", tier: "admin" } })],
      })
    );
    expect(queue.map((r) => r.title)).toEqual([
      "Reconnect WhatsApp",
      "15 days late",
      "3 days late",
      "Slack scopes",
      "Standup",
    ]);
  });

  test("the `changed` diff feed never enters the queue — it is audit data, not owed work", () => {
    const queue = buildTodayQueue(
      daily({ changed: [item({ summary: "some file moved", changeType: "modified" })] })
    );
    expect(queue).toEqual([]);
  });

  test("an ask row can be resolved and carries its id; a task row can be completed", () => {
    const queue = buildTodayQueue(
      daily({
        attention: [
          item({
            kind: "ask",
            summary: "Do the thing [blocker]",
            ref: { path: "a", row: "3fea973d", tier: "admin" },
          }),
        ],
        owedToday: [
          item({ summary: "A task", ref: { path: "3-log/tasks.md", row: "TT9", tier: "admin" } }),
        ],
      })
    );
    const [ask, task] = queue;
    expect(ask.action).toBe("resolve-ask");
    expect(ask.askIds).toEqual(["3fea973d"]);
    expect(task.action).toBe("complete-task");
    expect(task.taskRowKey).toBe("TT9");
  });

  test("a calendar event offers no action — it is context, not work", () => {
    const queue = buildTodayQueue(
      daily({
        calendar: [item({ kind: "comms", summary: "Standup", ref: { path: "c", tier: "admin" } })],
      })
    );
    expect(queue[0].action).toBe("none");
  });
});

describe("collapseRows", () => {
  test("folds the duplicate idle asks into one row that resolves all of them at once", () => {
    // The exact field failure: seven abandoned sessions, seven identical blockers.
    const queue = buildTodayQueue(
      daily({
        attention: Array.from({ length: 7 }, (_, i) =>
          item({
            kind: "ask",
            summary: "Claude is waiting for your input [blocker]",
            ref: { path: ".aios/loop/asks/asks.ndjson", row: `id${i}`, tier: "admin" },
          })
        ),
      })
    );
    expect(queue).toHaveLength(1);
    expect(queue[0].count).toBe(7);
    expect(queue[0].askIds).toHaveLength(7);
    expect(queue[0].title).toBe("Claude is waiting for your input");
  });

  test("distinct titles are never folded together", () => {
    const queue = buildTodayQueue(
      daily({
        attention: [
          item({
            kind: "ask",
            summary: "Reconnect WhatsApp [blocker]",
            ref: { path: "a", row: "1", tier: "admin" },
          }),
          item({
            kind: "ask",
            summary: "Connect Telegram [blocker]",
            ref: { path: "a", row: "2", tier: "admin" },
          }),
        ],
      })
    );
    expect(queue).toHaveLength(2);
    expect(queue.every((r) => r.count === 1)).toBe(true);
  });

  test("a collapsed row keeps the WORST lateness, never the first one seen", () => {
    const rows: TodayRow[] = [
      {
        key: "k",
        lane: "overdue",
        kind: "task",
        title: "t",
        tier: "admin",
        path: "p",
        action: "none",
        askIds: [],
        count: 1,
        overdueDays: 2,
      },
      {
        key: "k",
        lane: "overdue",
        kind: "task",
        title: "t",
        tier: "admin",
        path: "p",
        action: "none",
        askIds: [],
        count: 1,
        overdueDays: 9,
      },
    ];
    expect(collapseRows(rows)[0].overdueDays).toBe(9);
  });

  test("ask ids are unioned without duplicates", () => {
    const rows: TodayRow[] = [
      {
        key: "k",
        lane: "blocker",
        kind: "ask",
        title: "t",
        tier: "admin",
        path: "p",
        action: "resolve-ask",
        askIds: ["a"],
        count: 1,
      },
      {
        key: "k",
        lane: "blocker",
        kind: "ask",
        title: "t",
        tier: "admin",
        path: "p",
        action: "resolve-ask",
        askIds: ["a", "b"],
        count: 1,
      },
    ];
    expect(collapseRows(rows)[0].askIds).toEqual(["a", "b"]);
  });
});

describe("rankRows", () => {
  test("is stable for equal-weight rows so a refresh does not shuffle the list", () => {
    const mk = (title: string): TodayRow => ({
      key: title,
      lane: "due",
      kind: "task",
      title,
      tier: "admin",
      path: "p",
      action: "none",
      askIds: [],
      count: 1,
    });
    const rows = [mk("charlie"), mk("alpha"), mk("bravo")];
    expect(rankRows(rows).map((r) => r.title)).toEqual(["alpha", "bravo", "charlie"]);
    // Same input, same output — ranking must be a pure function of the rows.
    expect(rankRows(rows).map((r) => r.title)).toEqual(rankRows([...rows]).map((r) => r.title));
  });
});

describe("laneCounts", () => {
  test("counts collapsed items, not rows, and omits empty lanes", () => {
    const queue = buildTodayQueue(
      daily({
        attention: Array.from({ length: 3 }, (_, i) =>
          item({
            kind: "ask",
            summary: "same [blocker]",
            ref: { path: "a", row: `i${i}`, tier: "admin" },
          })
        ),
        owedToday: [item({ summary: "late", overdueDays: 4 })],
      })
    );
    expect(laneCounts(queue)).toEqual([
      { lane: "blocker", count: 3 },
      { lane: "overdue", count: 1 },
    ]);
  });
});

describe("askPromptFor", () => {
  test("carries the evidence ref so the agent opens the source instead of guessing", () => {
    const queue = buildTodayQueue(
      daily({
        owedToday: [
          item({
            summary: "Fix the bug",
            ref: { path: "3-log/tasks.md", row: "TT9", tier: "admin" },
          }),
        ],
      })
    );
    const prompt = askPromptFor(queue[0]);
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("3-log/tasks.md#TT9");
  });
});
