import type { InboxDetail } from "./types";

/** Pure human-evidence predicate; transport and browser event wiring stay in CommsView. */
export function shouldAcknowledgeDeliveredAsk({
  id,
  selectedId,
  detail,
  visibilityState,
  hasFocus,
}: {
  id: string;
  selectedId: string | null;
  detail: InboxDetail | null;
  visibilityState: DocumentVisibilityState;
  hasFocus: boolean;
}) {
  if (visibilityState !== "visible" || !hasFocus) return false;
  if (selectedId !== id || detail?.item?.id !== id) return false;
  // Only the detail payload that was actually committed to the visible panel is evidence.
  // Queue/list notify state may be newer, but a background poll must never substitute for this.
  const state = detail.notify?.states[id];
  return Boolean(state && state.delivery_attempts > 0 && !state.acked);
}
