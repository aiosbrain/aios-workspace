import React, { useEffect, useRef, useState, useCallback } from "react";

/**
 * Minimal local cockpit for an aios-workspace repo.
 * One WebSocket = one Claude Agent SDK session with the repo as cwd —
 * skills, rules, and the guard hook fire exactly as in Claude Code.
 */

const token = new URLSearchParams(window.location.search).get("token") || "";

export default function App() {
  const [repo, setRepo] = useState("");
  const [view, setView] = useState("chat"); // "chat" | "review"
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState([]); // {kind, ...}
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState([]); // pending approval requests
  const wsRef = useRef(null);
  const bottomRef = useRef(null);

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

  const sendMessage = () => {
    const text = input.trim();
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
      <header>
        <div className="title">
          <span className="dot" data-on={connected} />
          AIOS Workspace
        </div>
        <nav className="tabs">
          <button className={view === "chat" ? "tab on" : "tab"} onClick={() => setView("chat")}>Chat</button>
          <button className={view === "review" ? "tab on" : "tab"} onClick={() => setView("review")}>Review &amp; push</button>
        </nav>
        <div className="repo" title={repo}>{repo}</div>
      </header>

      {view === "review" && <ReviewPanel />}

      {view === "chat" && (
      <>
      <main>
        {messages.length === 0 && (
          <div className="empty">
            <p>Chat with your team-ops repo. Skills, rules, and the guard
            hook are live — try <em>"run the aios-sync skill"</em> or
            <em> "what changed this week?"</em></p>
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
  );
}

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
