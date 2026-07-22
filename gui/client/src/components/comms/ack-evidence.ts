import type { InboxDetail } from "./types";

/**
 * Pure human-evidence predicate; transport and browser event wiring stay in CommsView.
 *
 * An acknowledgment is the record that a HUMAN saw the ask — it is what clears the ask from
 * `aios inbox --overdue`, the only net that catches a silently-failed phone alert. So the bar is
 * an act of the operator's, never an act of the app's:
 *
 *   • `humanSelected` — the operator clicked or keyboard-selected THIS ask. The queue auto-selects
 *     `items[0]` on load and after the selection is dropped; that is the app choosing, not the
 *     human, and it must never satisfy this predicate. (Responding in the channel of origin is the
 *     other way an ask stops nagging, but it needs no ack: a replied ask leaves `open` status and
 *     `overdueView` skips every non-open ask — see recovery.ts.)
 *   • visible + focused — the panel was actually on screen and frontmost.
 *   • the committed detail payload says the lane delivered and no ack exists yet.
 */
export function shouldAcknowledgeDeliveredAsk({
  id,
  selectedId,
  humanSelected,
  detail,
  visibilityState,
  hasFocus,
}: {
  id: string;
  selectedId: string | null;
  humanSelected: boolean;
  detail: InboxDetail | null;
  visibilityState: DocumentVisibilityState;
  hasFocus: boolean;
}) {
  if (!humanSelected) return false;
  if (visibilityState !== "visible" || !hasFocus) return false;
  if (selectedId !== id || detail?.item?.id !== id) return false;
  // Only the detail payload that was actually committed to the visible panel is evidence.
  // Queue/list notify state may be newer, but a background poll must never substitute for this.
  const state = detail.notify?.states[id];
  return Boolean(state && state.delivery_attempts > 0 && !state.acked);
}
