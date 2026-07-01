import { useRuntime, useSession } from "../../state/cockpit";

/**
 * Model selector. Shown only when the runtime supports switching and offers a model
 * list (BYOA — never a hardcoded Claude list). Options come from capabilities.models,
 * which the server resolves per runtime.
 */
export function ModelPicker() {
  const { capabilities } = useRuntime();
  const { model, changeModel, busy } = useSession();

  if (!capabilities.modelSwitching || capabilities.models.length === 0) return null;

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Model</span>
      <select
        className="cursor-pointer rounded-md border border-border-visible bg-secondary px-[9px] py-[5px] text-[13px] text-foreground outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-default disabled:opacity-50"
        value={model}
        disabled={busy}
        onChange={(e) => changeModel(e.target.value)}
      >
        {capabilities.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
