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
    <label className="model-pick">
      <span>Approval</span>
      <select
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
