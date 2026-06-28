import { useEffect, useRef, useState } from "react";
import { useConnection } from "../../state/cockpit";
import { ApiError } from "../../lib/api";
import type {
  Connector,
  ConnectorStoreResponse,
  ConnectorValidation,
  OAuthStartResponse,
  OAuthStatusResponse,
} from "../../types/protocol";

const SUGGESTED: Record<string, string> = {
  notion: "Summarize my most recent Notion page.",
  granola: "Pull my recent Granola meeting notes into the inbox.",
  slack: "Catch me up on my unread Slack messages.",
  "slack-personal": "DM a teammate on Slack for me.",
  jira: "Show me the Jira issues assigned to me.",
  linear: "List my open Linear issues for this cycle.",
  firecrawl: "Read this page and pull out the key facts: <url>",
};

type Phase = "collect" | "validating" | "waiting" | "done" | "error";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Guided connect flow. Two shapes:
 *  - token: link to the key page → paste secrets → validate live → store (encrypted locally).
 *  - oauth (one-click): "Connect with Slack" → authorize in a new tab → poll the brain until the
 *    token lands (it is stored in the brain, never transits the GUI) → install the skill.
 * On success it offers a "Try it in chat" handoff.
 */
export function ConnectWizard({
  connector,
  onClose,
  onConnected,
  onTryInChat,
}: {
  connector: Connector;
  onClose: () => void;
  onConnected: () => void;
  onTryInChat: (prompt: string) => void;
}) {
  const { api } = useConnection();
  const oauth = connector.auth_mode === "oauth";
  // Pre-fill any field the team blueprint already set (e.g. the Jira site URL).
  const [secrets, setSecrets] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const s of connector.secrets || []) {
      if (connector.instance && connector.instance[s.env]) init[s.env] = connector.instance[s.env];
    }
    return init;
  });
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<Phase>("collect");
  const [result, setResult] = useState<ConnectorStoreResponse | ConnectorValidation | null>(null);
  const required = (connector.secrets || []).filter((s) => s.required);
  const filled = required.every((s) => (secrets[s.env] || "").trim());

  // Stop polling if the wizard is closed mid-flow.
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const connect = async () => {
    setPhase("validating");
    setResult(null);
    try {
      const data = await api.post<ConnectorStoreResponse>(`/api/connectors/${connector.id}/store`, {
        secrets,
      });
      setResult(data);
      setPhase("done");
      onConnected();
    } catch (e) {
      const body = (e instanceof ApiError ? e.body : null) as ConnectorStoreResponse | null;
      setResult(body?.validation || body || { ok: false, error: (e as Error).message, checks: [] });
      setPhase("error");
    }
  };

  // One-click OAuth: ask the brain for an authorize URL, open it, poll until connected, then store.
  const connectOAuth = async () => {
    setPhase("waiting");
    setResult(null);
    try {
      const start = await api.post<OAuthStartResponse>(`/api/connectors/${connector.id}/start`, {});
      if (!start.authorize_url) throw new Error(start.error || "couldn’t start sign-in");
      window.open(start.authorize_url, "_blank", "noopener,noreferrer");

      const deadline = Date.now() + 120000;
      for (;;) {
        if (cancelled.current) return;
        await sleep(2000);
        if (cancelled.current) return;
        const st = await api.get<OAuthStatusResponse>(`/api/connectors/${connector.id}/status`);
        if (st.connected) {
          const data = await api.post<ConnectorStoreResponse>(
            `/api/connectors/${connector.id}/store`,
            { secrets: {} }
          );
          setResult({
            ...data,
            identity:
              data.identity ??
              (st.slack_user_id ? { label: "You", value: st.slack_user_id } : null),
            instance:
              data.instance ?? (st.workspace ? { label: "Workspace", value: st.workspace } : null),
          });
          setPhase("done");
          onConnected();
          return;
        }
        if (Date.now() >= deadline) throw new Error("timed out waiting for authorization");
      }
    } catch (e) {
      if (cancelled.current) return;
      setResult({ ok: false, error: (e as Error).message, checks: [] });
      setPhase("error");
    }
  };

  const res = result as (ConnectorStoreResponse & ConnectorValidation) | null;
  const checks = res?.checks || res?.validation?.checks || [];

  return (
    <div className="wiz-overlay" onClick={onClose}>
      <div className="wiz" onClick={(e) => e.stopPropagation()}>
        <div className="wiz-head">
          <span>Connect {connector.name}</span>
          <button className="wiz-x" onClick={onClose}>
            ✕
          </button>
        </div>

        {phase !== "done" && oauth && (
          <>
            <div className="wiz-step">
              <div className="wiz-step-n">Authorize in your browser</div>
              <p className="wiz-note">
                Authorize AIOS in {connector.name}. Your token is stored securely in the team brain
                — it never touches this machine.
              </p>
              {(connector.scopes?.length ?? 0) > 0 && (
                <p className="wiz-scopes">
                  Permissions: <strong>{connector.scopes!.join(" · ")}</strong>
                </p>
              )}
            </div>

            {phase === "waiting" && (
              <div className="wiz-validating">Waiting for you to authorize in the new tab…</div>
            )}
            {phase === "error" && (
              <div className="wiz-error">
                Couldn’t connect{res?.error ? ` (${res.error})` : ""}.
              </div>
            )}

            <button className="wiz-go" disabled={phase === "waiting"} onClick={connectOAuth}>
              {phase === "waiting" ? "Waiting…" : `Connect with ${connector.name}`}
            </button>
          </>
        )}

        {phase !== "done" && !oauth && (
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
              {(connector.scopes?.length ?? 0) > 0 && (
                <p className="wiz-scopes">
                  Give it these scopes: <strong>{connector.scopes!.join(" · ")}</strong>
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
                Couldn’t connect{res?.error ? ` (${res.error})` : ""}.
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
              {res?.identity?.value ? (
                <>
                  {" "}
                  as <strong>{res.identity.value}</strong>
                </>
              ) : null}
              {res?.instance?.value ? (
                <>
                  {" "}
                  in <strong>{res.instance.value}</strong>
                </>
              ) : null}
              .
            </p>
            <p className="wiz-note">
              {oauth
                ? "Your token is stored in the team brain, not on this machine. "
                : "Your key is encrypted on this machine. "}
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
