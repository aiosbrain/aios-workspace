import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  connection: { current: {} as Record<string, unknown> },
  session: { current: {} as Record<string, unknown> },
}));

vi.mock("../../state/cockpit", () => ({
  useConnection: () => mocks.connection.current,
  useSession: () => mocks.session.current,
}));

import { Sidebar, shouldDisableNewChat } from "./Sidebar";

function session(view: string) {
  return {
    view,
    setView: vi.fn(),
    connected: false,
    connectionStatus: "draft",
    chats: [],
    currentSession: null,
    openChat: vi.fn(),
    newChat: vi.fn(),
    input: "",
    busy: false,
    messages: [],
    retryConnection: vi.fn(),
  };
}

beforeEach(() => {
  mocks.connection.current = { repo: "/tmp/example-workspace" };
  mocks.session.current = session("chat");
});

describe("Sidebar information architecture", () => {
  test("keeps Comms and Build navigation ahead of contextual chat actions", () => {
    const html = renderToStaticMarkup(<Sidebar />);

    const comms = html.indexOf("Comms");
    const inbox = html.indexOf("Inbox");
    const build = html.indexOf("Build");
    const chat = html.indexOf("Chat");
    const newChat = html.indexOf("New chat");

    expect(comms).toBeGreaterThan(-1);
    expect(comms).toBeLessThan(inbox);
    expect(inbox).toBeLessThan(build);
    expect(build).toBeLessThan(chat);
    expect(chat).toBeLessThan(newChat);
    expect(html).toContain('aria-label="Workspace"');
  });

  test("exposes an explicit Chat destination under Build", () => {
    const html = renderToStaticMarkup(<Sidebar />);
    expect(html).toContain("Build");
    expect(html).toContain("Chat");
    expect(html).toContain("Tasks");
    expect(html).toContain("Operator Loop");
    expect(html).toContain("Team Brain Sync");
    expect(html).not.toContain("Review &amp; Push");
  });
});

describe("New chat reachability", () => {
  test.each(["comms", "tasks", "maturity", "cost", "loop", "review", "settings"])(
    "remains enabled from the %s view",
    (view) => {
      expect(shouldDisableNewChat(view, true)).toBe(false);
      mocks.session.current = session(view);
      const html = renderToStaticMarkup(<Sidebar />);
      const label = html.indexOf("New chat");
      const buttonStart = html.lastIndexOf("<button", label);
      const buttonEnd = html.indexOf(">", buttonStart);
      expect(label).toBeGreaterThan(-1);
      expect(html.slice(buttonStart, buttonEnd)).not.toMatch(/\sdisabled(?:=|>)/);
    }
  );

  test("only disables the redundant action on an already-empty Chat draft", () => {
    expect(shouldDisableNewChat("chat", true)).toBe(true);
    expect(shouldDisableNewChat("chat", false)).toBe(false);
  });
});
