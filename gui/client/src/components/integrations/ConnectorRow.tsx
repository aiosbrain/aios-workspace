import { Button } from "@aios-alpha/ui";
import type { Connector } from "../../types/protocol";
import { ConnectorLogo } from "./ConnectorLogo";

/**
 * One integration as a compact row: brand logo, name + transport, a one-line
 * summary, a subtle status dot, and a right-aligned Connect/Manage action.
 * Dense by design — two of these sit side-by-side on wide widths.
 */
export function ConnectorRow({
  connector,
  onConnect,
}: {
  connector: Connector;
  onConnect: (connector: Connector) => void;
}) {
  const wired = connector.status === "wired";
  const transport = connector.transport === "skill" ? "Direct API" : "MCP";

  return (
    <div
      className={`group flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors ${
        wired ? "border-accent/30" : "border-border hover:border-border-strong"
      }`}
    >
      <ConnectorLogo id={connector.id} name={connector.name} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              wired ? "bg-lime" : "bg-muted-foreground/40"
            }`}
            title={wired ? "Connected" : "Available"}
          />
          <span className="truncate text-sm font-medium leading-tight text-card-foreground">
            {connector.name}
          </span>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {transport}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs leading-snug text-muted-foreground">
          {connector.summary}
        </p>
      </div>

      <Button
        variant={wired ? "ghost" : "secondary"}
        size="sm"
        className="shrink-0"
        onClick={() => onConnect(connector)}
      >
        {wired ? "Manage" : "Connect"}
      </Button>
    </div>
  );
}
