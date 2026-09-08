import test from "node:test";
import assert from "node:assert/strict";
import { startPackageLlm } from "./support/mcp-package-llm.mjs";

test("synthetic provider only cites the source actually retrieved by the Brain", async (t) => {
  const llm = await startPackageLlm();
  t.after(() => llm.close());
  const request = (content, stream = true) =>
    fetch(`${llm.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream, messages: [{ role: "user", content }] }),
    });
  assert.equal((await request("No retrieved source here")).status, 500);
  assert.equal(llm.groundedRequests, 0);
  const source =
    '<source id="S7" project="acme" path="2-work/mcp-package.md" kind="deliverable">The synthetic lighthouse launch is violet.</source>';
  const response = await request(source);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /violet \[S7\]/);
  assert.equal(llm.groundedRequests, 1);
  assert.equal((await request("title request", false)).status, 200);
  assert.equal(llm.groundedRequests, 1);
});
