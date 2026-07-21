import type { postReplyCheck } from "./api";
import type { InboxDetail, ReplyConfirmationSnapshot } from "./types";

export function retainLastGood<T>(
  current: T | null,
  outcome: { ok: true; value: T } | { ok: false }
): T | null {
  return outcome.ok ? outcome.value : current;
}

export function gmailThreadRef(detail: InboxDetail | null): string | null {
  const item = detail?.item;
  const threadId = item?.origin === "thread-state" ? item.observation?.thread_id : null;
  return typeof threadId === "string" && threadId ? `gmail:${threadId}` : null;
}

export function immutableReplySnapshot(
  itemId: string,
  body: string,
  checked: Extract<Awaited<ReturnType<typeof postReplyCheck>>, { ok: true }>
): ReplyConfirmationSnapshot {
  const preview = Object.freeze({ ...checked.preview, to: Object.freeze([...checked.preview.to]) });
  return Object.freeze({
    itemId,
    body,
    command_id: checked.command_id,
    digest: checked.digest,
    preview,
  });
}
