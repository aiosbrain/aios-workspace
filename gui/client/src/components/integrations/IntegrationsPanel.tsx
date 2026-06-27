import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "@aios-alpha/ui";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { ConnectorCard } from "./ConnectorCard";
import { ConnectWizard } from "./ConnectWizard";
import type {
  BlueprintResponse,
  Connector,
  ConnectorsResponse,
} from "../../types/protocol";

function matches(c: Connector, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return c.name.toLowerCase().includes(needle) || (c.summary || "").toLowerCase().includes(needle);
}

export function IntegrationsPanel({ onTryInChat }: { onTryInChat: (prompt: string) => void }) {
  const { api } = useConnection();
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Connector | null>(null); // connector being connected
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      // /api/blueprint refreshes the team's tool set then returns team-aware connectors;
      // fall back to /api/connectors if the brain isn't reachable.
      let data: BlueprintResponse | null = null;
      try {
        data = await api.get<BlueprintResponse>("/api/blueprint");
      } catch {
        data = null;
      }
      if (!data || !data.connectors) {
        const c = await api.get<ConnectorsResponse>("/api/connectors");
        setConnectors(c.connectors || []);
      } else {
        setConnectors(data.connectors || []);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () => (connectors || []).filter((c) => matches(c, query)),
    [connectors, query],
  );

  if (error)
    return (
      <div className="integrations">
        <div className="msg meta error">error: {error}</div>
      </div>
    );
  if (!connectors)
    return (
      <div className="integrations">
        <div className="int-head">
          <div>
            <h2>Integrations</h2>
            <p className="int-sub">Loading your tools…</p>
          </div>
        </div>
        <div className="int-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      </div>
    );

  const wired = connectors.filter((c) => c.status === "wired").length;
  const team = filtered.filter((c) => c.team_enabled);
  const rest = filtered.filter((c) => !c.team_enabled);
  const showTeam = team.length > 0;

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

      <Input
        type="search"
        placeholder="Filter integrations by name or description…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-4 max-w-md"
      />

      {showTeam && (
        <>
          <h3 className="int-section">
            Your team uses these {team.length} tool{team.length === 1 ? "" : "s"}
          </h3>
          <div className="int-grid">
            {team.map((c) => (
              <ConnectorCard key={c.id} connector={c} onConnect={setActive} />
            ))}
          </div>
          <h3 className="int-section int-section-muted">More integrations</h3>
        </>
      )}
      <div className="int-grid">
        {(showTeam ? rest : filtered).map((c) => (
          <ConnectorCard key={c.id} connector={c} onConnect={setActive} />
        ))}
      </div>
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
