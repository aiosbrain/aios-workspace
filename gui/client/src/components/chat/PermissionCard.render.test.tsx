// @vitest-environment happy-dom
/**
 * Interactive behaviour of the approval card: the live auto-deny countdown, the
 * hard stop at the server deadline (expired cards disable their buttons and say
 * "auto-denied" — a late click must never look like an approval), and the
 * option-style runtimes' custom buttons.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PermissionCard } from "./PermissionCard";
import type { PendingPermission } from "../../types/messages";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const basePermission = (overrides: Partial<PendingPermission> = {}): PendingPermission => ({
  id: 7,
  tool: "Bash",
  input: { command: "ls" },
  timeoutMs: 5_000,
  receivedAt: Date.now(),
  ...overrides,
});

describe("PermissionCard deadlines", () => {
  test("counts down, then expires: onExpired fires, buttons disable, label reads auto-denied", () => {
    const onRespond = vi.fn();
    const onExpired = vi.fn();
    mount(
      <PermissionCard
        permission={basePermission()}
        onRespond={onRespond}
        onRespondOption={vi.fn()}
        onExpired={onExpired}
      />
    );
    expect(host!.textContent).toContain("auto-denies in 0:05");

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(host!.textContent).toContain("auto-denies in 0:03");
    expect(onExpired).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(onExpired).toHaveBeenCalledWith(7);
    expect(host!.textContent).toContain("auto-denied");
    const buttons = [...host!.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.disabled).toBe(true);
    // a late click is a no-op — the server already denied this request
    buttons[0].click();
    expect(onRespond).not.toHaveBeenCalled();
  });

  test("no server deadline → no countdown, buttons stay live and respond", () => {
    const onRespond = vi.fn();
    mount(
      <PermissionCard
        permission={basePermission({ timeoutMs: undefined, receivedAt: undefined })}
        onRespond={onRespond}
        onRespondOption={vi.fn()}
      />
    );
    expect(host!.textContent).not.toContain("auto-denies");
    const [allow, deny] = [...host!.querySelectorAll("button")];
    act(() => allow.click());
    expect(onRespond).toHaveBeenCalledWith(7, true);
    act(() => deny.click());
    expect(onRespond).toHaveBeenCalledWith(7, false);
  });

  test("option-style runtimes render their own choices and pass the optionId through", () => {
    const onRespondOption = vi.fn();
    mount(
      <PermissionCard
        permission={basePermission({
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        })}
        onRespond={vi.fn()}
        onRespondOption={onRespondOption}
      />
    );
    const buttons = [...host!.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Allow once", "Reject"]);
    act(() => buttons[1].click());
    expect(onRespondOption).toHaveBeenCalledWith(7, "reject");
  });
});
