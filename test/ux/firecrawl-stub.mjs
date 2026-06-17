#!/usr/bin/env node
// test/ux/firecrawl-stub.mjs — a tiny, deterministic HTTP stand-in for the Firecrawl API.
//
// The firecrawl-extract skill POSTs to `${FIRECRAWL_API_URL}/v2/scrape`. We launch the
// cockpit with FIRECRAWL_API_URL pointed at this stub so the onboarding flow is fully
// offline + deterministic (no real Firecrawl spend, no network). It returns a FIXED extract
// loaded from test/ux/fixtures/firecrawl-extract.json, in the exact shape firecrawl-extract
// expects: { success:true, data:{ json:{…}, metadata:{ title } } }.
//
// Usage:
//   node test/ux/firecrawl-stub.mjs --port <p>
// On start it prints `firecrawl-stub: listening on http://127.0.0.1:<p>` to stdout.

import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; };
const port = parseInt(flag("--port", "0"), 10);

const fixture = JSON.parse(readFileSync(path.join(HERE, "fixtures", "firecrawl-extract.json"), "utf8"));

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === "POST" && req.url.startsWith("/v2/scrape")) {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let url = null;
      try { url = JSON.parse(body || "{}").url || null; } catch { /* ignore */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: {
          json: fixture.json,
          metadata: { title: fixture.title || "Example", sourceURL: url },
        },
      }));
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: false, error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  const actual = server.address().port;
  console.log(`firecrawl-stub: listening on http://127.0.0.1:${actual}`);
});

// Clean shutdown on signals so the orchestrator's teardown is reliable.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { server.close(); } catch { /* */ } process.exit(0); });
