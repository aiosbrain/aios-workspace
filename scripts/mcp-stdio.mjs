import { validateArgs } from "../packages/mcp-core/index.mjs";
const PROTOCOL_VERSION = "2025-11-25";

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/**
 * Create the message dispatcher. Returns `async dispatch(message)` → a response object,
 * or `null` for notifications (no `id`) and unknown notifications, which get no reply.
 */
export function createDispatcher({ client, ctx = {}, serverInfo, tools = [] } = {}) {
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  return async function dispatch(message) {
    const isNotification = message == null || message.id === undefined || message.id === null;
    const id = isNotification ? null : message.id;
    const method = message?.method;

    // Notifications never get a response. We only care about `initialized`.
    if (isNotification) return null;

    if (message.jsonrpc !== "2.0" || typeof method !== "string") {
      return rpcError(id, -32600, "Invalid Request");
    }

    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo,
          instructions:
            "Read-only access to the AIOS Team Brain and optional local workspace. Availability is fixed until restart; the Brain rechecks authorization on every call.",
        });

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
            ...(t._meta ? { _meta: t._meta } : {}),
          })),
        });

      case "tools/call": {
        const name = message.params?.name;
        const args = message.params?.arguments || {};
        const tool = toolByName.get(name);
        if (!tool) {
          return rpcError(id, -32602, `Unknown tool: ${name}`);
        }
        const argErrors = validateArgs(tool.inputSchema, args);
        if (argErrors.length) {
          return rpcError(id, -32602, `Invalid params for ${name}: ${argErrors.join("; ")}`, {
            errors: argErrors,
          });
        }
        try {
          // ctx carries non-brain context (cwd) for local aios_* tools; brain tools ignore it.
          const out = await tool.handler(args, client, ctx);
          return rpcResult(id, out);
        } catch (e) {
          // Tool-level failures are reported in-band (isError) so the model can react,
          // not as JSON-RPC protocol errors. Matches MCP guidance.
          return rpcResult(id, {
            content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }],
            isError: true,
          });
        }
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}

/** Attach input immediately; the serialized queue waits for startup selection. */
export function serveStdio(
  ready,
  { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}
) {
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "";
    let ended = false;
    let chain = Promise.resolve(ready);
    // Observe startup rejection even when a client has not sent any frames.
    chain.catch(reject);
    const enqueue = (line) => {
      chain = chain.then(async (dispatch) => {
        if (!line.trim()) return dispatch;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          stdout.write(JSON.stringify(rpcError(null, -32700, "Parse error")) + "\n");
          return dispatch;
        }
        try {
          const response = await dispatch(message);
          if (response) stdout.write(JSON.stringify(response) + "\n");
        } catch (error) {
          stderr.write(`MCP dispatch error: ${error?.message || error}\n`);
          if (message?.id != null)
            stdout.write(JSON.stringify(rpcError(message.id, -32603, "Internal error")) + "\n");
        }
        return dispatch;
      });
      chain.catch(reject);
    };
    stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        enqueue(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    const finish = () => {
      if (ended) return;
      ended = true;
      if (buffer.trim()) enqueue(buffer);
      chain.then(() => resolve(), reject);
    };
    stdin.once("end", finish);
    stdin.once("close", finish);
    stdin.once("error", reject);
  });
}
