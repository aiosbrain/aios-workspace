/**
 * ScopedConfirmDialog (I-14 / AIO-395) — the authority-requiring confirmation half of D1's grammar.
 *
 * It renders the I-03 DISPLAY PROJECTION (operation summary) and the canonical REQUEST DIGEST the human
 * binds to — then, on confirm, the parent posts EXACTLY `{ handle, digest, decision }` (see api.ts
 * `postDecision`). Nothing else leaves the client: the dialog never sees or forwards the request's args.
 *
 * Confirm grammar (variant A): keystroke cost equals authority. A boundary-crossing approval is a
 * DELIBERATE two-step (arm → confirm), not a single stray click; deny is immediate.
 */

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { cn } from "../../lib/cn";
import type { DisplayProjection } from "./types";

const BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const BTN_PRIMARY = cn(
  BTN,
  "border-transparent bg-primary font-semibold text-primary-foreground enabled:hover:bg-[var(--accent-hover)] enabled:hover:shadow-[var(--glow-violet)]"
);
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card";

export interface ScopedConfirmDialogProps {
  projection: DisplayProjection;
  onDecide: (decision: "approve" | "deny") => void;
  onClose: () => void;
  busy?: boolean;
  error?: string | null;
}

export function ScopedConfirmDialog({
  projection,
  onDecide,
  onClose,
  busy = false,
  error = null,
}: ScopedConfirmDialogProps) {
  const [armed, setArmed] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--aios-bg)_70%,transparent)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scoped-confirm-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-[var(--accent-line)] bg-card p-4 shadow-[var(--shadow-overlay)]">
        <div className="flex items-center gap-2">
          <ShieldAlert size={16} className="text-primary" />
          <h2
            id="scoped-confirm-title"
            className="flex-1 font-sans text-base font-semibold tracking-[var(--aios-tracking-snug)] text-foreground"
          >
            Scoped confirmation
          </h2>
          <span className="rounded-full border border-[var(--accent-line)] bg-secondary px-2 py-px font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-primary">
            authority required
          </span>
        </div>

        {/* Display projection — the safe-to-render summary of WHAT is being approved (no args). */}
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
            operation
          </span>
          <code className="rounded-[6px] border border-border-visible bg-secondary px-2 py-1.5 font-mono text-[12px] text-foreground">
            {projection.summary}
          </code>
        </div>

        {/* The canonical request digest the decision binds to — the runtime re-checks it before executing. */}
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
            request digest
          </span>
          <code
            className="break-all rounded-[6px] border border-border-visible bg-secondary px-2 py-1.5 font-mono text-[11px] text-muted-foreground"
            data-testid="scoped-confirm-digest"
          >
            {projection.digest}
          </code>
          <span className="text-[11px] text-muted-foreground">
            The owning runtime validates this digest against its own record and consumes it exactly
            once; a mutated digest is rejected before anything runs.
          </span>
        </div>

        {error && <p className="text-[12px] text-destructive">{error}</p>}

        <div className="mt-1 flex items-center justify-end gap-2">
          <button
            type="button"
            className={cn(BTN, FOCUS_RING)}
            onClick={() => onDecide("deny")}
            disabled={busy}
          >
            Deny
          </button>
          {!armed ? (
            <button
              type="button"
              className={cn(BTN_PRIMARY, FOCUS_RING)}
              onClick={() => setArmed(true)}
              disabled={busy}
            >
              Approve…
            </button>
          ) : (
            <button
              type="button"
              className={cn(BTN_PRIMARY, FOCUS_RING)}
              onClick={() => onDecide("approve")}
              disabled={busy}
              autoFocus
            >
              {busy ? "Confirming…" : "Confirm approve"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
