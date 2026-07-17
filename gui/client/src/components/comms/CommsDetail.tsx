/**
 * CommsDetail (I-14 / AIO-395) — the detail pane, right half of the split-screen. Renders the selected
 * item's thread/ask detail as a TerminalFrame-based AskCard in its current state, plus any pending I-03
 * capability approvals as scoped-confirm entry points. Reply composition is DEFERRED (deep-link to Gmail
 * per the Won't list) — this pane reads; the only mutation is the scoped confirmation, brokered by the
 * parent. Content shown is admin-tier local (synthetic in fixtures).
 */

import { useEffect, useState } from "react";
import { Archive, Bot, ExternalLink, Mail, Send, ShieldAlert } from "lucide-react";
import { AskCard } from "./AskCard";
import { deriveAskState, type DisplayProjection, type InboxDetail } from "./types";
import { itemLabel, itemMeta, ageLabel } from "./presenters";

export interface CommsDetailProps {
  detail: InboxDetail | null;
  onScopedConfirm: (projection: DisplayProjection) => void;
  onReply: (id: string, message: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
}

export function CommsDetail({ detail, onScopedConfirm, onReply, onArchive }: CommsDetailProps) {
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
  const Glyph = item.origin === "agent-event" ? Bot : Mail;
  const state = deriveAskState(item);
  const body =
    item.origin === "agent-event"
      ? `${(item.ask?.kind as string) || "ask"} · ${(item.ask?.severity as string) || ""}\n${(item.ask?.title as string) || ""}`.trim()
      : (item.observation?.snippet as string) || "(no preview available)";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border-visible px-4 py-3">
        <Glyph size={16} className="text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
          {itemLabel(item)}
        </h2>
        {item.protected && (
          <span className="rounded-full border border-[var(--accent-line)] bg-secondary px-2 py-px font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-primary">
            protected
          </span>
        )}
        <span className="font-mono text-[11px] text-muted-foreground">
          {item.source || item.account || item.origin} · {ageLabel(item.ts)}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {item.origin === "agent-event" ? (
          <section className="rounded-lg border border-border-visible bg-card p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-primary">
                Claude needs you
              </span>
              <span className="text-[11px] text-muted-foreground">{ageLabel(item.ts)}</span>
            </div>
            <h3 className="text-[16px] font-semibold leading-snug text-foreground">
              {detail.agentContext?.subject || itemLabel(item)}
            </h3>
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-muted-foreground">
              {detail.agentContext?.summary || body}
            </p>
            {detail.agentContext?.turns.length ? (
              <div className="mt-4 space-y-3 border-t border-border-visible pt-3">
                {detail.agentContext.turns.map((turn, index) => (
                  <div key={`${turn.role}-${index}`} className="grid grid-cols-[52px_1fr] gap-3">
                    <span className="pt-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                      {turn.role}
                    </span>
                    <p className="whitespace-pre-wrap text-[12px] leading-5 text-foreground/85">
                      {turn.text}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : (
          <AskCard
            state={state}
            title={itemLabel(item)}
            source={item.source}
            why={item.why}
            body={body}
            meta={itemMeta(item)}
            timeLabel={ageLabel(item.ts)}
            origin={item.origin}
          />
        )}

        {item.origin === "agent-event" && item.ask?.status === "open" && (
          <section className="rounded-lg border border-border-visible bg-card p-3">
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
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--accent-line)] bg-card p-3">
            <div className="flex items-center gap-2">
              <ShieldAlert size={15} className="text-primary" />
              <span className="font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-primary">
                pending approvals
              </span>
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

        {/* Reply composition is deferred: the operator continues the thread in Gmail (content-free link). */}
        {item.origin === "thread-state" && (
          <a
            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border-visible bg-secondary px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            href="https://mail.google.com/"
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={13} /> Reply in Gmail
          </a>
        )}
      </div>
    </div>
  );
}
