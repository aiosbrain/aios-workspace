// Legacy workspace panels, extracted verbatim from the original App.jsx during the
// cockpit componentization (Phase 2 strangler bridge). They keep the non-chat surfaces
// working while each is rewritten in TypeScript (Phase 3); do not polish here.
/* eslint-disable */
import { useState, useEffect, useCallback } from "react";
import { Button, EyebrowLabel } from "@aios-alpha/ui";
import { resolveGuiToken } from "../lib/token";

const token = resolveGuiToken();

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
];

const RISK_LABEL = { low: "low risk", elevated: "review", high: "high risk" };

export function SettingsPanel({ model, onModelChange, onPersonalityApplied }) {
  const [personalities, setPersonalities] = useState(null);
  const [current, setCurrent] = useState(null);
  const [saving, setSaving] = useState(false);
  const [memReview, setMemReview] = useState(null); // null = loading
  const [runtime, setRuntime] = useState("");

  useEffect(() => {
    fetch(`/api/personalities?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        setPersonalities(d.personalities || []);
        setCurrent(d.current);
      })
      .catch(() => setPersonalities([]));
    fetch(`/api/config?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        setMemReview(d.memoryReview !== false);
        setRuntime(d.runtime || "");
      })
      .catch(() => setMemReview(true));
  }, []);

  const toggleMemReview = async () => {
    const next = !memReview;
    setMemReview(next);
    try {
      await fetch(`/api/config/memory-review?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
    } catch {
      setMemReview(!next);
    } // revert on failure
  };

  const pick = async (id) => {
    if (id === current || saving) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/config/personality?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personality: id }),
      });
      const d = await r.json();
      if (d.ok) {
        setCurrent(id);
        onPersonalityApplied();
      } // new chat so the persona applies
    } catch {
      /* leave selection */
    }
    setSaving(false);
  };

  return (
    <div className="integrations">
      <div className="int-head">
        <div>
          <h2>Settings</h2>
          <p className="int-sub">
            Pick the default model and the agent's personality. Personality is a style layer
            appended to the system prompt — it never overrides your rules, CLAUDE.md, or skills.
          </p>
        </div>
      </div>

      <h3 className="int-section">Default model</h3>
      <label className="model-pick">
        <span>Model</span>
        <select value={model} onChange={(e) => onModelChange(e.target.value)}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <h3 className="int-section">Personality</h3>
      {!personalities ? (
        <div className="empty">
          <p>loading…</p>
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
      <p className="int-foot">
        Changing personality starts a new chat so the new voice takes effect.
      </p>

      <h3 className="int-section">Memory</h3>
      <label className="mem-toggle">
        <input
          type="checkbox"
          checked={!!memReview}
          disabled={memReview === null || runtime !== "claude-code"}
          onChange={toggleMemReview}
        />
        <span>Auto-update my workspace memory after each turn</span>
      </label>
      <p className="int-sub">
        A fast model (Haiku) conservatively saves durable facts to{" "}
        <code>.claude/memory/USER.md</code> / <code>WORKSPACE.md</code> — you get a 💾 notice with
        an undo, and changes take effect next session. Secrets are never sent or saved.
        {runtime && runtime !== "claude-code" ? (
          <>
            {" "}
            Unavailable on the <code>{runtime}</code> runtime (claude-code only).
          </>
        ) : null}
      </p>
    </div>
  );
}

export function SkillsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [acting, setActing] = useState(null); // id currently installing/removing
  const [rowErr, setRowErr] = useState({}); // id → error message
  const [review, setReview] = useState(null); // { id, name } of skill under review

  const load = useCallback(() => {
    setError(null);
    fetch(`/api/skills?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Install/uninstall. `consent` is sent for community installs (official ignores it).
  const act = async (id, action, consent) => {
    setActing(id);
    setRowErr((p) => ({ ...p, [id]: null }));
    try {
      const r = await fetch(`/api/skills/${id}/${action}?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(consent ? { consent } : {}),
      });
      const d = await r.json();
      if (!d.ok) {
        setRowErr((p) => ({ ...p, [id]: d.error || "failed" }));
        return false;
      }
      setReview(null);
      load();
      return true;
    } catch (e) {
      setRowErr((p) => ({ ...p, [id]: e.message }));
      return false;
    } finally {
      setActing(null);
    }
  };

  if (error)
    return (
      <div className="integrations">
        <div className="msg meta error">error: {error}</div>
      </div>
    );
  if (!data)
    return (
      <div className="integrations">
        <div className="empty">
          <p>loading skills…</p>
        </div>
      </div>
    );

  // group official skills by category
  const groups = {};
  for (const s of data.skills) (groups[s.category] ||= []).push(s);
  const marketplace = data.marketplace || [];
  const community = data.community || [];
  const installedCount = data.skills.filter((s) => s.installed).length;

  // Trust → human badge. official is hash-locked; marketplace is first-party vetted but
  // fetch-on-install (so a Review step runs the advisory scan); community is unverified.
  const TRUST_BADGE = {
    official: "official · Apache-2.0",
    marketplace: "marketplace · official",
    community: "community · unverified",
  };

  const card = (s) => {
    const isCommunity = s.trust === "community";
    const isMarketplace = s.trust === "marketplace";
    const reviewed = isCommunity || isMarketplace; // both go through the Review modal
    return (
      <div key={s.id} className={`int-card${s.installed ? " wired" : ""}`}>
        <div className="int-card-top">
          <span className="int-name">{s.name}</span>
          <span className={`int-status ${s.installed ? "wired" : ""}`}>
            {s.installed ? "● installed" : "○ available"}
          </span>
        </div>
        <p className="int-summary">{s.description}</p>
        <div className="skill-caps">
          {s.capabilities?.bundles_code ? (
            <span className="cap code" title={(s.capabilities.code_files || []).join(", ")}>
              ⚙ runs code
              {s.capabilities.code_files ? ` (${(s.capabilities.code_files || []).length})` : ""}
            </span>
          ) : (
            !reviewed && <span className="cap">text-only</span>
          )}
          <span className={`cap trust ${s.trust}`}>{TRUST_BADGE[s.trust] || s.trust}</span>
        </div>
        <div className="int-card-foot">
          <span className="int-transport">{s.category}</span>
          {s.installed ? (
            <button
              className="wiz-secondary"
              disabled={acting === s.id}
              onClick={() => act(s.id, "uninstall")}
            >
              {acting === s.id ? "…" : "Remove"}
            </button>
          ) : reviewed ? (
            <button
              className="int-connect"
              disabled={acting === s.id}
              onClick={() => setReview({ id: s.id, name: s.name, trust: s.trust })}
            >
              Review &amp; install
            </button>
          ) : (
            <button
              className="int-connect"
              disabled={acting === s.id}
              onClick={() => act(s.id, "install")}
            >
              {acting === s.id ? "Installing…" : "Install"}
            </button>
          )}
        </div>
        {rowErr[s.id] && <p className="skill-err">{rowErr[s.id]}</p>}
      </div>
    );
  };

  return (
    <div className="integrations">
      <div className="int-head">
        <div>
          <h2>Skills</h2>
          <p className="int-sub">
            Official Anthropic skills are vendored from <code>anthropics/skills</code> and
            hash-locked — one-click install into <code>.claude/skills/</code>. Marketplace skills
            come from Anthropic's official plugin directory (<code>claude-plugins-official</code>):
            first-party vetted, but fetched-on-install at a pinned commit and byte-verified against
            the catalog. Community skills carry no first-party provenance and require your review.
            Scanning is <strong>advisory</strong> — provenance and your own review are the real
            safeguard.
          </p>
        </div>
        <div className="int-progress">
          {installedCount} of {data.skills.length} installed
        </div>
      </div>

      {Object.keys(groups)
        .sort()
        .map((cat) => (
          <React.Fragment key={cat}>
            <h3 className="int-section">{cat}</h3>
            <div className="int-grid">{groups[cat].map(card)}</div>
          </React.Fragment>
        ))}

      {marketplace.length > 0 && (
        <>
          <h3 className="int-section">Marketplace — Anthropic official plugins</h3>
          <div className="int-grid">{marketplace.map(card)}</div>
          <p className="int-foot">
            ↪ Marketplace skills are first-party (Anthropic) but <strong>fetched on install</strong>{" "}
            from <code>claude-plugins-official</code> at a pinned commit. The fetched bytes are
            byte-verified against the catalog before anything lands in <code>.claude/skills/</code>{" "}
            — a tampered or drifted upstream is refused. Installing needs network access.
          </p>
        </>
      )}

      {community.length > 0 && (
        <>
          <h3 className="int-section int-section-muted">
            Community — unverified (scan + consent required)
          </h3>
          <div className="int-grid">{community.map(card)}</div>
          <p className="int-foot">
            ⚠ Community skills are not vendored or first-party. Installing one runs its bundled
            instructions/code in your workspace — treat it like installing software from a stranger.
          </p>
        </>
      )}

      {review && (
        <SkillReviewModal
          skill={review}
          acting={acting === review.id}
          rowErr={rowErr[review.id]}
          onClose={() => setReview(null)}
          onInstall={(consent) => act(review.id, "install", consent)}
        />
      )}

      {data.referenced?.length > 0 && (
        <>
          <h3 className="int-section int-section-muted">Documents — available in Claude</h3>
          <div className="int-grid">
            {data.referenced.map((s) => (
              <div key={s.id} className="int-card">
                <div className="int-card-top">
                  <span className="int-name">{s.name}</span>
                </div>
                <p className="int-summary">{s.description}</p>
                <div className="int-card-foot">
                  <span className="int-transport">official · hosted</span>
                  <a
                    className="int-connect"
                    href={data.referenced_docs_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Enable in Claude ↗
                  </a>
                </div>
              </div>
            ))}
          </div>
          <p className="int-foot">
            These document skills are Anthropic-hosted (proprietary license) — used inside Claude,
            not copied here.
          </p>
        </>
      )}
    </div>
  );
}

export function SkillReviewModal({ skill, acting, rowErr, onClose, onInstall }) {
  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [typed, setTyped] = useState("");
  const isMarketplace = skill.trust === "marketplace";

  useEffect(() => {
    setScan(null);
    setScanErr(null);
    fetch(`/api/skills/${skill.id}/scan?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setScan(d);
      })
      .catch((e) => setScanErr(e.message));
  }, [skill.id]);

  const needsTyped = scan?.requiresTypedConfirm; // server: community high-risk only
  const canInstall = accepted && (!needsTyped || typed === skill.id) && !acting;
  const consent = { accepted: true, ...(needsTyped ? { typed } : {}) };

  return (
    <div className="wiz-overlay" onClick={onClose}>
      <div className="wiz skill-review" onClick={(e) => e.stopPropagation()}>
        <div className="wiz-head">
          <h3>Review &amp; install — {skill.name}</h3>
          <button className="wiz-x" onClick={onClose}>
            ✕
          </button>
        </div>

        {scanErr && (
          <div className="wiz-error">
            {isMarketplace ? "fetch / verify" : "scan"} failed: {scanErr}
          </div>
        )}
        {!scan && !scanErr && (
          <div className="wiz-validating">
            {isMarketplace ? "Fetching + verifying skill…" : "Scanning skill…"}
          </div>
        )}

        {scan && (
          <>
            <div className="skill-review-head">
              <span className={`risk-badge ${scan.riskClass}`}>
                {RISK_LABEL[scan.riskClass] || scan.riskClass}
              </span>
              <span className="skill-review-meta">
                {scan.counts.high} high-severity of {scan.counts.total} findings ·{" "}
                {scan.counts.code_files} code file{scan.counts.code_files === 1 ? "" : "s"}
              </span>
            </div>
            {isMarketplace ? (
              <p className="wiz-note">
                This skill is <strong>marketplace · official</strong> (Anthropic's
                <code>claude-plugins-official</code> directory). It was fetched at a pinned commit
                and byte-verified against the catalog. The scan below is <strong>advisory</strong> —
                review it, then install.
              </p>
            ) : (
              <p className="wiz-note">
                This skill is <strong>community · unverified</strong> with no first-party
                provenance. The scan below is <strong>advisory</strong> — it can miss obfuscated
                behavior. Install only if you trust the source.
              </p>
            )}

            <div className="skill-findings">
              {scan.findings.length === 0 ? (
                <p className="skill-finding ok">No findings — instructions only, no code.</p>
              ) : (
                scan.findings.map((f, i) => (
                  <div key={i} className={`skill-finding ${f.severity}`}>
                    <span className="skill-finding-loc">
                      {f.file}:{f.line}
                    </span>
                    <span className="skill-finding-rule">{f.rule}</span>
                    <code className="skill-finding-snip">{f.snippet}</code>
                  </div>
                ))
              )}
            </div>

            <label className="skill-consent">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                {isMarketplace
                  ? "I reviewed the findings and want to install this marketplace skill."
                  : "I reviewed the findings and accept the risk of installing this unverified skill."}
              </span>
            </label>
            {needsTyped && (
              <div className="skill-typed">
                <p className="wiz-note skill-typed-warn">
                  ⚠ This skill scanned <strong>HIGH risk</strong>. Type
                  <code>{skill.id}</code> to confirm.
                </p>
                <input
                  className="wiz-text"
                  placeholder={skill.id}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            )}

            {rowErr && <div className="wiz-error">{rowErr}</div>}
            <div className="wiz-done-actions">
              <button className="wiz-go" disabled={!canInstall} onClick={() => onInstall(consent)}>
                {acting ? "Installing…" : isMarketplace ? "Install" : "Install anyway"}
              </button>
              <button className="wiz-secondary" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ReviewPanel() {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setOutput("");
    try {
      const res = await fetch(`/api/review?token=${token}`);
      if (!res.ok) throw new Error(`review failed (${res.status})`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPlan(data);
      // default: select every pushable (new + modified) file
      const all = [...(data.items.new || []), ...(data.items.modified || [])].map((i) => i.rel);
      setSelected(new Set(all));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (rel) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });

  const push = async (dryRun) => {
    setBusy(true);
    setOutput("");
    try {
      const res = await fetch(`/api/push?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [...selected], dryRun }),
      });
      const data = await res.json();
      setOutput(data.output || data.error || "(no output)");
      if (!dryRun && data.ok) load(); // refresh status after a real push
    } catch (e) {
      setOutput(`error: ${e.message}`);
    }
    setBusy(false);
  };

  if (error)
    return (
      <div className="review">
        <div className="msg meta error">error: {error}</div>
        <button className="rev-btn" onClick={load}>
          Retry
        </button>
      </div>
    );
  if (!plan)
    return (
      <div className="review">
        <div className="empty">
          <p>loading status…</p>
        </div>
      </div>
    );

  const pushable = [
    ...(plan.items.new || []).map((i) => ({ ...i, state: "new" })),
    ...(plan.items.modified || []).map((i) => ({ ...i, state: "modified" })),
  ];

  return (
    <div className="review">
      <div className="rev-head">
        <span>
          {plan.project} → {plan.brain_url || "offline"}
        </span>
        <span className="rev-actions">
          <button className="rev-btn" onClick={load} disabled={busy}>
            Refresh
          </button>
          <button className="rev-btn" onClick={() => push(true)} disabled={busy || !selected.size}>
            Dry-run
          </button>
          <button
            className="rev-btn primary"
            onClick={() => push(false)}
            disabled={busy || !selected.size}
          >
            Push {selected.size} selected
          </button>
        </span>
      </div>

      {pushable.length === 0 ? (
        <div className="empty">
          <p>Nothing to push — all eligible files are clean.</p>
        </div>
      ) : (
        <ul className="rev-list">
          {pushable.map((i) => (
            <li key={i.rel} className="rev-item">
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(i.rel)}
                  onChange={() => toggle(i.rel)}
                />
                <span className="rev-path">{i.rel}</span>
                <span className="rev-tags">
                  [{i.kind}, {i.tier}] {i.state === "new" ? "NEW" : "MOD"}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {plan.items.blocked?.length > 0 && (
        <div className="rev-blocked">
          <div className="rev-blocked-head">blocked ({plan.items.blocked.length}) — never sync</div>
          {plan.items.blocked.map((b) => (
            <div key={b.rel} className="rev-blocked-item">
              {b.rel} — {b.reason}
            </div>
          ))}
        </div>
      )}

      <div className="rev-clean">clean (already synced): {plan.items.clean?.length || 0}</div>
      {output && <pre className="rev-output">{output}</pre>}
    </div>
  );
}

const SUGGESTED = {
  notion: "Summarize my most recent Notion page.",
  granola: "Pull my recent Granola meeting notes into the inbox.",
  slack: "Catch me up on my unread Slack messages.",
  jira: "Show me the Jira issues assigned to me.",
  linear: "List my open Linear issues for this cycle.",
  firecrawl: "Read this page and pull out the key facts: <url>",
};


export function IntegrationsPanel({ onTryInChat }) {
  const [connectors, setConnectors] = useState(null);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(null); // connector being connected

  const load = useCallback(async () => {
    setError(null);
    try {
      // /api/blueprint refreshes the team's tool set then returns team-aware connectors;
      // fall back to /api/connectors if the brain isn't reachable.
      let res = await fetch(`/api/blueprint?token=${token}`);
      let data = res.ok ? await res.json() : null;
      if (!data || !data.connectors) {
        res = await fetch(`/api/connectors?token=${token}`);
        data = await res.json();
      }
      setConnectors(data.connectors || []);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error)
    return (
      <div className="integrations">
        <div className="msg meta error">error: {error}</div>
      </div>
    );
  if (!connectors)
    return (
      <div className="integrations">
        <div className="empty">
          <p>loading integrations…</p>
        </div>
      </div>
    );

  const wired = connectors.filter((c) => c.status === "wired").length;
  const team = connectors.filter((c) => c.team_enabled);
  const rest = connectors.filter((c) => !c.team_enabled);
  const showTeam = team.length > 0;

  const card = (c) => (
    <div key={c.id} className={`int-card${c.status === "wired" ? " wired" : ""}`}>
      <div className="int-card-top">
        <span className="int-name">{c.name}</span>
        <span className={`int-status ${c.status}`}>
          {c.status === "wired" ? "● connected" : "○ available"}
        </span>
      </div>
      <p className="int-summary">{c.summary}</p>
      <div className="int-card-foot">
        <span className="int-transport">
          {c.transport === "skill" ? "direct API skill" : "MCP"}
        </span>
        <button className="int-connect" onClick={() => setActive(c)}>
          {c.status === "wired" ? "Reconnect" : "Connect →"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="integrations">
      <div className="int-head">
        <div>
          <h2>Integrations</h2>
          <p className="int-sub">
            Connect your tools. We hand you the exact key page, check the key live, and lock it on
            this machine.
          </p>
        </div>
        <div className="int-progress">
          {wired} of {connectors.length} connected
        </div>
      </div>

      {showTeam && (
        <>
          <h3 className="int-section">
            Your team uses these {team.length} tool{team.length === 1 ? "" : "s"}
          </h3>
          <div className="int-grid">{team.map(card)}</div>
          <h3 className="int-section int-section-muted">More integrations</h3>
        </>
      )}
      <div className="int-grid">{(showTeam ? rest : connectors).map(card)}</div>
      <p className="int-foot">
        🔒 Every key is encrypted on this machine (dotenvx) and never sent to the team brain.
      </p>

      {active && (
        <ConnectWizard
          connector={active}
          onClose={() => setActive(null)}
          onConnected={() => {
            load();
          }}
          onTryInChat={onTryInChat}
        />
      )}
    </div>
  );
}

export function ConnectWizard({ connector, onClose, onConnected, onTryInChat }) {
  // Pre-fill any field the team blueprint already set (e.g. the Jira site URL).
  const [secrets, setSecrets] = useState(() => {
    const init = {};
    for (const s of connector.secrets || []) {
      if (connector.instance && connector.instance[s.env]) init[s.env] = connector.instance[s.env];
    }
    return init;
  });
  const [reveal, setReveal] = useState({});
  const [phase, setPhase] = useState("collect"); // collect | validating | done | error
  const [result, setResult] = useState(null);
  const required = (connector.secrets || []).filter((s) => s.required);
  const filled = required.every((s) => (secrets[s.env] || "").trim());

  const connect = async () => {
    setPhase("validating");
    setResult(null);
    try {
      const vRes = await fetch(`/api/connectors/${connector.id}/store?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets }),
      });
      const data = await vRes.json();
      if (vRes.ok && data.ok) {
        setResult(data);
        setPhase("done");
        onConnected();
      } else {
        setResult(data.validation || data);
        setPhase("error");
      }
    } catch (e) {
      setResult({ error: e.message, checks: [] });
      setPhase("error");
    }
  };

  const checks = result?.checks || result?.validation?.checks || [];

  return (
    <div className="wiz-overlay" onClick={onClose}>
      <div className="wiz" onClick={(e) => e.stopPropagation()}>
        <div className="wiz-head">
          <span>Connect {connector.name}</span>
          <button className="wiz-x" onClick={onClose}>
            ✕
          </button>
        </div>

        {phase !== "done" && (
          <>
            <div className="wiz-step">
              <div className="wiz-step-n">1 · Get your key</div>
              {connector.docs?.token_create_url ? (
                <a
                  className="wiz-link"
                  href={connector.docs.token_create_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open {connector.name} to create a key →
                </a>
              ) : (
                <div className="wiz-inapp">Created in the {connector.name} app (no web page).</div>
              )}
              {connector.docs?.instructions && (
                <p className="wiz-note">{connector.docs.instructions}</p>
              )}
              {connector.scopes?.length > 0 && (
                <p className="wiz-scopes">
                  Give it these scopes: <strong>{connector.scopes.join(" · ")}</strong>
                </p>
              )}
            </div>

            <div className="wiz-step">
              <div className="wiz-step-n">2 · Paste &amp; check</div>
              {required.map((s) => (
                <div key={s.env} className="wiz-field">
                  <label>{s.label}</label>
                  <div className="wiz-input">
                    <input
                      type={reveal[s.env] ? "text" : "password"}
                      placeholder={s.placeholder || s.env}
                      value={secrets[s.env] || ""}
                      onChange={(e) => setSecrets({ ...secrets, [s.env]: e.target.value })}
                      autoComplete="off"
                      spellCheck="false"
                    />
                    <button
                      className="wiz-eye"
                      onClick={() => setReveal({ ...reveal, [s.env]: !reveal[s.env] })}
                    >
                      👁
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {phase === "validating" && <div className="wiz-validating">Checking it live…</div>}
            {checks.length > 0 && (
              <ul className="wiz-checks">
                {checks.map((ch, i) => (
                  <li key={i} className={ch.ok ? "ok" : "bad"}>
                    {ch.ok ? "✓" : "✗"} {ch.name} <span>— {ch.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            {phase === "error" && (
              <div className="wiz-error">
                Couldn’t connect{result?.error ? ` (${result.error})` : ""}.
                {connector.docs?.token_create_url && (
                  <a href={connector.docs.token_create_url} target="_blank" rel="noreferrer">
                    {" "}
                    Create a fresh key →
                  </a>
                )}
              </div>
            )}

            <button
              className="wiz-go"
              disabled={!filled || phase === "validating"}
              onClick={connect}
            >
              {phase === "validating" ? "Checking…" : "Connect"}
            </button>
          </>
        )}

        {phase === "done" && (
          <div className="wiz-done">
            <div className="wiz-done-badge">✓ Connected</div>
            <p>
              Connected to <strong>{connector.name}</strong>
              {result?.identity?.value ? (
                <>
                  {" "}
                  as <strong>{result.identity.value}</strong>
                </>
              ) : null}
              {result?.instance?.value ? (
                <>
                  {" "}
                  in <strong>{result.instance.value}</strong>
                </>
              ) : null}
              .
            </p>
            <p className="wiz-note">
              Your key is encrypted on this machine.{" "}
              {connector.transport === "skill"
                ? "A skill was installed to use it."
                : "An MCP server was wired up."}
            </p>
            <div className="wiz-done-actions">
              <button
                className="wiz-go"
                onClick={() =>
                  onTryInChat(
                    SUGGESTED[connector.id] || `Use ${connector.name} to help me with a task.`
                  )
                }
              >
                Try it in chat →
              </button>
              <button className="wiz-secondary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Deferred: not routed in v1 (kept for later).
export function TeamPanel() {
  const [connectors, setConnectors] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [inst, setInst] = useState({}); // {id: {env: value}}
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [hint, setHint] = useState(null);

  const load = useCallback(async () => {
    setOutput("");
    try {
      const res = await fetch(`/api/blueprint?token=${token}`);
      const data = await res.json();
      const list = data.connectors || [];
      setConnectors(list);
      setSel(new Set(list.filter((c) => c.team_enabled).map((c) => c.id)));
      const iv = {};
      for (const c of list)
        for (const f of c.team_instance || []) {
          const v = c.instance?.[f.env];
          if (v) (iv[c.id] ||= {})[f.env] = v;
        }
      setInst(iv);
      setHint(
        data.ok
          ? null
          : "Connect this workspace to the brain (set AIOS_API_KEY + team_id) to publish for your team."
      );
    } catch (e) {
      setHint(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const toggle = (id) =>
    setSel((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const setField = (id, env, val) =>
    setInst((p) => ({ ...p, [id]: { ...(p[id] || {}), [env]: val } }));

  const publish = async () => {
    setBusy(true);
    setOutput("");
    const payload = {};
    for (const c of connectors)
      if (sel.has(c.id)) {
        payload[c.id] = {
          enabled: true,
          name: c.name,
          transport: c.transport,
          instance: inst[c.id] || {},
        };
      }
    try {
      const res = await fetch(`/api/blueprint/publish?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectors: payload }),
      });
      const data = await res.json();
      setOutput(data.output || data.error || "(no output)");
      if (data.ok) load();
    } catch (e) {
      setOutput(`error: ${e.message}`);
    }
    setBusy(false);
  };

  if (!connectors)
    return (
      <div className="integrations">
        <div className="empty">
          <p>loading team tools…</p>
        </div>
      </div>
    );

  return (
    <div className="integrations">
      <div className="int-head">
        <div>
          <h2>Team</h2>
          <p className="int-sub">
            Pick the tools your team uses and publish them once. Everyone gets a guided checklist —
            each person still supplies their own keys.
          </p>
        </div>
        <button className="int-connect" disabled={busy || !sel.size} onClick={publish}>
          {busy ? "Publishing…" : `Publish ${sel.size} to team`}
        </button>
      </div>
      {hint && <p className="msg meta">{hint}</p>}

      <div className="int-grid">
        {connectors.map((c) => (
          <div key={c.id} className={`int-card${sel.has(c.id) ? " wired" : ""}`}>
            <label className="team-row">
              <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="int-name">{c.name}</span>
              <span className="int-transport">
                {c.transport === "skill" ? "direct API" : "MCP"}
              </span>
            </label>
            <p className="int-summary">{c.summary}</p>
            {sel.has(c.id) &&
              (c.team_instance || []).map((f) => (
                <div key={f.env} className="wiz-field">
                  <label>{f.label}</label>
                  <div className="wiz-input">
                    <input
                      type="text"
                      placeholder={f.placeholder || f.env}
                      value={(inst[c.id] || {})[f.env] || ""}
                      onChange={(e) => setField(c.id, f.env, e.target.value)}
                    />
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
      {output && <pre className="rev-output">{output}</pre>}
      <p className="int-foot">
        🔒 The blueprint carries only which tools + shared URLs — never anyone's keys.
      </p>
    </div>
  );
}
