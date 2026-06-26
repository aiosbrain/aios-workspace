import type { PendingPermission } from "../../types/messages";

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
    <div className="permission">
      <div className="perm-head">
        Approve <strong>{tool}</strong>?
      </div>
      <pre>{JSON.stringify(input, null, 2).slice(0, 1200)}</pre>
      <div className="perm-actions">
        {options && options.length ? (
          options.map((o) => (
            <button
              key={o.optionId}
              className={/deny|reject|cancel/i.test(o.kind || "") ? "deny" : "allow"}
              onClick={() => onRespondOption(id, o.optionId)}
            >
              {o.name}
            </button>
          ))
        ) : (
          <>
            <button className="allow" onClick={() => onRespond(id, true)}>
              Allow
            </button>
            <button className="deny" onClick={() => onRespond(id, false)}>
              Deny
            </button>
          </>
        )}
      </div>
    </div>
  );
}
