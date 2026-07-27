import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import type { PendingPermission } from "../../types/messages";

const BTN_BASE = "rounded-md px-[18px] py-1.5 font-semibold cursor-pointer";
const ALLOW = cn(BTN_BASE, "bg-lime text-lime-foreground");
const DENY = cn(BTN_BASE, "border border-border-visible bg-secondary text-foreground");

/** m:ss until the server's auto-deny; null once expired or when the server sent no deadline. */
export function autoDenyRemaining(p: PendingPermission, now: number): string | null {
  if (p.timeoutMs == null || p.receivedAt == null) return null;
  const left = p.receivedAt + p.timeoutMs - now;
  if (left <= 0) return null;
  const s = Math.ceil(left / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Interactive approval. Data-driven by what the runtime sent: option-style runtimes
 * (ACP / OpenCode) supply their own choices; Claude-style sends none → boolean
 * allow/deny. This mirrors capabilities.permissionStyle without branching on it.
 */
export function PermissionCard({
  permission,
  onRespond,
  onRespondOption,
  onExpired,
}: {
  permission: PendingPermission;
  onRespond: (id: number, allow: boolean) => void;
  onRespondOption: (id: number, optionId: string) => void;
  onExpired?: (id: number) => void;
}) {
  const { id, tool, input, options } = permission;
  // Tick once a second while a server deadline is running so the user knows this
  // card is not open-ended: an unanswered approval is DENIED at the deadline.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (permission.timeoutMs == null || permission.receivedAt == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [permission.timeoutMs, permission.receivedAt]);
  const remaining = autoDenyRemaining(permission, now);
  // At the server's deadline the request is already denied server-side — remove the
  // card (via onExpired) so a late Allow can't pretend to work. Unmount stops the tick.
  const expired =
    permission.timeoutMs != null &&
    permission.receivedAt != null &&
    now >= permission.receivedAt + permission.timeoutMs;
  useEffect(() => {
    if (expired) onExpired?.(permission.id);
  }, [expired, onExpired, permission.id]);
  return (
    <div className="self-stretch rounded-xl border border-primary bg-[var(--accent-soft)] px-3.5 py-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span>
          Approve <strong>{tool}</strong>?
        </span>
        {expired ? (
          <span className="ml-auto font-mono text-xs text-muted-foreground">auto-denied</span>
        ) : (
          remaining && (
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              auto-denies in {remaining}
            </span>
          )
        )}
      </div>
      <pre className="max-h-[180px] overflow-y-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
        {JSON.stringify(input, null, 2).slice(0, 1200)}
      </pre>
      <div className="mt-2 flex gap-2">
        {options && options.length ? (
          options.map((o) => (
            <button
              key={o.optionId}
              className={/deny|reject|cancel/i.test(o.kind || "") ? DENY : ALLOW}
              // Past the deadline the server has already denied — a click must not
              // look like a decision that took effect (the card unmounts via onExpired).
              disabled={expired}
              onClick={() => !expired && onRespondOption(id, o.optionId)}
            >
              {o.name}
            </button>
          ))
        ) : (
          <>
            <button className={ALLOW} disabled={expired} onClick={() => !expired && onRespond(id, true)}>
              Allow
            </button>
            <button className={DENY} disabled={expired} onClick={() => !expired && onRespond(id, false)}>
              Deny
            </button>
          </>
        )}
      </div>
    </div>
  );
}
