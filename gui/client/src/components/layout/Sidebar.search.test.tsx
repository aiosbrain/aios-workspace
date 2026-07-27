// @vitest-environment happy-dom
/**
 * The unified sidebar search: debounced full-content hits from the server (the
 * same engine as the command palette), instant title-filter fallback while the
 * fetch is in flight, and immediate invalidation of stale hits on every query
 * change — the list must never show results for an older query.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as CockpitStateModule from "../../state/cockpit";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/* Scripted network (the CockpitProvider owns the real hook underneath). */
class IdleWebSocket {
  static OPEN = 1;
  onopen: (() => void) | null = null;
  send() {}
  close() {}
}

let searchCalls: string[] = [];
let searchResults: { id: string; title: string; snippet: string }[] = [];

function installFetch() {
  vi.stubGlobal("fetch", (input: string | URL) => {
    const url = String(input);
    const path = url.replace(/^[a-z]+:\/\/[^/]+/, "").split("?")[0];
    const q = new URL(url, "http://localhost").searchParams.get("q");
    let body: unknown = {};
    if (path === "/api/sessions") {
      body = {
        sessions: [
          { id: "s1", title: "Deploy notes", createdAt: "", updatedAt: "" },
          { id: "s2", title: "Weekly synthesis", createdAt: "", updatedAt: "" },
        ],
        lastSelected: null,
      };
    } else if (path === "/api/sessions/search") {
      searchCalls.push(q ?? "");
      body = { results: searchResults };
    }
    return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => body });
  });
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", IdleWebSocket);
  searchCalls = [];
  searchResults = [];
  installFetch();
});

async function mountSidebar() {
  sessionStorage.setItem("aios.gui.token", "test-token");
  vi.resetModules();
  const { CockpitProvider } = (await import("../../state/cockpit")) as typeof CockpitStateModule;
  const { Sidebar } = await import("./Sidebar");
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <CockpitProvider>
        <Sidebar />
      </CockpitProvider>
    );
    await vi.advanceTimersByTimeAsync(0);
  });
}

function setQuery(value: string) {
  const input = host!.querySelector<HTMLInputElement>('input[placeholder="Search chats"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("sidebar unified search", () => {
  test("debounces to the server engine and renders full-content hits with snippets", async () => {
    await mountSidebar();
    expect(host!.textContent).toContain("Deploy notes");

    searchResults = [{ id: "s2", title: "Weekly synthesis", snippet: "…the deploy window…" }];
    await act(async () => {
      setQuery("deploy window");
    });
    // instant fallback: title filter only (no title matches "deploy window" fully → both filtered out except title matches)
    expect(searchCalls).toEqual([]); // not yet — debounce pending
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(searchCalls).toEqual(["deploy window"]);
    expect(host!.textContent).toContain("…the deploy window…"); // snippet from the server hit
  });

  test("changing the query invalidates prior hits immediately (no stale results)", async () => {
    await mountSidebar();
    searchResults = [{ id: "s1", title: "Deploy notes", snippet: "old-query snippet" }];
    await act(async () => {
      setQuery("deploy");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(host!.textContent).toContain("old-query snippet");

    // new query: the old server hits must vanish NOW, before the new fetch lands
    await act(async () => {
      setQuery("weekly");
    });
    expect(host!.textContent).not.toContain("old-query snippet");
    expect(host!.textContent).toContain("Weekly synthesis"); // instant title-filter fallback

    // clearing the query restores the recency groups without a fetch
    const calls = searchCalls.length;
    await act(async () => {
      setQuery("");
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(searchCalls.length).toBe(calls);
    expect(host!.textContent).toContain("Deploy notes");
  });
});
