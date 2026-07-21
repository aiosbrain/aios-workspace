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
    commsChannel: "all",
    setCommsChannel: vi.fn(),
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

  test("nests chat actions and history directly beneath the Chat destination", () => {
    mocks.session.current = {
      ...session("chat"),
      chats: [{ id: "chat-1", title: "Nested history", updated_at: "2026-07-21T10:00:00Z" }],
    };
    const html = renderToStaticMarkup(<Sidebar />);
    const buildStart = html.indexOf('id="sidebar-build"');
    const chatSection = html.indexOf('data-testid="sidebar-chat-section"');
    const tasks = html.indexOf("Tasks", chatSection);

    expect(buildStart).toBeGreaterThan(-1);
    expect(chatSection).toBeGreaterThan(buildStart);
    expect(html.indexOf("New chat", chatSection)).toBeGreaterThan(chatSection);
    expect(html.indexOf("Search chats", chatSection)).toBeGreaterThan(chatSection);
    expect(html.indexOf("Nested history", chatSection)).toBeGreaterThan(chatSection);
    expect(tasks).toBeGreaterThan(chatSection);
    expect(html).toContain('aria-controls="sidebar-chat-section"');
    expect(html).toContain('aria-label="Collapse Chat"');
    expect(html).toContain("max-h-[34vh]");
  });

  test("exposes Comms, Build, and Chat as expandable section controls", () => {
    const html = renderToStaticMarkup(<Sidebar />);
    expect(html).toContain('aria-controls="sidebar-comms"');
    expect(html).toContain('aria-controls="sidebar-build"');
    expect(html).toContain('aria-controls="sidebar-chat-section"');
    expect((html.match(/aria-expanded="true"/g) ?? []).length).toBe(3);
    expect(html).toContain("Inbox (all)");
    expect(html).toContain("Claude");
    expect(html).toContain("Gmail");
    expect(html).toContain("Slack");
    expect(html).toContain("Telegram");
    expect(html).toContain("WhatsApp");
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
