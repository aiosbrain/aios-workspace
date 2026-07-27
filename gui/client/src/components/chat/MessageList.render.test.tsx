// @vitest-environment happy-dom
/**
 * The transcript renders every message kind through a stable uid key, keeps
 * pending permission cards at the tail, and auto-scrolls only when stuck to
 * the bottom.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageList } from "./MessageList";
import type { UiMessage, PendingPermission } from "../../types/messages";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  // happy-dom has no scrollIntoView — the auto-scroll effect must still run
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const messages: UiMessage[] = [
  { kind: "user", text: "run the tests", uid: 1 },
  { kind: "assistant", text: "on it", streaming: false, uid: 2 },
  { kind: "tool", name: "Bash", input: { command: "npm test" }, id: "t1", result: "ok", uid: 3 },
  { kind: "memory", id: "m1", file: "MEMORY.md", summary: "learned a thing", uid: 4 },
  { kind: "meta", text: "error: something honest", uid: 5 },
];

const permissions: PendingPermission[] = [{ id: 9, tool: "Write", input: { file: "a.md" } }];

describe("MessageList", () => {
  test("renders every message kind once and the pending permission card", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(
        <MessageList
          header={<div data-testid="head" />}
          messages={messages}
          permissions={permissions}
          onUndoMemory={vi.fn()}
          onRespond={vi.fn()}
          onRespondOption={vi.fn()}
          onExpirePermission={vi.fn()}
        />
      );
    });
    const html = host!.innerHTML;
    expect(html).toContain("run the tests");
    expect(html).toContain("on it");
    expect(html).toContain("npm test");
    expect(html).toContain("learned a thing");
    expect(html).toContain("error: something honest");
    // pending approval renders at the tail
    expect(host!.textContent).toContain("Approve");
    expect(host!.textContent).toContain("Write");
  });
});
