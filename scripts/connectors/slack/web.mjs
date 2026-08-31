/**
 * Slack Web API + Team Brain transport for the built-in adapter (AIO-1068).
 *
 * EVERY outbound request routes through trustedFetch (scripts/cli/destination-policy.mjs):
 * destinations are validated before any credential materializes (credentialFactory runs
 * after validation), redirects are origin-pinned for credentialed requests, and file:,
 * malformed, and non-loopback-http destinations fail closed. This is the Node port of
 * slack.py's _assert_request_url + _SameOriginRedirectHandler semantics — including the
 * malformed-port case, which `new URL` rejects and validateDestination maps to
 * AIOS_E_DESTINATION_UNTRUSTED.
 *
 * Error mapping (Slack `ok:false` envelope):
 *   invalid_auth/not_authed/token_revoked/account_inactive → AIOS_E_CREDENTIAL_INCOMPLETE (3)
 *   any other Slack error                                  → AIOS_E_PROVIDER (4)
 *   network / HTTP failure after retries                   → AIOS_E_NETWORK (4)
 * (slack.py used exit 5 for network; the v2 CLI error taxonomy pins network at class 4.)
 */
import { AiosError, trustedFetch } from "../../cli.mjs";

export const API = "https://slack.com/api/";
const RETRIES = 4;
const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive"]);
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Honour a well-formed Retry-After (whole seconds); otherwise capped backoff + jitter. */
export function retryDelayMs(retryAfter, attempt) {
  const raw = String(retryAfter ?? "").trim();
  if (raw && /^\d+$/.test(raw)) return Math.max(0, Math.min(60, Number(raw))) * 1000;
  return Math.min(30, 2 ** attempt) * 1000 + Math.random() * 500;
}

const networkError = (detail) =>
  new AiosError(
    "AIOS_E_NETWORK",
    `Slack request failed: ${detail}`,
    "Check network connectivity and retry."
  );

/**
 * POST one Slack Web API method (form-encoded, Bearer user token) with 429/5xx retries.
 * Returns the parsed payload; throws typed AiosErrors on failure.
 */
export async function slackCall(ctx, method, params = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) body.append(key, String(value));
  }
  const encoded = body.toString();
  const wait = ctx.sleep ?? sleep; // test seam — retries must never real-sleep a suite
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await trustedFetch(API + method, {
        method: "POST",
        body: encoded,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        credentialFactory: () => ({ Authorization: `Bearer ${ctx.token}` }),
        signal: AbortSignal.timeout(ctx.timeoutMs ?? 45_000),
        fetch: ctx.fetch,
        env: ctx.env,
      });
    } catch (error) {
      if (error instanceof AiosError) throw error;
      if (attempt < RETRIES) {
        await wait(retryDelayMs(null, attempt));
        continue;
      }
      throw networkError(`network error calling ${method}: ${error.message}`);
    }
    if (RETRY_STATUS.has(response.status)) {
      if (attempt < RETRIES) {
        await wait(retryDelayMs(response.headers.get("retry-after"), attempt));
        continue;
      }
      throw networkError(`HTTP ${response.status} from ${method}`);
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload.ok !== "boolean") {
      throw networkError(`malformed response from ${method}`);
    }
    if (!payload.ok) {
      const err = payload.error ?? "unknown_error";
      if (err === "ratelimited" && attempt < RETRIES) {
        await wait(retryDelayMs(null, attempt));
        continue;
      }
      if (AUTH_ERRORS.has(err)) {
        throw new AiosError(
          "AIOS_E_CREDENTIAL_INCOMPLETE",
          `Slack auth failed (${err}).`,
          "Check SLACK_USER_TOKEN, or reconnect via `aios slack connect`."
        );
      }
      throw new AiosError(
        "AIOS_E_PROVIDER",
        `Slack API error on ${method}: ${err}`,
        "Correct the request (target/arguments/scopes) and retry."
      );
    }
    return payload;
  }
}

/* ── Team Brain transport (bearer AIOS_API_KEY; destination validated pre-credential) ── */

const brainHeaders = (brain) => () => ({
  Authorization: `Bearer ${brain.key}`,
  ...(brain.team ? { "X-AIOS-Team": brain.team } : {}),
});

export async function brainRequest(brain, method, urlPath, payload, options = {}) {
  if (!brain?.url || !brain?.key) {
    throw new AiosError(
      "AIOS_E_CONFIG_MISSING",
      "The Team Brain is not configured.",
      "Set AIOS_BRAIN_URL + AIOS_API_KEY (env, workspace .env, or agent-context.json)."
    );
  }
  let response;
  try {
    response = await trustedFetch(brain.url + urlPath, {
      method,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      headers: payload === undefined ? {} : { "Content-Type": "application/json" },
      credentialFactory: brainHeaders(brain),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      fetch: options.fetch,
      env: options.env,
    });
  } catch (error) {
    if (error instanceof AiosError) throw error;
    throw new AiosError(
      "AIOS_E_NETWORK",
      `Could not reach the Team Brain: ${error.message}`,
      "Check the brain URL and network connectivity, then retry."
    );
  }
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

export const brainGetJson = (brain, urlPath, options) =>
  brainRequest(brain, "GET", urlPath, undefined, options);

/**
 * Resolve a teammate (email or handle) to a Slack U-id via the brain, or null when the
 * brain is unconfigured or has no match. A destination-policy refusal is NOT swallowed —
 * a forbidden destination fails loudly rather than degrading into "no brain match".
 */
export async function brainResolveSlack(brain, member, options = {}) {
  if (!brain?.url || !brain?.key) return null;
  const query = new URLSearchParams({ provider: "slack" });
  query.set(member.includes("@") ? "email" : "handle", member);
  let result;
  try {
    result = await brainGetJson(brain, `/api/v1/identities/resolve?${query}`, options);
  } catch (error) {
    if (error instanceof AiosError && error.code === "AIOS_E_DESTINATION_UNTRUSTED") throw error;
    return null;
  }
  if (result.status >= 400) return null;
  for (const identity of result.body?.identities ?? []) {
    if (identity?.provider === "slack" && identity?.external_id) return identity.external_id;
  }
  return result.body?.slack_id ?? null;
}

/* ── target resolution ── */

export async function openDm(ctx, userId) {
  return (await slackCall(ctx, "conversations.open", { users: userId })).channel.id;
}

export async function listConversations(ctx, types) {
  const channels = [];
  const seen = new Set();
  let cursor = "";
  for (;;) {
    const page = await slackCall(ctx, "conversations.list", {
      types,
      limit: 1000,
      cursor: cursor || null,
    });
    channels.push(...(page.channels ?? []));
    cursor = page.response_metadata?.next_cursor || "";
    if (!cursor) break;
    if (seen.has(cursor)) {
      throw new AiosError(
        "AIOS_E_PROVIDER",
        "Slack conversation pagination stalled (repeated cursor).",
        "Retry; report to Slack if it persists."
      );
    }
    seen.add(cursor);
  }
  return channels;
}

const usage = (message) =>
  new AiosError("AIOS_E_USAGE", message, "Run `aios slack help` for the target forms.");

/** Map a CLI target (U…/W…/C…/D…/G…/@email/email/#name) to a postable channel id. */
export async function resolveTarget(ctx, target) {
  if (!target) throw usage("Missing --target.");
  let value = target;
  if (value.startsWith("@") && value.slice(1).includes("@")) value = value.slice(1);
  if (value.includes("@") && !/^[UWCDG]/.test(value)) {
    const user = (await slackCall(ctx, "users.lookupByEmail", { email: value })).user;
    return openDm(ctx, user.id);
  }
  if (value[0] === "U" || value[0] === "W") return openDm(ctx, value);
  if (value[0] === "C" || value[0] === "D" || value[0] === "G") return value;
  if (value.startsWith("#")) {
    const name = value.slice(1);
    const channels = await listConversations(ctx, "public_channel,private_channel");
    const match = channels.find((channel) => channel.name === name);
    if (match) return match.id;
    throw new AiosError(
      "AIOS_E_PROVIDER",
      `Channel #${name} not found.`,
      "Check the channel name (the token's user must be able to see it)."
    );
  }
  throw usage(`Unrecognized target: ${target}`);
}

/** Shared --member resolution (dm/file): brain first, Slack email lookup as fallback. */
export async function resolveMemberChannel(ctx, member) {
  const uid = await brainResolveSlack(ctx.brain, member, ctx);
  if (uid) return openDm(ctx, uid);
  if (member.includes("@")) return resolveTarget(ctx, member);
  throw new AiosError(
    "AIOS_E_PROVIDER",
    `Could not resolve teammate '${member}' (no brain match and not an email).`,
    "Use the teammate's email, or connect the Team Brain for handle resolution."
  );
}
