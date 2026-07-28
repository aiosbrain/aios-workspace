// @vitest-environment happy-dom
/**
 * Behaviour of the Operator Loop's Today console: what it fetches, what it renders for each
 * lane, and — the part that matters — that each row's action writes through the SAME surfaces
 * the terminal uses. Mounted for real (effects run) because every interesting state in this
 * component is reached through an effect or a click.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DailyItem, DailyOrientation } from "../../types/protocol";

const mocks = vi.hoisted(() => ({
  connection: { current: {} as Record<string, unknown> },
  session: { current: {} as Record<string, unknown> },
}));

vi.mock("../../state/cockpit", () => ({
  useConnection: () => mocks.connection.current,
  useSession: () => mocks.session.current,
}));

import { TodayView } from "./TodayView";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<TodayView />);
  });
}

function html() {
  return host?.innerHTML ?? "";
}

function rowByText(text: string): HTMLElement | null {
  return ([...(host?.querySelectorAll("li[data-today-key]") ?? [])].find((li) =>
    li.textContent?.includes(text)
  ) ?? null) as HTMLElement | null;
}

/** Click a button by its accessible name within a row. */
async function clickButton(row: HTMLElement, label: RegExp) {
  const btn = [...row.querySelectorAll("button")].find((b) =>
    label.test(b.getAttribute("aria-label") ?? "")
  );
  if (!btn) throw new Error(`no button matching ${label} in row`);
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

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

const askItem = (title: string, id: string) =>
  item({
    kind: "ask",
    summary: `${title} [blocker]`,
    ref: { path: ".aios/loop/asks/asks.ndjson", row: id, tier: "admin" },
  });

function api(data: DailyOrientation, overrides: Record<string, unknown> = {}) {
  const get = vi.fn().mockImplementation((path: string) => {
    if (path.startsWith("/api/asks/show")) {
      return Promise.resolve({
        id: "3fea973d",
        kind: "decision",
        severity: "blocker",
        title: "Reconnect WhatsApp",
        body: "Pair the device again so inbox ingestion resumes.",
        source: "cli",
        tier: "admin",
        createdAt: "2026-07-21T12:15:57.425Z",
        status: "open",
        resolvedAt: null,
      });
    }
    return Promise.resolve(data);
  });
  const post = vi.fn().mockResolvedValue({ ok: true });
  mocks.connection.current = { api: { get, post, ...overrides } };
  return { get, post };
}

beforeEach(() => {
  mocks.session.current = { askInNewChat: vi.fn() };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

describe("Today queue rendering", () => {
  test("fetches the C4 orientation and ranks blockers above overdue work", async () => {
    const { get } = api(
      daily({
        attention: [askItem("Reconnect WhatsApp", "3fea973d")],
        owedToday: [
          item({
            summary: "Fix the bug",
            overdueDays: 15,
            ref: { path: "3-log/tasks.md", row: "T19", tier: "admin" },
          }),
        ],
      })
    );
    await mount();

    expect(get).toHaveBeenCalledWith("/api/loop/daily");
    const keys = [...host!.querySelectorAll("li[data-today-key]")].map((li) =>
      li.getAttribute("data-today-key")
    );
    expect(keys[0]).toContain("blocker");
    expect(keys[1]).toContain("overdue");
    // Lateness is stated, not implied by a bucket heading.
    expect(html()).toContain("15d late");
  });

  test("states plainly when nothing is owed, rather than showing an empty list", async () => {
    api(daily());
    await mount();
    expect(html()).toContain("Nothing is waiting on you");
  });

  test("collapses identical rows into one with a count", async () => {
    api(
      daily({
        attention: Array.from({ length: 7 }, (_, i) =>
          askItem("Claude is waiting for your input", `id${i}`)
        ),
      })
    );
    await mount();
    expect(host!.querySelectorAll("li[data-today-key]")).toHaveLength(1);
    expect(html()).toContain("×7");
  });

  test("keeps the last-good queue and says so when a refresh fails", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(daily({ attention: [askItem("Reconnect WhatsApp", "3fea973d")] }))
      .mockRejectedValueOnce(new Error("network down"));
    mocks.connection.current = { api: { get, post: vi.fn() } };
    await mount();

    const refresh = [...host!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Refresh")
    )!;
    await act(async () => {
      refresh.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // An outage must not erase visible work.
    expect(html()).toContain("Reconnect WhatsApp");
    expect(html()).toContain("refresh failed");
  });
});

describe("Today row actions", () => {
  test("Resolve closes EVERY ask folded into the row, then reloads", async () => {
    const { get, post } = api(
      daily({
        attention: [
          askItem("Claude is waiting for your input", "id0"),
          askItem("Claude is waiting for your input", "id1"),
        ],
      })
    );
    await mount();
    await clickButton(rowByText("Claude is waiting")!, /^Resolve /);

    expect(post).toHaveBeenCalledWith("/api/asks/resolve", { ids: ["id0", "id1"] });
    // The queue is re-read so the row cannot linger after it was cleared.
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("Done patches the file the row actually came from", async () => {
    // Regression guard for "no task row with id 'T19'": a tier-split workspace holds rows in
    // BOTH tasks.md and tasks-team.md, so the edit must name the row's own file.
    const { post } = api(
      daily({
        owedToday: [
          item({
            summary: "Fix the bug",
            overdueDays: 15,
            ref: { path: "3-log/tasks.md", row: "T19", tier: "admin" },
          }),
        ],
      })
    );
    await mount();
    await clickButton(rowByText("Fix the bug")!, /^Mark /);

    expect(post).toHaveBeenCalledWith("/api/tasks/edit", {
      row_key: "T19",
      path: "3-log/tasks.md",
      patch: { status: "done" },
    });
  });

  test("Ask hands the row to a FRESH chat with its evidence ref", async () => {
    const askInNewChat = vi.fn();
    mocks.session.current = { askInNewChat };
    api(daily({ attention: [askItem("Reconnect WhatsApp", "3fea973d")] }));
    await mount();
    await clickButton(rowByText("Reconnect WhatsApp")!, /^Ask the agent/);

    expect(askInNewChat).toHaveBeenCalledTimes(1);
    const prompt = askInNewChat.mock.calls[0][0] as string;
    expect(prompt).toContain("Reconnect WhatsApp");
    expect(prompt).toContain(".aios/loop/asks/asks.ndjson#3fea973d");
  });

  test("a calendar event offers no write action — it is context, not work", async () => {
    api(
      daily({
        calendar: [item({ kind: "comms", summary: "Standup", ref: { path: "c", tier: "admin" } })],
      })
    );
    await mount();
    const row = rowByText("Standup")!;
    const labels = [...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels.some((l) => /^Resolve |^Mark /.test(l ?? ""))).toBe(false);
    expect(labels.some((l) => /^Ask the agent/.test(l ?? ""))).toBe(true);
  });
});

describe("Row detail", () => {
  test("expanding an ask shows its real body, not just the ndjson path", async () => {
    api(daily({ attention: [askItem("Reconnect WhatsApp", "3fea973d")] }));
    await mount();
    await clickButton(rowByText("Reconnect WhatsApp")!, /^Show details/);

    // The whole point of the detail pane: answer "what is this?" without an agent turn.
    expect(html()).toContain("Pair the device again so inbox ingestion resumes.");
    expect(html()).toContain("raised");
    // The evidence ref survives as the audit trail.
    expect(html()).toContain(".aios/loop/asks/asks.ndjson");
  });

  test("a failed detail fetch degrades to the evidence ref instead of blanking", async () => {
    const get = vi.fn().mockImplementation((path: string) => {
      if (path.startsWith("/api/asks/show")) return Promise.reject(new Error("gone"));
      return Promise.resolve(daily({ attention: [askItem("Reconnect WhatsApp", "3fea973d")] }));
    });
    mocks.connection.current = { api: { get, post: vi.fn() } };
    await mount();
    await clickButton(rowByText("Reconnect WhatsApp")!, /^Show details/);

    expect(html()).toContain("couldn");
    expect(html()).toContain(".aios/loop/asks/asks.ndjson");
  });
});
