import { test } from "node:test";
import assert from "node:assert/strict";
import { createDispatcher } from "../scripts/brain-mcp.mjs";
test("unbound collector denies cwd authority without reading workspace content", async () => {
  const dispatch = createDispatcher({ ctx: { cwd: "/must-not-be-read" } });
  const response = await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "aios_loop_collect", arguments: { cadence: "weekly" } },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /explicit profile-bound path enforcement/);
});
