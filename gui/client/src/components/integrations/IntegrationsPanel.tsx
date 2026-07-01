import { useCallback, useEffect, useMemo, useState } from "react";
import { Input, EyebrowLabel } from "@aios-alpha/ui";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { ConnectorRow } from "./ConnectorRow";
import { ConnectWizard } from "./ConnectWizard";
import {
  INTEGRATIONS_ROOT,
  INT_HEAD,
  INT_HEAD_H2,
  INT_SUB,
  INT_PROGRESS,
  INT_FOOT,
  META_ERROR,
} from "./intCard";
import type { BlueprintResponse, Connector, ConnectorsResponse } from "../../types/protocol";

// Two compact rows per row on wide widths; one when narrow.
const GRID = "grid gap-2 sm:grid-cols-2";

function matches(c: Connector, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return c.name.toLowerCase().includes(needle) || (c.summary || "").toLowerCase().includes(needle);
}

/** Eyebrow + count header that opens each section. */
function SectionHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-2 mt-5 flex items-baseline gap-2 first:mt-0">
      <EyebrowLabel>{label}</EyebrowLabel>
      <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
    </div>
  );
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
    [connectors, query]
  );

  if (error)
    return (
      <div className={INTEGRATIONS_ROOT}>
        <div className={META_ERROR}>error: {error}</div>
      </div>
    );

  const search = (
    <label className="relative block">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <Input
        type="search"
        placeholder="Search integrations by name or what they do…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="h-11 w-full pl-9 text-sm"
        disabled={!connectors}
      />
    </label>
  );

  if (!connectors)
    return (
      <div className={INTEGRATIONS_ROOT}>
        <div className={INT_HEAD}>
          <div>
            <h2 className={INT_HEAD_H2}>Integrations</h2>
            <p className={INT_SUB}>Loading your tools…</p>
          </div>
        </div>
        {search}
        <div className={GRID}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[60px] rounded-lg" />
          ))}
        </div>
      </div>
    );

  const installed = filtered.filter((c) => c.status === "wired");
  const available = filtered.filter((c) => c.status !== "wired");
  const wiredTotal = connectors.filter((c) => c.status === "wired").length;
  const noResults = filtered.length === 0;

  return (
    <div className={INTEGRATIONS_ROOT}>
      <div className={INT_HEAD}>
        <div>
          <h2 className={INT_HEAD_H2}>Integrations</h2>
          <p className={INT_SUB}>
            Connect your tools. We hand you the exact key page, check the key live, and lock it on
            this machine.
          </p>
        </div>
        <div className={INT_PROGRESS}>
          {wiredTotal} of {connectors.length} connected
        </div>
      </div>

      {search}

      {noResults && (
        <p className="mt-4 text-sm text-muted-foreground">
          No integrations match “{query}”. Try a different name.
        </p>
      )}

      {installed.length > 0 && (
        <section>
          <SectionHead label="Installed" count={installed.length} />
          <div className={GRID}>
            {installed.map((c) => (
              <ConnectorRow key={c.id} connector={c} onConnect={setActive} />
            ))}
          </div>
        </section>
      )}

      {available.length > 0 && (
        <section>
          <SectionHead label="Available" count={available.length} />
          <div className={GRID}>
            {available.map((c) => (
              <ConnectorRow key={c.id} connector={c} onConnect={setActive} />
            ))}
          </div>
        </section>
      )}

      <p className={INT_FOOT}>
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
