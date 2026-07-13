import assert from "node:assert/strict";
import test from "node:test";
import { projectionHealthLine, readProjectionHealth } from "../scripts/pm.mjs";

const cfg = { brain_url: "https://brain.example", api_key: "secret", team_id: "aios" };

test("formats projection health as one bounded status line", () => {
  const line = projectionHealthLine({
    health: {
      status: "ok",
      ageMs: 125_000,
      lastRun: { created: 2, error_count: 0 },
    },
  });
  assert.equal(line, "pm projection: ok · 2m ago · 2 synced · 0 errors");
  assert.equal(
    projectionHealthLine({ health: { status: "never_run", lastRun: null } }),
    "pm projection: never run"
  );
});

test("reads the v1.9 health endpoint with auth and tolerates an older brain", async () => {
  let request;
  const payload = await readProjectionHealth(cfg, {
    fetch: async (url, init) => {
      request = { url, init };
      return new Response(
        JSON.stringify({ health: { status: "never_run", lastRun: null }, runs: [] })
      );
    },
  });
  assert.equal(request.url, "https://brain.example/api/v1/pm-sync/health?limit=10");
  assert.equal(request.init.headers.Authorization, "Bearer secret");
  assert.equal(payload.health.status, "never_run");

  const unavailable = await readProjectionHealth(cfg, {
    fetch: async () =>
      new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 }),
  });
  assert.equal(unavailable, null);
});
