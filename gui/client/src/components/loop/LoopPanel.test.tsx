// @vitest-environment happy-dom
/**
 * The Operator Loop panel's information architecture: Today is the ACT surface, and the
 * pipeline-stage views sit behind an Audit group that explains itself. The regression this
 * guards is the original complaint — "what difference between Daily and Collect?" — where two
 * views of the same signals at different pipeline stages were presented as peer tabs.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  connection: { current: {} as Record<string, unknown> },
  session: { current: {} as Record<string, unknown> },
}));

vi.mock("../../state/cockpit", () => ({
  useConnection: () => mocks.connection.current,
  useSession: () => mocks.session.current,
}));

import { LoopPanel } from "./LoopPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<LoopPanel />);
  });
}

function tab(label: string): HTMLButtonElement {
  const btn = [...host!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`no tab labelled ${label}`);
  return btn as HTMLButtonElement;
}

async function clickTab(label: string) {
  await act(async () => {
    tab(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.connection.current = {
    api: { get: vi.fn().mockRejectedValue(new Error("offline")), post: vi.fn() },
  };
  mocks.session.current = { askInNewChat: vi.fn() };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

describe("LoopPanel information architecture", () => {
  test("opens on Today, the act surface — not on an audit view", async () => {
    await mount();
    expect(tab("Today").getAttribute("aria-current")).toBe("page");
  });

  test("separates the act surface from a labelled Audit group", async () => {
    await mount();
    const text = host!.textContent ?? "";
    expect(text).toContain("Audit");
    // "Collect" was renamed: it shows raw C1 signals, it is not a second to-do list.
    expect(text).toContain("Signals");
    expect(text).not.toContain("Collect");
    expect(host!.querySelector('[role="separator"]')).toBeTruthy();
  });

  test("Today carries no hint; every audit tab explains what it is", async () => {
    await mount();
    // Today needs no gloss — it is the thing you act on.
    expect(host!.textContent).not.toContain("C1 —");

    for (const [label, marker] of [
      ["Signals", "C1 —"],
      ["Weekly closeout", "C5 —"],
      ["Telemetry", "C8 —"],
    ] as const) {
      await clickTab(label);
      expect(tab(label).getAttribute("aria-current")).toBe("page");
      expect(host!.textContent).toContain(marker);
    }
  });

  test("switching back to Today drops the audit hint again", async () => {
    await mount();
    await clickTab("Telemetry");
    expect(host!.textContent).toContain("C8 —");
    await clickTab("Today");
    expect(host!.textContent).not.toContain("C8 —");
    expect(tab("Today").getAttribute("aria-current")).toBe("page");
  });
});
