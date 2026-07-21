import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { TaskRow } from "../../types/protocol";
import {
  groupTasksForBoard,
  readTaskViewPreference,
  TaskBoard,
  TaskGrid,
  TaskList,
  TASK_VIEW_STORAGE_KEY,
  taskViewStorage,
  writeTaskViewPreference,
} from "./TaskViews";

const rows: TaskRow[] = [
  {
    row_key: "AIO-1",
    title: "Ship the list view",
    assignee: "Ada",
    status: "in_progress",
    sprint: "S1",
    due: "2026-07-29",
    priority: "high",
    labels: ["gui"],
    pm_provider: "linear",
    pm_url: "https://linear.app/example/issue/AIO-1",
  },
  {
    row_key: "AIO-2",
    title: "Preserve an unknown state",
    assignee: "",
    status: "waiting_external",
    sprint: "",
    due: null,
    priority: null,
    labels: [],
    pm_url: "javascript:alert(1)",
  },
];

const noop = () => {};

describe("task presentation modes", () => {
  test("every task appears exactly once in list, grid, and board", () => {
    const views = [
      renderToStaticMarkup(<TaskList rows={rows} saving={null} onSave={noop} />),
      renderToStaticMarkup(<TaskGrid rows={rows} saving={null} onSave={noop} />),
      renderToStaticMarkup(<TaskBoard rows={rows} saving={null} onSave={noop} />),
    ];

    for (const html of views) {
      for (const row of rows) {
        expect((html.match(new RegExp(`data-task-id="${row.row_key}"`, "g")) ?? []).length).toBe(1);
      }
      expect(html).toContain("Status for Ship the list view");
    }
  });

  test("unknown statuses remain visible in an Other lane and can be changed by keyboard", () => {
    const lanes = groupTasksForBoard(rows);
    expect(lanes.find((lane) => lane.key === "other")?.rows.map((row) => row.row_key)).toEqual([
      "AIO-2",
    ]);
    expect(lanes.flatMap((lane) => lane.rows)).toHaveLength(rows.length);

    const html = renderToStaticMarkup(<TaskBoard rows={rows} saving={null} onSave={noop} />);
    expect(html).toContain("Other");
    expect(html).toContain('value="waiting_external" selected=""');
    expect(html).toContain('value="backlog"');
  });

  test("only emits project-manager links that are safe external URLs", () => {
    const html = renderToStaticMarkup(<TaskGrid rows={rows} saving={null} onSave={noop} />);
    expect(html).toContain("https://linear.app/example/issue/AIO-1");
    expect(html).not.toContain("javascript:alert");
  });
});

describe("task view preference", () => {
  test("accepts only known modes and survives unavailable storage", () => {
    expect(taskViewStorage()).toBeNull();
    expect(readTaskViewPreference({ getItem: () => "board" })).toBe("board");
    expect(readTaskViewPreference({ getItem: () => "spreadsheet" })).toBe("list");
    expect(
      readTaskViewPreference({
        getItem: () => {
          throw new Error("blocked");
        },
      })
    ).toBe("list");
  });

  test("stores the chosen view under the scoped key", () => {
    const values = new Map<string, string>();
    writeTaskViewPreference("grid", { setItem: (key, value) => values.set(key, value) });
    expect(values.get(TASK_VIEW_STORAGE_KEY)).toBe("grid");
  });
});
