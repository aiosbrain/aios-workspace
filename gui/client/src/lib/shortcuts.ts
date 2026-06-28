import { useEffect, useRef } from "react";

/**
 * Global keyboard shortcuts. The decision logic is a pure function (resolveShortcut) so it
 * can be unit-tested without a DOM; useGlobalShortcuts wires one document listener to it.
 *
 * Robustness rules (per AIO-116):
 *  - ignore key auto-repeat (held key) and IME composition
 *  - only Cmd/Ctrl-modified shortcuts (⌘K, ⌘N) are global — they fire even from a text
 *    field. Bare-key shortcuts (none today) would be suppressed inside editable targets;
 *    Esc is left to the overlays (cmdk dialog) themselves.
 */
export type ShortcutAction = "palette" | "newChat" | null;

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  repeat: boolean;
  isComposing: boolean;
}

export function resolveShortcut(e: ShortcutKeyEvent): ShortcutAction {
  if (e.repeat || e.isComposing) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null; // only command-modified shortcuts are global
  switch (e.key.toLowerCase()) {
    case "k":
      return "palette";
    case "n":
      return "newChat";
    default:
      return null;
  }
}

/** True on macOS-family platforms — picks the modifier glyph shown in shortcut hints. */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

/** The platform modifier label: "⌘" on macOS, "Ctrl" elsewhere. */
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

/**
 * Display label for a global shortcut, derived from the same key letters
 * resolveShortcut() matches — so the UI hint can't drift from the actual binding
 * across macOS/Windows/Linux.
 */
export function shortcutLabel(action: Exclude<ShortcutAction, null>): string {
  const key = action === "palette" ? "K" : "N";
  return IS_MAC ? `${MOD_LABEL}${key}` : `${MOD_LABEL}+${key}`;
}

/** Whether an event target is a text-entry surface (input/textarea/select/contenteditable). */
export function isEditableTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null | undefined
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export interface ShortcutHandlers {
  onPalette?: () => void;
  onNewChat?: () => void;
}

export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  // Keep latest handlers in a ref so we subscribe once and never go stale.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveShortcut(e);
      if (!action) return;
      // (Command-modified shortcuts are intentionally allowed from text fields. A future
      // bare-key shortcut would bail here via isEditableTarget(e.target).)
      if (action === "palette") {
        e.preventDefault(); // don't let the browser open its find bar
        ref.current.onPalette?.();
      } else if (action === "newChat") {
        e.preventDefault();
        ref.current.onNewChat?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
