/**
 * CommsDetail (I-14 / AIO-395) — the detail pane, right half of the split-screen. Renders the selected
 * item's thread/ask detail in a quiet reading layout, plus pending I-03 capability approvals.
 */

import { useEffect, useState } from "react";
import { Archive, Bot, ExternalLink, Mail, Send, ShieldAlert } from "lucide-react";
import type { DisplayProjection, InboxDetail, OutboxCommand } from "./types";
import { itemLabel, ageLabel } from "./presenters";
import { ReplyComposer } from "./ReplyComposer";
import { SendStatusStrip } from "./SendStatusStrip";
import { SentSection } from "./SentSection";

export interface CommsDetailProps {
  detail: InboxDetail | null;
  onScopedConfirm: (projection: DisplayProjection) => void;
  onReply: (id: string, message: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  outboxCommand?: OutboxCommand | null;
  sentCommands?: OutboxCommand[];
  replyResetKey?: number;
  recoveryExhausted?: boolean;
  replyRecoveryError?: string | null;
  onReviewReply?: (id: string, body: string) => Promise<void>;
  onTryReplyAgain?: () => void;
}

export function CommsDetail({
  detail,
  onScopedConfirm,
  onReply,
  onArchive,
  outboxCommand = null,
  sentCommands = [],
  replyResetKey = 0,
  recoveryExhausted = false,
  replyRecoveryError = null,
  onReviewReply,
  onTryReplyAgain,
}: CommsDetailProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"reply" | "archive" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const itemId = detail?.item?.id ?? null;
  useEffect(() => {
    // A draft belongs to one ask. Never carry it across queue selections where it could answer the
    // wrong canonical session.
    setMessage("");
    setBusy(null);
    setActionError(null);
  }, [itemId]);
  if (!detail || !detail.item) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-8 text-[13px] text-muted-foreground">
        Select an item from the queue to see its detail.
      </div>
    );
  }
  const item = detail.item;
  const isTelegram = item.observation?.object_kind === "telegram-chat";
  const isEmail =
    item.observation?.object_kind === "email" ||
    item.source === "email" ||
    item.source === "gmail" ||
    item.observation?.connection_id?.startsWith("gog:");
  const Glyph = item.origin === "agent-event" ? Bot : isTelegram ? Send : Mail;
  const overdue = detail.notify?.overdue[item.id];
  const subject =
    item.origin === "agent-event"
      ? detail.agentContext?.subject || itemLabel(item)
      : itemLabel(item);
  const summary =
    item.origin === "agent-event"
      ? detail.agentContext?.summary || item.ask?.body || "Claude needs your input."
      : item.observation?.snippet || "No preview available.";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border-visible px-5 py-3.5">
        <Glyph size={16} className="text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
          {subject}
        </h2>
        {item.protected && (
          <span className="flex items-center gap-1 text-[11px] text-primary">
            <ShieldAlert size={12} /> Protected
          </span>
        )}

        {item.origin === "thread-state" && (
          <SendStatusStrip
            command={outboxCommand}
            canTryAgain={Boolean(onTryReplyAgain)}
            recoveryExhausted={recoveryExhausted}
            recoveryError={replyRecoveryError}
            onTryAgain={onTryReplyAgain}
          />
        )}
        <span className="text-[11px] text-muted-foreground">
          {item.source || item.account || item.origin} · {ageLabel(item.ts)}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
        {item.origin === "agent-event" ? (
          <section className="max-w-3xl">
            <p className="whitespace-pre-wrap text-[14px] leading-6 text-foreground/85">
              {summary}
            </p>
            {detail.agentContext?.turns.length ? (
              <div className="mt-5 space-y-4 border-t border-border-visible pt-4">
                {detail.agentContext.turns.map((turn, index) => (
                  <div key={`${turn.role}-${index}`} className="grid grid-cols-[52px_1fr] gap-3">
                    <span className="pt-0.5 text-[11px] font-medium text-muted-foreground">
                      {turn.role}
                    </span>
                    <p className="whitespace-pre-wrap text-[13px] leading-5 text-foreground/85">
                      {turn.text}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : (
          <section className="max-w-3xl">
            <p className="whitespace-pre-wrap text-[14px] leading-6 text-foreground/85">
              {summary}
            </p>
            <p className="mt-3 text-[11px] text-muted-foreground">Why now: {item.why}</p>
          </section>
        )}

        {overdue && (
          <p className="max-w-3xl text-[12px] text-muted-foreground" role="status">
            {overdue.delivery_attempts === 0
              ? "The phone alert was not sent; this item remains visible here."
              : `Phone alert sent ${overdue.last_delivery_at ? ageLabel(overdue.last_delivery_at) : "earlier"} — it has not been opened.`}
          </p>
        )}

        {item.origin === "agent-event" && item.ask?.status === "open" && (
          <section className="max-w-3xl border-t border-border-visible pt-4">
            <label
              htmlFor={`ask-reply-${item.id}`}
              className="text-[12px] font-medium text-foreground"
            >
              Reply to Claude
            </label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Your message resumes the original Claude session.
            </p>
            <textarea
              id={`ask-reply-${item.id}`}
              className="mt-3 min-h-24 w-full resize-y rounded-md border border-border-visible bg-background px-3 py-2 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
              value={message}
              disabled={busy !== null || !detail.agentContext?.canReply}
              placeholder={
                detail.agentContext?.canReply
                  ? "Give Claude the decision or context it needs…"
                  : "This session can’t be resumed safely. You can archive the ask."
              }
              onChange={(event) => setMessage(event.target.value)}
            />
            {actionError && (
              <p className="mt-2 text-[12px] text-destructive" role="status">
                {actionError}
              </p>
            )}
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy("archive");
                  setActionError(null);
                  try {
                    await onArchive(item.id);
                    setBusy(null);
                  } catch (error) {
                    setActionError((error as Error).message);
                    setBusy(null);
                  }
                }}
              >
                <Archive size={13} /> {busy === "archive" ? "Archiving…" : "Archive"}
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:bg-[var(--accent-hover)] disabled:opacity-50"
                disabled={busy !== null || !detail.agentContext?.canReply || !message.trim()}
                onClick={async () => {
                  setBusy("reply");
                  setActionError(null);
                  try {
                    await onReply(item.id, message.trim());
                    setMessage("");
                    setBusy(null);
                  } catch (error) {
                    setActionError((error as Error).message);
                    setBusy(null);
                  }
                }}
              >
                <Send size={13} /> {busy === "reply" ? "Sending…" : "Send to Claude"}
              </button>
            </div>
          </section>
        )}

        {/* Scoped-confirm entry points — the pending I-03 approvals the operator can authorize. */}
        {detail.pendingApprovals.length > 0 && (
          <div className="flex max-w-3xl flex-col gap-2 border-t border-border-visible pt-4">
            <div className="flex items-center gap-2">
              <ShieldAlert size={15} className="text-primary" />
              <span className="text-[12px] font-medium text-primary">Pending approvals</span>
            </div>
            {detail.pendingApprovals.map((p) => (
              <div
                key={p.handle}
                className="flex items-center gap-2 rounded-md border border-border-visible bg-secondary px-2.5 py-1.5"
              >
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                  {p.summary}
                </code>
                <button
                  type="button"
                  className="rounded-[8px] border border-transparent bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground hover:bg-[var(--accent-hover)] hover:shadow-[var(--glow-violet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => onScopedConfirm(p)}
                >
                  Review &amp; approve
                </button>
              </div>
            ))}
          </div>
        )}

        {item.origin === "thread-state" &&
        isEmail &&
        detail.replyability?.replyable &&
        onReviewReply ? (
          <ReplyComposer itemId={item.id} resetKey={replyResetKey} onReview={onReviewReply} />
        ) : item.origin === "thread-state" && isEmail ? (
          <section className="max-w-3xl border-t border-border-visible pt-4">
            <p className="text-[12px] text-muted-foreground">
              This message can’t be replied to safely here. Open it in Gmail.
            </p>
            <a
              className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-md border border-border-visible bg-secondary px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              href="https://mail.google.com/"
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={13} /> Open Gmail
            </a>
          </section>
        ) : null}

        <SentSection commands={sentCommands} />
      </div>
    </div>
  );
}
