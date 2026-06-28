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
    <label className="model-pick">
      <span>Model</span>
      <select value={model} disabled={busy} onChange={(e) => changeModel(e.target.value)}>
        {capabilities.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
