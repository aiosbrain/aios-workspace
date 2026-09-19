#!/usr/bin/env node
/**
 * Synthetic Team Brain for the MCP host acceptance journey — a separate process, because
 * the journey drives the CLI with blocking child processes. Loopback HTTP is an origin
 * the production origin policy accepts (toolkit and pinned MCP artifact alike), so the
 * real fetch path, redirect refusal and timeouts are exercised with no TLS or fetch seam.
 *
 * Scope is deliberately tiny: `GET /api/v1/me` for two synthetic keys (one `team`, one
 * `external` identity) and one canned `brain_search_evidence` backend response. Anything
 * else is a 404. Every request is reported on stdout as a JSON line WITHOUT credentials;
 * the first line is `{"port":N}`. `sync <nonce>` on stdin is echoed as `{"sync":nonce}`.
 */
import { createServer } from "node:http";

const keys = new Map([
  [process.env.AIOS_FIXTURE_TEAM_KEY, "team"],
  [process.env.AIOS_FIXTURE_EXTERNAL_KEY, "external"],
]);
keys.delete(undefined);
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const server = createServer((request, response) => {
  const bearer = /^Bearer (.+)$/.exec(request.headers.authorization || "")?.[1];
  const tier = keys.get(bearer) ?? null;
  const url = new URL(request.url, "http://127.0.0.1");
  const send = (status, body) => {
    say({ request: { method: request.method, path: url.pathname, tier, status } });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  request.resume();
  request.on("end", () => {
    if (!tier) return send(401, { error: "unauthorized" });
    if (request.method === "GET" && url.pathname === "/api/v1/me")
      return send(200, {
        tier,
        actor: "acceptance-member",
        role: "member",
        team: "acceptance-team",
      });
    // The shape the pinned 0.2.1 client validates for brain_search_evidence.
    if (request.method === "POST" && url.pathname === "/api/v1/evidence/search")
      return send(200, {
        returned: 1,
        truncated: false,
        sources: [
          {
            item_id: "acceptance-item",
            sid: "S1",
            excerpt: "Synthetic acceptance evidence passage.",
            contributors: ["acceptance-member"],
          },
        ],
      });
    return send(404, { error: "not found" });
  });
});
server.listen(0, "127.0.0.1", () => say({ port: server.address().port }));
// Control channel: `sync <nonce>` is echoed on stdout AFTER every request line already
// written, so a parent that awaits the echo has provably seen all earlier requests.
// End of input shuts the fixture down.
process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (let at; (at = pending.indexOf("\n")) !== -1; pending = pending.slice(at + 1)) {
    const [verb, nonce] = pending.slice(0, at).split(" ");
    if (verb === "sync" && nonce) say({ sync: nonce });
  }
});
process.stdin.on("end", () => {
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
});
