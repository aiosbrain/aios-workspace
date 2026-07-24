import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApi", () => {
  it("adds the session token without discarding existing query parameters", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetch);

    await createApi("secret token").get("/api/items?page=2");

    expect(fetch).toHaveBeenCalledWith(
      "/api/items?page=2&token=secret%20token",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("serializes POST bodies and handles empty success responses", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(createApi("token").post("/api/items", { name: "one" })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "/api/items?token=token",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"one"}',
      })
    );
  });

  it("preserves status and structured server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "denied" }), {
          status: 403,
          statusText: "Forbidden",
          headers: { "content-type": "application/json" },
        })
      )
    );

    const error = await createApi("token")
      .get("/api/private")
      .catch((reason) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message: "denied", body: { error: "denied" } });
  });

  it("builds secure websocket URLs and encodes resumed session ids", () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", host: "localhost:8790" },
    });
    expect(createApi("a b").wsUrl("id/one")).toBe(
      "wss://localhost:8790/ws?token=a%20b&session=id%2Fone"
    );
  });
});
