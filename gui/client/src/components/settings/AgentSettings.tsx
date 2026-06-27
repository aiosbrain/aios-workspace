import { useEffect, useState } from "react";
import { useConnection, useRuntime, useSession } from "../../state/cockpit";
import type { ConfigResponse, PersonalitiesResponse, Personality } from "../../types/protocol";

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
      {capabilities.modelSwitching && models.length > 0 && (
        <section className="set-section">
          <h3 className="set-section-title">Default model</h3>
          <label className="model-pick">
            <span>Model</span>
            <select value={model} onChange={(e) => changeModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      <section className="set-section">
        <h3 className="set-section-title">Personality</h3>
        <p className="set-section-hint">
          A style layer appended to the system prompt — it never overrides your rules,
          CLAUDE.md, or skills. Changing it starts a new chat so the voice takes effect.
        </p>
        {!personalities ? (
          <div className="int-grid">
            <div className="skeleton-card" />
            <div className="skeleton-card" />
          </div>
        ) : (
          <div className="int-grid">
            {personalities.map((p) => (
              <div key={p.id} className={`int-card${p.id === current ? " wired" : ""}`}>
                <div className="int-card-top">
                  <span className="int-name">{p.name}</span>
                  <span className={`int-status ${p.id === current ? "wired" : ""}`}>
                    {p.id === current ? "● active" : "○"}
                  </span>
                </div>
                <p className="int-summary">{p.description}</p>
                <div className="int-card-foot">
                  <span className="int-transport">style only</span>
                  <button
                    className="int-connect"
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

      <section className="set-section">
        <h3 className="set-section-title">Memory</h3>
        <label className="mem-toggle">
          <input
            type="checkbox"
            checked={!!memReview}
            disabled={memReview === null || memUnavailable}
            onChange={toggleMemReview}
          />
          <span>Auto-update my workspace memory after each turn</span>
        </label>
        <p className="set-section-hint">
          A fast model (Haiku) conservatively saves durable facts to{" "}
          <code>.claude/memory/USER.md</code> / <code>WORKSPACE.md</code> — you get a 💾 notice
          with an undo, and changes take effect next session. Secrets are never sent or saved.
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
