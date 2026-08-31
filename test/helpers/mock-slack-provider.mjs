/**
 * --import preload: a stateful in-process mock of the Slack Web API + the Team Brain,
 * broad enough to serve EVERY canonical `aios slack` verb (test/slack-command-parity,
 * test/slack-adapter-contract). No network I/O ever happens: globalThis.fetch is replaced
 * before the CLI entry module loads.
 *
 * Request capture: when AIOS_SLACK_MOCK_LOG names a file, every request that REACHES the
 * mock is appended as a JSON line (url, method, headers, body) — the destination-policy
 * suite asserts on this log that refused destinations received zero requests (and so zero
 * credential bytes).
 *
 * Redirect seam: MOCK_BRAIN_REDIRECT makes every brain endpoint answer 302 → that
 * location, so the cross-origin-redirect refusal can be exercised end to end.
 */
import { appendFileSync } from "node:fs";

const logFile = process.env.AIOS_SLACK_MOCK_LOG || null;

function record(url, init, body) {
  if (!logFile) return;
  appendFileSync(
    logFile,
    `${JSON.stringify({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: typeof body === "string" ? body : (body?.length ?? null),
    })}\n`
  );
}

const json = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

const state = {
  files: new Map(), // file_id → { filename, bytes }
  uploads: new Map(), // upload path → file_id
  nextFile: 1,
  brainToken: process.env.MOCK_BRAIN_SLACK_TOKEN || null,
};

function form(body) {
  return Object.fromEntries(new URLSearchParams(String(body ?? "")));
}

function slackApi(method, params) {
  switch (method) {
    case "auth.test":
      return { ok: true, user: "mockuser", user_id: "U0MOCK", team: "MockCo", team_id: "T0MOCK" };
    case "users.lookupByEmail":
      if (params.email === "missing@example.test") return { ok: false, error: "users_not_found" };
      return {
        ok: true,
        user: { id: "U0TEAMMATE", name: "teammate", real_name: "Team Mate", team_id: "T0MOCK" },
      };
    case "conversations.open":
      return { ok: true, channel: { id: `D0${params.users}` } };
    case "conversations.list": {
      // Two pages, to prove cursor pagination.
      if (!params.cursor) {
        return {
          ok: true,
          channels: [
            { id: "C0GENERAL", name: "general" },
            { id: "D0IM", is_im: true, user: "U0TEAMMATE" },
          ],
          response_metadata: { next_cursor: "page2" },
        };
      }
      return { ok: true, channels: [{ id: "C0SECOND", name: "second-page" }] };
    }
    case "conversations.history":
      return {
        ok: true,
        messages: [
          { ts: "2.000", user: "U0MOCK", text: "newer\nline" },
          { ts: "1.000", user: "U0TEAMMATE", text: "older" },
        ],
      };
    case "conversations.replies":
      return { ok: true, messages: [{ ts: params.ts, user: "U0MOCK", text: "thread reply" }] };
    case "chat.postMessage":
      return { ok: true, channel: params.channel, ts: "1700000000.000100" };
    case "reactions.add":
      return { ok: true };
    case "files.getUploadURLExternal": {
      const id = `F0MOCK${state.nextFile++}`;
      const uploadPath = `/mock-upload/${id}`;
      state.uploads.set(uploadPath, id);
      state.files.set(id, { filename: params.filename, bytes: null });
      const base = process.env.MOCK_UPLOAD_BASE || "https://files.slack.example"; // may be hostile in tests
      return { ok: true, upload_url: `${base}${uploadPath}`, file_id: id };
    }
    case "files.completeUploadExternal": {
      const requested = JSON.parse(params.files);
      return {
        ok: true,
        files: requested.map(({ id }) => ({ id, name: state.files.get(id)?.filename })),
      };
    }
    case "files.delete":
      if (!state.files.delete(params.file) && !params.file.startsWith("F0"))
        return { ok: false, error: "file_not_found" };
      return { ok: true };
    case "ratelimit.once":
      return { ok: true };
    default:
      return { ok: false, error: `unknown_method_${method}` };
  }
}

globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  record(url, init, init.body);
  const expectAuth = process.env.MOCK_EXPECT_AUTH;
  if (expectAuth && init.headers?.Authorization !== expectAuth) {
    throw new Error("mock-slack-provider: unexpected Authorization credential");
  }
  // ── Slack Web API ──
  if (target.origin === "https://slack.com" && target.pathname.startsWith("/api/")) {
    return json(slackApi(target.pathname.slice(5), form(init.body)));
  }
  // ── upload URL (raw bytes, no ok envelope) ──
  if (state.uploads.has(target.pathname)) {
    const id = state.uploads.get(target.pathname);
    state.files.get(id).bytes = init.body?.length ?? 0;
    return new Response("OK", { status: 200 });
  }
  // ── Team Brain ──
  if (target.pathname.startsWith("/api/v1/")) {
    const redirect = process.env.MOCK_BRAIN_REDIRECT;
    if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
    if (target.pathname === "/api/v1/me/slack-token") {
      if (init.method === "POST") {
        const { token } = JSON.parse(init.body);
        state.brainToken = token;
        return json({ ok: true, slack_user_id: "U0MOCK", workspace: "MockCo" });
      }
      if (init.method === "DELETE") {
        state.brainToken = null;
        return json({ ok: true });
      }
      if (!state.brainToken) return json({ connected: false }, { status: 404 });
      return json({
        connected: true,
        token: state.brainToken,
        slack_user_id: "U0MOCK",
        workspace: "MockCo",
      });
    }
    if (target.pathname === "/api/v1/identities/resolve") {
      const member = target.searchParams.get("email") || target.searchParams.get("handle");
      if (member === "ghost") return json({ identities: [] });
      return json({ identities: [{ provider: "slack", external_id: "U0BRAIN" }] });
    }
  }
  throw new Error(`mock-slack-provider: unrouted destination ${target.origin}${target.pathname}`);
};
