import { cn } from "../../lib/cn";
import type { PendingPermission } from "../../types/messages";

const BTN_BASE = "rounded-md px-[18px] py-1.5 font-semibold cursor-pointer";
const ALLOW = cn(BTN_BASE, "bg-lime text-lime-foreground");
const DENY = cn(BTN_BASE, "border border-border-visible bg-secondary text-foreground");

/**
 * Interactive approval. Data-driven by what the runtime sent: option-style runtimes
 * (ACP / OpenCode) supply their own choices; Claude-style sends none → boolean
 * allow/deny. This mirrors capabilities.permissionStyle without branching on it.
 */
export function PermissionCard({
  permission,
  onRespond,
  onRespondOption,
}: {
  permission: PendingPermission;
  onRespond: (id: number, allow: boolean) => void;
  onRespondOption: (id: number, optionId: string) => void;
}) {
  const { id, tool, input, options } = permission;
  return (
    <div className="self-stretch rounded-xl border border-primary bg-[var(--accent-soft)] px-3.5 py-3">
      <div className="mb-2">
        Approve <strong>{tool}</strong>?
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
              onClick={() => onRespondOption(id, o.optionId)}
            >
              {o.name}
            </button>
          ))
        ) : (
          <>
            <button className={ALLOW} onClick={() => onRespond(id, true)}>
              Allow
            </button>
            <button className={DENY} onClick={() => onRespond(id, false)}>
              Deny
            </button>
          </>
        )}
      </div>
    </div>
  );
}
