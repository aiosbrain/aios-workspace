/**
 * Token-injected fetch + WebSocket URL helpers for the token-gated `/api/*` and
 * `/ws` surfaces. All sensitive routes require `?token=…`; `/api/info` and
 * `/api/catalog` are public but harmlessly accept it too.
 */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  /** WebSocket URL for the agent stream, optionally resuming an existing session. */
  wsUrl(sessionId?: string | null): string;
}

function withToken(path: string, token: string): string {
  if (!token) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

export function createApi(token: string): Api {
  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(withToken(path, token), {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const data = await res.json();
        detail = (data && (data.error || data.message)) || detail;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, detail);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    wsUrl(sessionId) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      let url = `${proto}//${window.location.host}/ws`;
      url = withToken(url, token);
      if (sessionId) url += `&session=${encodeURIComponent(sessionId)}`;
      return url;
    },
  };
}
