import type { Connector } from "../../types/protocol";
import { ConnectorLogo } from "./ConnectorLogo";

/** One integration card: brand logo, connection status, transport, and a Connect/Reconnect action. */
export function ConnectorCard({
  connector,
  onConnect,
}: {
  connector: Connector;
  onConnect: (connector: Connector) => void;
}) {
  const wired = connector.status === "wired";
  return (
    <div
      className={`flex h-full flex-col gap-3 rounded-xl border bg-card p-4 shadow-card transition-colors ${
        wired ? "border-accent/40" : "border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        <ConnectorLogo id={connector.id} name={connector.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium leading-snug text-card-foreground">
              {connector.name}
            </span>
            <span
              className={`flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wide ${
                wired ? "text-accent" : "text-muted-foreground"
              }`}
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  wired ? "bg-accent" : "bg-muted-foreground/50"
                }`}
              />
              {wired ? "Connected" : "Available"}
            </span>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {connector.transport === "skill" ? "direct API skill" : "MCP"}
          </span>
        </div>
      </div>

      <p className="line-clamp-3 min-h-[3.6em] text-[12.5px] leading-[1.45] text-muted-foreground">
        {connector.summary}
      </p>

      <div className="mt-auto flex justify-end pt-1">
        <button className="int-connect" onClick={() => onConnect(connector)}>
          {wired ? "Reconnect" : "Connect →"}
        </button>
      </div>
    </div>
  );
}
