import { useRuntime, useSession } from "../../state/cockpit";

/**
 * Composer approval-mode selector. Shown only when the runtime advertises approval modes
 * (BYOA — capability-driven, never a runtime-name branch). Options come from
 * capabilities.approvalModes, which the server fills per runtime (env-gated; "Full access"
 * is withheld unless explicitly enabled). The mode is session-scoped and applies to the
 * NEXT send, mirroring the model picker.
 */
export function ApprovalModePicker() {
  const { capabilities } = useRuntime();
  const { approvalMode, setApprovalMode, busy } = useSession();

  if (capabilities.approvalModes.length === 0) return null;

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Approval</span>
      <select
        className="cursor-pointer rounded-md border border-border-visible bg-secondary px-[9px] py-[5px] text-[13px] text-foreground outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-default disabled:opacity-50"
        value={approvalMode}
        disabled={busy}
        onChange={(e) => setApprovalMode(e.target.value)}
      >
        {capabilities.approvalModes.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );
}
