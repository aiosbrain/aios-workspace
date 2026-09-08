import { createServer } from "node:http";
export async function startPackageLlm() {
  let groundedRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      let bytes = "";
      for await (const chunk of request) {
        bytes += chunk;
        if (bytes.length > 2_000_000) throw new Error("Synthetic request too large");
      }
      const payload = JSON.parse(bytes);
      const prompt = payload.messages
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        )
        .join("\n");
      if (!payload.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Synthetic lighthouse query" } }],
          })
        );
        return;
      }
      const source = [
        ...prompt.matchAll(
          /<source id="(S\d+)"[^>]*path="2-work\/mcp-package\.md"[^>]*>([\s\S]*?)<\/source>/g
        ),
      ].find((match) => match[2].includes("violet"));
      if (!source)
        throw new Error("Real Brain retrieval did not supply the synthetic lighthouse source");
      groundedRequests++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: `The synthetic lighthouse launch is violet [${source[1]}].` } }] })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 15 } })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Synthetic grounding assertion failed" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    get groundedRequests() {
      return groundedRequests;
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}
