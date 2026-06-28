import { useEffect, useState } from "react";
import { useConnection, useRuntime, useSession } from "../../state/cockpit";
import { cn } from "../../lib/cn";
import { SET_SECTION, SET_SECTION_TITLE, SET_SECTION_HINT } from "./SettingsView";
import { INT_GRID, INT_CONNECT, SKELETON_CARD, intCard } from "../integrations/intCard";
import type { ConfigResponse, PersonalitiesResponse, Personality } from "../../types/protocol";

const MODEL_PICK_SELECT =
  "cursor-pointer rounded-md border border-border-visible bg-secondary px-[9px] py-[5px] text-[13px] text-foreground outline-none focus:border-primary disabled:cursor-default disabled:opacity-50";

/**
 * The "Agent" settings section: default model, agent personality (a style layer over the
 * system prompt), and the background memory reviewer toggle. Model list + memory toggle are
 * driven by BYOA capabilities, never by a runtime-name check. Rendered inside SettingsView.
 */
export function AgentSettings() {
  const { api } = useConnection();
  const { runtime, capabilities } = useRuntime();
  const { model, changeModel, newChat } = useSession();

  const [personalities, setPersonalities] = useState<Personality[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [memReview, setMemReview] = useState<boolean | null>(null); // null = loading

  const models = capabilities.models;

  useEffect(() => {
    api
      .get<PersonalitiesResponse>("/api/personalities")
      .then((d) => {
        setPersonalities(d.personalities || []);
        setCurrent(d.current);
      })
      .catch(() => setPersonalities([]));
    api
      .get<ConfigResponse>("/api/config")
      .then((d) => setMemReview(d.memoryReview !== false))
      .catch(() => setMemReview(true));
  }, [api]);

  const toggleMemReview = async () => {
    const next = !memReview;
    setMemReview(next);
    try {
      await api.post("/api/config/memory-review", { enabled: next });
    } catch {
      setMemReview(!next); // revert on failure
    }
  };

  const pick = async (id: string) => {
    if (id === current || saving) return;
    setSaving(true);
    try {
      const d = await api.post<{ ok: boolean }>("/api/config/personality", { personality: id });
      if (d.ok) {
        setCurrent(id);
        newChat(); // new chat so the persona applies
      }
    } catch {
      /* leave selection */
    }
    setSaving(false);
  };

  const memUnavailable = !capabilities.memoryReviewer;

  return (
    <>
      <section className={SET_SECTION}>
        <h3 className={SET_SECTION_TITLE}>Runtime</h3>
        <p className={SET_SECTION_HINT}>
          Agent runtime: <code>{runtime || "—"}</code>. Set <code>agent_runtime</code> in{" "}
          <code>aios.yaml</code> — it applies on the next chat.
        </p>
      </section>

      {capabilities.modelSwitching && models.length > 0 && (
        <section className={SET_SECTION}>
          <h3 className={SET_SECTION_TITLE}>Default model</h3>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Model</span>
            <select
              className={MODEL_PICK_SELECT}
              value={model}
              onChange={(e) => changeModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      <section className={SET_SECTION}>
        <h3 className={SET_SECTION_TITLE}>Personality</h3>
        <p className={SET_SECTION_HINT}>
          A style layer appended to the system prompt — it never overrides your rules, CLAUDE.md, or
          skills. Changing it starts a new chat so the voice takes effect.
        </p>
        {!personalities ? (
          <div className={INT_GRID}>
            <div className={SKELETON_CARD} />
            <div className={SKELETON_CARD} />
          </div>
        ) : (
          <div className={INT_GRID}>
            {personalities.map((p) => (
              <div key={p.id} className={intCard(p.id === current)}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{p.name}</span>
                  <span
                    className={cn(
                      "text-[11px]",
                      p.id === current ? "text-lime" : "text-muted-foreground"
                    )}
                  >
                    {p.id === current ? "● active" : "○"}
                  </span>
                </div>
                <p className="m-0 flex-1 text-[12.5px] leading-[1.45] text-muted-foreground">
                  {p.description}
                </p>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
                    style only
                  </span>
                  <button
                    className={INT_CONNECT}
                    disabled={saving || p.id === current}
                    onClick={() => pick(p.id)}
                  >
                    {p.id === current ? "Active" : "Use"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={SET_SECTION}>
        <h3 className={SET_SECTION_TITLE}>Memory</h3>
        <label className="mt-0.5 mb-1.5 flex cursor-pointer items-center gap-[9px] text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
            checked={!!memReview}
            disabled={memReview === null || memUnavailable}
            onChange={toggleMemReview}
          />
          <span>Auto-update my workspace memory after each turn</span>
        </label>
        <p className={SET_SECTION_HINT}>
          A fast model (Haiku) conservatively saves durable facts to{" "}
          <code>.claude/memory/USER.md</code> / <code>WORKSPACE.md</code> — you get a 💾 notice with
          an undo, and changes take effect next session. Secrets are never sent or saved.
          {memUnavailable ? (
            <>
              {" "}
              Unavailable on the <code>{runtime || "current"}</code> runtime.
            </>
          ) : null}
        </p>
      </section>
    </>
  );
}
