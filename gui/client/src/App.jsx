import React, { useEffect, useRef, useState, useCallback } from "react";

/**
 * Minimal local cockpit for an aios-workspace repo.
 * One WebSocket = one Claude Agent SDK session with the repo as cwd —
 * skills, rules, and the guard hook fire exactly as in Claude Code.
 */

const token = new URLSearchParams(window.location.search).get("token") || "";

export default function App() {
  const [repo, setRepo] = useState("");
  const [view, setView] = useState("chat"); // "chat" | "review" | "integrations" | "team"
  const [role, setRole] = useState(null); // brain member role; only lead/admin see Team
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState([]); // {kind, ...}
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState([]); // pending approval requests
  const wsRef = useRef(null);
  const bottomRef = useRef(null);

  // Who am I? Only a brain lead/admin sees the Team (publish) surface.
  useEffect(() => {
    fetch(`/api/me?token=${token}`)
      .then((r) => r.json())
      .then((d) => setRole(d.me?.role || null))
      .catch(() => {});
  }, []);

  const append = useCallback((m) => setMessages((prev) => [...prev, m]), []);

  // Update or create the streaming assistant message
  const appendDelta = useCallback((text) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { kind: "assistant", text, streaming: true }];
    });
  }, []);

  const finishAssistant = useCallback(() => {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === prev.length - 1 && m.kind === "assistant"
          ? { ...m, streaming: false }
          : m
      )
    );
  }, []);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${token}`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.type) {
        case "hello": setRepo(msg.repo); break;
        case "echo_user": break; // already rendered optimistically
        case "delta": appendDelta(msg.text); break;
        case "assistant_done": finishAssistant(); break;
        case "tool_use":
          append({ kind: "tool", name: msg.name, input: msg.input, id: msg.id, result: null });
          break;
        case "tool_result":
          setMessages((prev) =>
            prev.map((m) =>
              m.kind === "tool" && m.id === msg.id
                ? { ...m, result: msg.text, isError: msg.is_error }
                : m
            )
          );
          break;
        case "permission_request":
          setPermissions((prev) => [...prev, msg]);
          break;
        case "result":
          setBusy(false);
          append({ kind: "meta", text: `turn done${typeof msg.cost_usd === "number" ? ` · $${msg.cost_usd.toFixed(4)}` : ""}` });
          break;
        case "error":
          setBusy(false);
          append({ kind: "meta", text: `error: ${msg.message}`, error: true });
          break;
        default: break;
      }
    };
    return () => ws.close();
  }, [append, appendDelta, finishAssistant]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, permissions]);

  const sendMessage = (override) => {
    const text = (typeof override === "string" ? override : input).trim();
    if (!text || !connected) return;
    append({ kind: "user", text });
    wsRef.current?.send(JSON.stringify({ type: "user_message", text }));
    setInput("");
    setBusy(true);
  };

  const respondPermission = (id, allow) => {
    wsRef.current?.send(JSON.stringify({ type: "permission_response", id, allow }));
    setPermissions((prev) => prev.filter((p) => p.id !== id));
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          AIOS Workspace
          <span className="brand-status" data-on={connected} title={connected ? "Connected" : "Connecting…"} />
        </div>
        <nav className="side-nav">
          <button className={`side-link${view === "chat" ? " on" : ""}`} onClick={() => setView("chat")}>{NAV_ICONS.chat} Chat</button>
          <button className={`side-link${view === "integrations" ? " on" : ""}`} onClick={() => setView("integrations")}>{NAV_ICONS.integrations} Integrations</button>
          <button className={`side-link${view === "review" ? " on" : ""}`} onClick={() => setView("review")}>{NAV_ICONS.review} Review &amp; Push</button>
          {(role === "admin" || role === "lead") && (
            <button className={`side-link${view === "team" ? " on" : ""}`} onClick={() => setView("team")}>{NAV_ICONS.team} Team</button>
          )}
        </nav>
        <div className="side-foot">
          <div className="privacy" title="Your keys are encrypted on this machine and never sent to the team brain.">🔒 Keys stay on this machine</div>
          <div className="repo" title={repo}>{repo}</div>
        </div>
      </aside>

      <div className="app-main">
      {view === "review" && <ReviewPanel />}
      {view === "team" && <TeamPanel />}
      {view === "integrations" && (
        <IntegrationsPanel onTryInChat={(prompt) => { setView("chat"); setInput(prompt); }} />
      )}

      {view === "chat" && (
      <>
      <main>
        {messages.length === 0 && (
          <div className="empty">
            <p>Welcome to your workspace. Start by letting the agent learn who you are.</p>
            <button
              className="empty-cta"
              disabled={!connected}
              onClick={() => sendMessage("Set me up — interview me about who I am and what I'm working on, then update my profile in .claude/CLAUDE.md.")}
            >
              ✨ Set up your profile
            </button>
            <p className="empty-sub">…or just chat. Skills, rules, and the guard hook are live —
              try <em>"what changed this week?"</em> or connect a tool in <em>Integrations</em>.</p>
          </div>
        )}
        {messages.map((m, i) => {
          if (m.kind === "user") return <div key={i} className="msg user">{m.text}</div>;
          if (m.kind === "assistant")
            return <div key={i} className={`msg assistant${m.streaming ? " streaming" : ""}`}>{m.text}</div>;
          if (m.kind === "tool") return <ToolCard key={i} tool={m} />;
          return <div key={i} className={`msg meta${m.error ? " error" : ""}`}>{m.text}</div>;
        })}
        {permissions.map((p) => (
          <div key={p.id} className="permission">
            <div className="perm-head">
              Approve <strong>{p.tool}</strong>?
            </div>
            <pre>{JSON.stringify(p.input, null, 2).slice(0, 1200)}</pre>
            <div className="perm-actions">
              <button className="allow" onClick={() => respondPermission(p.id, true)}>Allow</button>
              <button className="deny" onClick={() => respondPermission(p.id, false)}>Deny</button>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </main>

      <footer>
        <textarea
          value={input}
          placeholder={connected ? "Message your repo… (Enter to send, Shift+Enter for newline)" : "connecting…"}
          disabled={!connected}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
        />
        <button onClick={sendMessage} disabled={!connected || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </footer>
      </>
      )}
      </div>
    </div>
  );
}

const NAV_ICONS = {
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  integrations: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  review: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V6M5 13l7-7 7 7" />
    </svg>
  ),
  team: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
};

function ReviewPanel() {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null); setOutput("");
    try {
      const res = await fetch(`/api/review?token=${token}`);
      if (!res.ok) throw new Error(`review failed (${res.status})`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPlan(data);
      // default: select every pushable (new + modified) file
      const all = [...(data.items.new || []), ...(data.items.modified || [])].map((i) => i.rel);
      setSelected(new Set(all));
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (rel) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(rel)) next.delete(rel); else next.add(rel);
    return next;
  });

  const push = async (dryRun) => {
    setBusy(true); setOutput("");
    try {
      const res = await fetch(`/api/push?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [...selected], dryRun }),
      });
      const data = await res.json();
      setOutput(data.output || data.error || "(no output)");
      if (!dryRun && data.ok) load(); // refresh status after a real push
    } catch (e) { setOutput(`error: ${e.message}`); }
    setBusy(false);
  };

  if (error) return <div className="review"><div className="msg meta error">error: {error}</div><button className="rev-btn" onClick={load}>Retry</button></div>;
  if (!plan) return <div className="review"><div className="empty"><p>loading status…</p></div></div>;

  const pushable = [...(plan.items.new || []).map((i) => ({ ...i, state: "new" })),
                    ...(plan.items.modified || []).map((i) => ({ ...i, state: "modified" }))];

  return (
    <div className="review">
      <div className="rev-head">
        <span>{plan.project} → {plan.brain_url || "offline"}</span>
        <span className="rev-actions">
          <button className="rev-btn" onClick={load} disabled={busy}>Refresh</button>
          <button className="rev-btn" onClick={() => push(true)} disabled={busy || !selected.size}>Dry-run</button>
          <button className="rev-btn primary" onClick={() => push(false)} disabled={busy || !selected.size}>
            Push {selected.size} selected
          </button>
        </span>
      </div>

      {pushable.length === 0 ? (
        <div className="empty"><p>Nothing to push — all eligible files are clean.</p></div>
      ) : (
        <ul className="rev-list">
          {pushable.map((i) => (
            <li key={i.rel} className="rev-item">
              <label>
                <input type="checkbox" checked={selected.has(i.rel)} onChange={() => toggle(i.rel)} />
                <span className="rev-path">{i.rel}</span>
                <span className="rev-tags">[{i.kind}, {i.tier}] {i.state === "new" ? "NEW" : "MOD"}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {plan.items.blocked?.length > 0 && (
        <div className="rev-blocked">
          <div className="rev-blocked-head">blocked ({plan.items.blocked.length}) — never sync</div>
          {plan.items.blocked.map((b) => (
            <div key={b.rel} className="rev-blocked-item">{b.rel} — {b.reason}</div>
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
};

function IntegrationsPanel({ onTryInChat }) {
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
      if (!data || !data.connectors) { res = await fetch(`/api/connectors?token=${token}`); data = await res.json(); }
      setConnectors(data.connectors || []);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="integrations"><div className="msg meta error">error: {error}</div></div>;
  if (!connectors) return <div className="integrations"><div className="empty"><p>loading integrations…</p></div></div>;

  const wired = connectors.filter((c) => c.status === "wired").length;
  const team = connectors.filter((c) => c.team_enabled);
  const rest = connectors.filter((c) => !c.team_enabled);
  const showTeam = team.length > 0;

  const card = (c) => (
    <div key={c.id} className={`int-card${c.status === "wired" ? " wired" : ""}`}>
      <div className="int-card-top">
        <span className="int-name">{c.name}</span>
        <span className={`int-status ${c.status}`}>{c.status === "wired" ? "● connected" : "○ available"}</span>
      </div>
      <p className="int-summary">{c.summary}</p>
      <div className="int-card-foot">
        <span className="int-transport">{c.transport === "skill" ? "direct API skill" : "MCP"}</span>
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
          <p className="int-sub">Connect your tools. We hand you the exact key page, check the key live, and lock it on this machine.</p>
        </div>
        <div className="int-progress">{wired} of {connectors.length} connected</div>
      </div>

      {showTeam && (
        <>
          <h3 className="int-section">Your team uses these {team.length} tool{team.length === 1 ? "" : "s"}</h3>
          <div className="int-grid">{team.map(card)}</div>
          <h3 className="int-section int-section-muted">More integrations</h3>
        </>
      )}
      <div className="int-grid">{(showTeam ? rest : connectors).map(card)}</div>
      <p className="int-foot">🔒 Every key is encrypted on this machine (dotenvx) and never sent to the team brain.</p>

      {active && (
        <ConnectWizard
          connector={active}
          onClose={() => setActive(null)}
          onConnected={() => { load(); }}
          onTryInChat={onTryInChat}
        />
      )}
    </div>
  );
}

function ConnectWizard({ connector, onClose, onConnected, onTryInChat }) {
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
    setPhase("validating"); setResult(null);
    try {
      const vRes = await fetch(`/api/connectors/${connector.id}/store?token=${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets }),
      });
      const data = await vRes.json();
      if (vRes.ok && data.ok) { setResult(data); setPhase("done"); onConnected(); }
      else { setResult(data.validation || data); setPhase("error"); }
    } catch (e) { setResult({ error: e.message, checks: [] }); setPhase("error"); }
  };

  const checks = result?.checks || result?.validation?.checks || [];

  return (
    <div className="wiz-overlay" onClick={onClose}>
      <div className="wiz" onClick={(e) => e.stopPropagation()}>
        <div className="wiz-head">
          <span>Connect {connector.name}</span>
          <button className="wiz-x" onClick={onClose}>✕</button>
        </div>

        {phase !== "done" && (
          <>
            <div className="wiz-step">
              <div className="wiz-step-n">1 · Get your key</div>
              {connector.docs?.token_create_url ? (
                <a className="wiz-link" href={connector.docs.token_create_url} target="_blank" rel="noreferrer">
                  Open {connector.name} to create a key →
                </a>
              ) : (
                <div className="wiz-inapp">Created in the {connector.name} app (no web page).</div>
              )}
              {connector.docs?.instructions && <p className="wiz-note">{connector.docs.instructions}</p>}
              {connector.scopes?.length > 0 && (
                <p className="wiz-scopes">Give it these scopes: <strong>{connector.scopes.join(" · ")}</strong></p>
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
                      autoComplete="off" spellCheck="false"
                    />
                    <button className="wiz-eye" onClick={() => setReveal({ ...reveal, [s.env]: !reveal[s.env] })}>👁</button>
                  </div>
                </div>
              ))}
            </div>

            {phase === "validating" && <div className="wiz-validating">Checking it live…</div>}
            {checks.length > 0 && (
              <ul className="wiz-checks">
                {checks.map((ch, i) => (
                  <li key={i} className={ch.ok ? "ok" : "bad"}>{ch.ok ? "✓" : "✗"} {ch.name} <span>— {ch.detail}</span></li>
                ))}
              </ul>
            )}
            {phase === "error" && (
              <div className="wiz-error">
                Couldn’t connect{result?.error ? ` (${result.error})` : ""}.
                {connector.docs?.token_create_url && (
                  <a href={connector.docs.token_create_url} target="_blank" rel="noreferrer"> Create a fresh key →</a>
                )}
              </div>
            )}

            <button className="wiz-go" disabled={!filled || phase === "validating"} onClick={connect}>
              {phase === "validating" ? "Checking…" : "Connect"}
            </button>
          </>
        )}

        {phase === "done" && (
          <div className="wiz-done">
            <div className="wiz-done-badge">✓ Connected</div>
            <p>
              Connected to <strong>{connector.name}</strong>
              {result?.identity?.value ? <> as <strong>{result.identity.value}</strong></> : null}
              {result?.instance?.value ? <> in <strong>{result.instance.value}</strong></> : null}.
            </p>
            <p className="wiz-note">Your key is encrypted on this machine. {connector.transport === "skill" ? "A skill was installed to use it." : "An MCP server was wired up."}</p>
            <div className="wiz-done-actions">
              <button className="wiz-go" onClick={() => onTryInChat(SUGGESTED[connector.id] || `Use ${connector.name} to help me with a task.`)}>
                Try it in chat →
              </button>
              <button className="wiz-secondary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TeamPanel() {
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
      for (const c of list) for (const f of c.team_instance || []) { const v = c.instance?.[f.env]; if (v) (iv[c.id] ||= {})[f.env] = v; }
      setInst(iv);
      setHint(data.ok ? null : "Connect this workspace to the brain (set AIOS_API_KEY + team_id) to publish for your team.");
    } catch (e) { setHint(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = (id) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setField = (id, env, val) => setInst((p) => ({ ...p, [id]: { ...(p[id] || {}), [env]: val } }));

  const publish = async () => {
    setBusy(true); setOutput("");
    const payload = {};
    for (const c of connectors) if (sel.has(c.id)) {
      payload[c.id] = { enabled: true, name: c.name, transport: c.transport, instance: inst[c.id] || {} };
    }
    try {
      const res = await fetch(`/api/blueprint/publish?token=${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectors: payload }),
      });
      const data = await res.json();
      setOutput(data.output || data.error || "(no output)");
      if (data.ok) load();
    } catch (e) { setOutput(`error: ${e.message}`); }
    setBusy(false);
  };

  if (!connectors) return <div className="integrations"><div className="empty"><p>loading team tools…</p></div></div>;

  return (
    <div className="integrations">
      <div className="int-head">
        <div>
          <h2>Team</h2>
          <p className="int-sub">Pick the tools your team uses and publish them once. Everyone gets a guided
            checklist — each person still supplies their own keys.</p>
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
              <span className="int-transport">{c.transport === "skill" ? "direct API" : "MCP"}</span>
            </label>
            <p className="int-summary">{c.summary}</p>
            {sel.has(c.id) && (c.team_instance || []).map((f) => (
              <div key={f.env} className="wiz-field">
                <label>{f.label}</label>
                <div className="wiz-input">
                  <input type="text" placeholder={f.placeholder || f.env}
                    value={(inst[c.id] || {})[f.env] || ""}
                    onChange={(e) => setField(c.id, f.env, e.target.value)} />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {output && <pre className="rev-output">{output}</pre>}
      <p className="int-foot">🔒 The blueprint carries only which tools + shared URLs — never anyone's keys.</p>
    </div>
  );
}

function ToolCard({ tool }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeInput(tool.name, tool.input);
  return (
    <div className={`tool${tool.isError ? " tool-error" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-summary">{summary}</span>
        <span className="tool-state">{tool.result === null ? "running" : tool.isError ? "error" : "done"}</span>
      </button>
      {open && (
        <div className="tool-body">
          <pre>{JSON.stringify(tool.input, null, 2).slice(0, 2000)}</pre>
          {tool.result != null && <pre className="tool-result">{tool.result}</pre>}
        </div>
      )}
    </div>
  );
}

function summarizeInput(name, input) {
  if (!input) return "";
  if (input.file_path) return input.file_path;
  if (input.command) return String(input.command).slice(0, 80);
  if (input.pattern) return input.pattern;
  if (input.skill) return input.skill;
  const s = JSON.stringify(input);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}
