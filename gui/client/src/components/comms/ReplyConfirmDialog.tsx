import { useEffect, useState } from "react";
import { MailCheck } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ReplyConfirmationSnapshot } from "./types";

const BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const PRIMARY = cn(
  BTN,
  "border-transparent bg-primary font-semibold text-primary-foreground enabled:hover:bg-[var(--accent-hover)]"
);

export interface ReplyConfirmDialogProps {
  snapshot: ReplyConfirmationSnapshot;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export type ReplyConfirmationStep = "unarmed" | "armed";

export function advanceReplyConfirmation(step: ReplyConfirmationStep): ReplyConfirmationStep {
  return step === "unarmed" ? "armed" : step;
}

export function canSubmitReply(step: ReplyConfirmationStep, busy: boolean): boolean {
  return step === "armed" && !busy;
}

export function ReplyConfirmDialog({
  snapshot,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: ReplyConfirmDialogProps) {
  const [step, setStep] = useState<ReplyConfirmationStep>("unarmed");

  useEffect(() => setStep("unarmed"), [snapshot.command_id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--aios-bg)_70%,transparent)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gmail-reply-confirm-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-lg border border-[var(--accent-line)] bg-card p-4 shadow-[var(--shadow-overlay)]">
        <div className="flex items-center gap-2">
          <MailCheck size={16} className="text-primary" />
          <h2
            id="gmail-reply-confirm-title"
            className="flex-1 text-base font-semibold text-foreground"
          >
            Review Gmail reply
          </h2>
          <span className="rounded-full border border-[var(--accent-line)] bg-secondary px-2 py-px text-[10px] text-primary">
            {snapshot.preview.thread_label}
          </span>
        </div>

        <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-2 text-[12px]">
          <dt className="text-muted-foreground">To</dt>
          <dd className="break-all text-foreground">{snapshot.preview.to.join(", ")}</dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="text-foreground">{snapshot.preview.subject}</dd>
        </dl>
        <div>
          <p className="mb-1 text-[11px] text-muted-foreground">Message</p>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-border-visible bg-background p-3 font-sans text-[13px] leading-5 text-foreground">
            {snapshot.preview.body}
          </pre>
        </div>
        {error && (
          <p className="text-[12px] text-destructive" role="status">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {step === "unarmed" ? (
            <button
              type="button"
              className={PRIMARY}
              onClick={() => setStep((current) => advanceReplyConfirmation(current))}
              disabled={busy}
            >
              Arm send
            </button>
          ) : (
            <button
              type="button"
              className={PRIMARY}
              onClick={onConfirm}
              disabled={!canSubmitReply(step, busy)}
              autoFocus
            >
              {busy ? "Sending…" : "Confirm send"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
