import { describe, it, expect } from "vitest";
import { buildMessagesFromEvents } from "./transcript";
import type { TranscriptEvent } from "../types/protocol";
import type { MemoryMessage, MetaMessage } from "../types/messages";

/**
 * The transcript reducer is the replay contract: a reopened chat must reconstruct the full
 * record. Live sessions route memory/warning/error to toasts, so these cases must survive
 * round-tripping through the stored transcript. (Phase 4, AIO-116.)
 */
describe("buildMessagesFromEvents", () => {
  it("reconstructs a memory card from memory_updated", () => {
    const events: TranscriptEvent[] = [
      { type: "echo_user", text: "remember my name" },
      { type: "memory_updated", id: "m1", file: "USER.md", count: 1, summary: "added name" },
    ];
    const msgs = buildMessagesFromEvents(events);
    expect(msgs.map((m) => m.kind)).toEqual(["user", "memory"]);
    const mem = msgs[1] as MemoryMessage;
    expect(mem).toMatchObject({ kind: "memory", id: "m1", file: "USER.md", summary: "added name" });
    expect(mem.undone).toBeUndefined();
    expect(mem.undoFailed).toBeUndefined();
  });

  it("applies memory_undone ok=true to the matching card", () => {
    const events: TranscriptEvent[] = [
      { type: "memory_updated", id: "m1", file: "USER.md", count: 1, summary: "added name" },
      { type: "memory_undone", id: "m1", ok: true },
    ];
    const [mem] = buildMessagesFromEvents(events) as MemoryMessage[];
    expect(mem.undone).toBe(true);
    expect(mem.undoFailed).toBe(false);
  });

  it("applies memory_undone ok=false as undoFailed", () => {
    const events: TranscriptEvent[] = [
      { type: "memory_updated", id: "m2", file: "WORKSPACE.md", count: 1, summary: "tooling" },
      { type: "memory_undone", id: "m2", ok: false },
    ];
    const [mem] = buildMessagesFromEvents(events) as MemoryMessage[];
    expect(mem.undone).toBe(false);
    expect(mem.undoFailed).toBe(true);
  });

  it("only updates the memory card whose id matches", () => {
    const events: TranscriptEvent[] = [
      { type: "memory_updated", id: "a", file: "USER.md", count: 1, summary: "one" },
      { type: "memory_updated", id: "b", file: "USER.md", count: 1, summary: "two" },
      { type: "memory_undone", id: "b", ok: true },
    ];
    const msgs = buildMessagesFromEvents(events) as MemoryMessage[];
    expect(msgs[0].undone).toBeUndefined();
    expect(msgs[1].undone).toBe(true);
  });

  it("reconstructs warning and error as inline meta", () => {
    const events: TranscriptEvent[] = [
      { type: "warning", message: "model fell back" },
      { type: "error", message: "boom" },
    ];
    const msgs = buildMessagesFromEvents(events) as MetaMessage[];
    expect(msgs.map((m) => m.text)).toEqual(["⚠ model fell back", "error: boom"]);
  });

  it("ignores approval_mode (no message, no throw)", () => {
    const events: TranscriptEvent[] = [
      { type: "echo_user", text: "hi" },
      { type: "approval_mode", mode: "acceptEdits" },
      { type: "delta", text: "ok" },
      { type: "assistant_done" },
    ];
    const msgs = buildMessagesFromEvents(events);
    expect(msgs.map((m) => m.kind)).toEqual(["user", "assistant"]);
    expect((msgs[1] as { streaming?: boolean }).streaming).toBe(false);
  });

  it("folds a full turn: user → assistant stream → result meta", () => {
    const events: TranscriptEvent[] = [
      { type: "echo_user", text: "go" },
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "assistant_done" },
      { type: "usage", usage: { input_tokens: 10, output_tokens: 5 } },
      { type: "result", cost_usd: 0.01 },
    ];
    const msgs = buildMessagesFromEvents(events);
    expect(msgs.map((m) => m.kind)).toEqual(["user", "assistant", "meta"]);
    expect((msgs[1] as { text: string }).text).toBe("Hello");
  });
});
