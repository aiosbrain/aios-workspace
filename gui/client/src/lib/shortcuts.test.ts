import { describe, it, expect } from "vitest";
import { resolveShortcut, isEditableTarget } from "./shortcuts";

const base = { key: "k", metaKey: false, ctrlKey: false, repeat: false, isComposing: false };

describe("resolveShortcut", () => {
  it("maps Cmd/Ctrl+K to palette", () => {
    expect(resolveShortcut({ ...base, key: "k", metaKey: true })).toBe("palette");
    expect(resolveShortcut({ ...base, key: "K", ctrlKey: true })).toBe("palette");
  });

  it("maps Cmd/Ctrl+N to newChat", () => {
    expect(resolveShortcut({ ...base, key: "n", metaKey: true })).toBe("newChat");
  });

  it("requires a modifier (bare keys are not global)", () => {
    expect(resolveShortcut({ ...base, key: "k" })).toBeNull();
    expect(resolveShortcut({ ...base, key: "n" })).toBeNull();
  });

  it("ignores auto-repeat and IME composition", () => {
    expect(resolveShortcut({ ...base, key: "k", metaKey: true, repeat: true })).toBeNull();
    expect(resolveShortcut({ ...base, key: "k", metaKey: true, isComposing: true })).toBeNull();
  });

  it("ignores unrelated modified keys", () => {
    expect(resolveShortcut({ ...base, key: "a", metaKey: true })).toBeNull();
  });
});

describe("isEditableTarget", () => {
  it("detects text-entry surfaces", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("returns false for non-editable / missing targets", () => {
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});
