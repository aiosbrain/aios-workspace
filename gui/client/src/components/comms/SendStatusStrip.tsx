import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import { presentSendState } from "./presenters";
import type { OutboxCommand } from "./types";

export interface SendStatusStripProps {
  command: OutboxCommand | null;
  canTryAgain?: boolean;
  recoveryExhausted?: boolean;
  recoveryError?: string | null;
  onTryAgain?: () => void;
}

export function SendStatusStrip({
  command,
  canTryAgain = false,
  recoveryExhausted = false,
  recoveryError = null,
  onTryAgain,
}: SendStatusStripProps) {
  if (!command) return null;
  const presentation = presentSendState(command.state);
  const Icon =
    presentation.tone === "success"
      ? CheckCircle2
      : presentation.tone === "danger"
        ? AlertCircle
        : LoaderCircle;
  return (
    <section
      className="flex max-w-3xl items-center gap-2 rounded-md border border-border-visible bg-secondary px-3 py-2 text-[12px]"
      role="status"
      title={presentation.tooltip}
    >
      <Icon
        size={14}
        className={presentation.tone === "danger" ? "text-destructive" : "text-primary"}
      />
      <span className="font-medium text-foreground">{presentation.label}</span>
      <span className="text-muted-foreground">{presentation.tooltip}</span>
      {command.state === "failed" && canTryAgain && onTryAgain && (
        <button
          type="button"
          className="ml-auto rounded-md border border-border-visible bg-background px-2 py-1 text-[11px] text-foreground hover:border-primary"
          onClick={onTryAgain}
        >
          Try again
        </button>
      )}
      {recoveryExhausted && (
        <span className="ml-auto text-[11px] text-muted-foreground">
          Check Gmail Sent or use the inbox CLI before trying another reply.
        </span>
      )}
      {recoveryError && (
        <span className="ml-auto text-[11px] text-destructive">{recoveryError}</span>
      )}
    </section>
  );
}
