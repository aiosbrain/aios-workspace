// @vitest-environment happy-dom
/**
 * Behavioural tests for the master cockpit hook, driven through a real React root
 * (happy-dom) with a scripted WebSocket + fetch. These exercise the UX-audit
 * lifecycle work: connect/hello, the stall watchdog (armed on send, cleared on
 * events, close, and chat switch), the 4001 takeover → superseded state, reconnect
 * backoff → offline + stale-link probe, and the small session actions.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as CockpitModule from "./useCockpit";

type CockpitState = CockpitModule.CockpitState;

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/* ---- scripted WebSocket ---- */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
  /* test drivers */
  serverOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  serverEvent(ev: unknown) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
  serverClose(code: number) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

/* ---- scripted fetch ---- */
const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => body,
});
const errJson = (status: number) => ({
  ok: false,
  status,
  statusText: "nope",
  json: async () => ({ error: "nope" }),
});

let routes: Record<string, () => unknown>;
function installFetch() {
  vi.stubGlobal("fetch", (input: string | URL) => {
    const url = String(input);
    const path = url.replace(/^[a-z]+:\/\/[^/]+/, "").split("?")[0];
    const route = routes[path];
    if (!route) return Promise.resolve(okJson({}));
    const body = route();
    if (body instanceof Error) return Promise.reject(body);
    if (typeof body === "object" && body !== null && "ok" in (body as object)) {
      return Promise.resolve(body);
    }
    return Promise.resolve(okJson(body));
  });
}

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: CockpitState | null = null;

async function mountHook(): Promise<() => CockpitState> {
  sessionStorage.setItem("aios.gui.token", "test-token");
  vi.resetModules();
  const mod = (await import("./useCockpit")) as typeof CockpitModule;
  function Probe() {
    latest = mod.useCockpit();
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Probe />);
  });
  await flush();
  return () => latest!;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  routes = {
    "/api/me": () => ({ me: { role: "owner" } }),
    "/api/info": () => ({ repo: "/tmp/acme-workspace" }),
    "/api/config": () => ({ model: "m-default", runtime: "claude" }),
    "/api/sessions": () => ({
      sessions: [{ id: "s1", title: "First chat", createdAt: "", updatedAt: "" }],
      lastSelected: null,
    }),
    "/api/sessions/s1": () => ({
      events: [
        { type: "usage", usage: { input_tokens: 10, output_tokens: 2 } },
        { type: "result", cost_usd: 0.5 },
        { type: "usage", scope: "session", usage: { input_tokens: 12, output_tokens: 3 } },
      ],
    }),
  };
  installFetch();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  latest = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("useCockpit session lifecycle", () => {
  test("open chat → connected; stall watchdog fires on a silent run and is cleared by events", async () => {
    const state = await mountHook();

    await act(async () => {
      state().openChat("s1");
      await vi.advanceTimersByTimeAsync(0);
    });
    const ws = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      ws.serverOpen();
    });
    expect(state().connectionStatus).toBe("connected");
    expect(state().currentSession).toBe("s1");
    // replay seeded usage/cost from the stored transcript
    expect(state().sessionUsage).toEqual({ input_tokens: 12, output_tokens: 3 });

    await act(async () => {
      ws.serverEvent({ type: "hello", repo: "/tmp/acme-workspace", runtime: "claude", cost_usd: 1 });
      await vi.advanceTimersByTimeAsync(0);
    });

    // send with no reply → the 30s watchdog reports the silence
    await act(async () => {
      state().sendMessage("hi there");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ws.sent.some((s) => JSON.parse(s).type === "user_message")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(state().messages.some((m) => m.kind === "meta" && m.text.includes("still waiting"))).toBe(
      true
    );

    // a live server event clears the (re-armed) watchdog instead of double-reporting
    await act(async () => {
      state().sendMessage("again");
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      ws.serverEvent({ type: "error", message: "boom" });
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const stallCount = state().messages.filter(
      (m) => m.kind === "meta" && m.text.includes("still waiting")
    ).length;
    expect(stallCount).toBe(1); // the second send's watchdog was cleared by the error event
    expect(state().messages.some((m) => m.kind === "meta" && m.text === "error: boom")).toBe(true);
    expect(state().busy).toBe(false);
  });

  test("4001 close → superseded (no auto-reconnect); retryConnection takes the session back", async () => {
    const state = await mountHook();
    await act(async () => {
      state().openChat("s1");
      await vi.advanceTimersByTimeAsync(0);
    });
    const ws = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      ws.serverOpen();
    });

    await act(async () => {
      ws.serverClose(4001);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(state().connectionStatus).toBe("superseded");
    expect(state().busy).toBe(false);
    // superseded parks — no reconnect socket may appear on its own
    const count = FakeWebSocket.instances.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances.length).toBe(count);

    await act(async () => {
      state().retryConnection();
      await vi.advanceTimersByTimeAsync(0);
    });
    const ws2 = FakeWebSocket.instances.at(-1)!;
    expect(ws2).not.toBe(ws);
    await act(async () => {
      ws2.serverOpen();
    });
    expect(state().connectionStatus).toBe("connected");
  });

  test("repeated drops back off to offline, and the stale-link probe flags a 401", async () => {
    const state = await mountHook();
    await act(async () => {
      state().openChat("s1");
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      FakeWebSocket.instances.at(-1)!.serverOpen();
    });

    // once offline is reached, the probe hits /api/me — make it a stale-token 401
    routes["/api/me"] = () => errJson(401);

    // drop + let each backoff retry spawn a socket, then drop that one too
    for (let i = 0; i < 8 && state().connectionStatus !== "offline"; i++) {
      const sockets = FakeWebSocket.instances.length;
      await act(async () => {
        FakeWebSocket.instances.at(-1)!.serverClose(1006);
        await vi.advanceTimersByTimeAsync(11_000); // > backoff cap + jitter
      });
      if (FakeWebSocket.instances.length === sockets) break; // no retry scheduled → terminal
    }
    expect(state().connectionStatus).toBe("offline");
    await flush(); // let the /api/me probe settle
  });

  test("newChat resets to a fresh draft; changeModel rolls back when the server rejects", async () => {
    const state = await mountHook();
    await act(async () => {
      state().openChat("s1");
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      FakeWebSocket.instances.at(-1)!.serverOpen();
    });

    await act(async () => {
      state().newChat();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(state().currentSession).toBeNull();
    expect(state().connectionStatus).toBe("draft");
    expect(state().messages).toEqual([]);

    const before = state().model;
    routes["/api/config/model"] = () => errJson(500);
    await act(async () => {
      state().changeModel("m-else");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(state().model).toBe(before); // rejected switch must not lie

    // the small session actions run against the live socket without throwing
    await act(async () => {
      state().respondPermission(1, true);
      state().respondPermissionOption(2, "allow-once");
      state().expirePermission(3); // no such pending card → silent no-op
      state().undoMemory("mem-1");
    });
    expect(state().permissions).toEqual([]);
  });
});
