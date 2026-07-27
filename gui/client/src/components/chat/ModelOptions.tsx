import type { ModelOption } from "../../types/runtime";

/**
 * <option> list for a model <select>, shared by the composer picker and the Agent
 * settings panel so both render a catalog identically.
 *
 * Flat when no model declares a `group` (the claude-code case — unchanged markup);
 * one <optgroup> per provider, in first-seen order, when they do (opencode brokers
 * several providers at once).
 *
 * `selected` is the currently configured `agent_model`. It can legitimately sit
 * outside the catalog — a permissive runtime accepts ids the provider listing didn't
 * return, and switching runtimes leaves the previous runtime's model in aios.yaml. In
 * that case the id is appended as its own option, flagged, so the <select> shows what
 * is really configured instead of silently snapping to the first entry (the adapter
 * separately warns in-chat when it has to fall back to the runtime's default).
 */
export function ModelOptions({ models, selected }: { models: ModelOption[]; selected?: string }) {
  const extra =
    selected && !models.some((m) => m.id === selected)
      ? [{ id: selected, label: `${selected} — not in this runtime's catalog` }]
      : ([] as ModelOption[]);
  const all = [...models, ...extra];

  if (!all.some((m) => m.group)) {
    return (
      <>
        {all.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </>
    );
  }

  const groups: { name: string; models: ModelOption[] }[] = [];
  for (const m of all) {
    const name = m.group || "Other";
    const bucket = groups.find((g) => g.name === name);
    if (bucket) bucket.models.push(m);
    else groups.push({ name, models: [m] });
  }

  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.name} label={g.name}>
          {g.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
