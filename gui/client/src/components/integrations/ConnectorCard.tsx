import type { Connector } from "../../types/protocol";

/** One integration card: shows connection status, transport, and a Connect/Reconnect action. */
export function ConnectorCard({
  connector,
  onConnect,
}: {
  connector: Connector;
  onConnect: (connector: Connector) => void;
}) {
  const wired = connector.status === "wired";
  return (
    <div className={`int-card${wired ? " wired" : ""}`}>
      <div className="int-card-top">
        <span className="int-name">{connector.name}</span>
        <span className={`int-status ${connector.status}`}>
          {wired ? "● connected" : "○ available"}
        </span>
      </div>
      <p className="int-summary">{connector.summary}</p>
      <div className="int-card-foot">
        <span className="int-transport">
          {connector.transport === "skill" ? "direct API skill" : "MCP"}
        </span>
        <button className="int-connect" onClick={() => onConnect(connector)}>
          {wired ? "Reconnect" : "Connect →"}
        </button>
      </div>
    </div>
  );
}
