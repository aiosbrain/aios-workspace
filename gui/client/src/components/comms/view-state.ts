import type { postReplyCheck } from "./api";
import type { InboxDetail, ReplyConfirmationSnapshot } from "./types";

interface ReplyReviewRequest {
  itemId: string;
  threadRef: string;
  channel: string;
  generation: number;
}

/** Prevent an async reply check from reopening confirmation after selection/channel has changed. */
export class LatestReplyReview {
  private channel: string;
  private generation = 0;

  constructor(channel: string) {
    this.channel = channel;
  }

  selectChannel(channel: string) {
    if (channel === this.channel) return;
    this.channel = channel;
    this.generation++;
  }

  invalidate() {
    this.generation++;
  }

  begin(itemId: string, threadRef: string): ReplyReviewRequest {
    return { itemId, threadRef, channel: this.channel, generation: ++this.generation };
  }

  accepts(request: ReplyReviewRequest, itemId: string | null, threadRef: string | null): boolean {
    return (
      request.generation === this.generation &&
      request.channel === this.channel &&
      request.itemId === itemId &&
      request.threadRef === threadRef
    );
  }
}

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
