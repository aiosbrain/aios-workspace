/**
 * Canonical Team Brain origin handling shared by every CLI-side Brain client.
 *
 * A configured value is an origin, not an arbitrary request URL. We accept the
 * common URLs a human copies from a Brain UI/API page, reduce them to the exact
 * origin, and reject values that could smuggle credentials, fragments, unsafe
 * protocols, remote plaintext HTTP, or an unrelated path into later requests.
 * Zero npm dependencies (Node >= 18).
 */

const KNOWN_V1_ROOTS = new Set([
  "actions",
  "codebases",
  "company-graph",
  "conversations",
  "costs",
  "decisions",
  "graph-query",
  "identities",
  "integrations",
  "items",
  "me",
  "members",
  "metrics",
  "okf-bundle",
  "pm-sync",
  "projects",
  "query",
  "subscriptions",
  "tasks",
  "work-events",
]);

export function isLoopbackHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function acceptedPath(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return true;
  if (/^\/t\/[^/]+$/.test(path)) return true;
  if (path === "/api/v1") return true;
  const match = path.match(/^\/api\/v1\/([^/]+)(?:\/.*)?$/);
  return !!match && KNOWN_V1_ROOTS.has(match[1]);
}

function correction(message) {
  return `${message} Enter the Brain origin, for example https://brain.example.com.`;
}

/** Return the exact canonical origin or throw an actionable, human-readable error. */
export function normalizeBrainOrigin(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error(correction("Brain URL is empty."));

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(correction("Brain URL is not a valid absolute URL."));
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(correction(`Brain URL protocol '${url.protocol}' is not allowed.`));
  }
  if (url.username || url.password) {
    throw new Error(correction("Brain URL must not contain a username or password."));
  }
  if (url.hash) {
    throw new Error(correction("Brain URL must not contain a fragment (#...)."));
  }
  if (url.search) {
    throw new Error(correction("Brain URL must not contain query parameters."));
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(
      correction(
        "Remote Brain origins require HTTPS; HTTP is allowed only for localhost, 127.0.0.1, or ::1."
      )
    );
  }
  if (!acceptedPath(url.pathname)) {
    throw new Error(
      correction(
        `Brain URL path '${url.pathname}' is not a recognized Brain page or /api/v1 endpoint.`
      )
    );
  }

  return url.origin;
}

/**
 * Grace-period normalization for brain_url values read from an EXISTING config.
 *
 * The two rules that became strict in this release (remote plain HTTP, and an
 * unrecognized path on the configured URL) would retroactively brick working
 * setups that were configured before the hardening (LAN/tailnet brains on http,
 * reverse-proxy subpaths). For one release those two cases degrade to a loud
 * stderr warning; every other rule (credentials, fragment, query, protocol)
 * still throws, and the value is still reduced to its exact origin, which
 * fetchBrainOriginLocked continues to enforce. New/interactive input must keep
 * using the strict normalizeBrainOrigin.
 */
export function normalizeBrainOriginFromConfig(input, warn = (msg) => console.error(msg)) {
  try {
    return normalizeBrainOrigin(input);
  } catch (err) {
    const raw = String(input || "").trim();
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw err;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw err;
    if (url.username || url.password || url.hash || url.search) throw err;

    const remoteHttp = url.protocol === "http:" && !isLoopbackHostname(url.hostname);
    const oddPath = !acceptedPath(url.pathname);
    if (!remoteHttp && !oddPath) throw err;

    warn(
      `Warning: configured brain_url '${raw}' no longer meets the hardened origin rules ` +
        `(${remoteHttp ? "remote HTTP origin" : `unrecognized path '${url.pathname}'`}). ` +
        `Accepting it as ${url.origin} for this release only — run 'aios onboard' to repair the config. ` +
        `The next release will reject it.`
    );
    return url.origin;
  }
}

export function brainApiUrl(origin, route = "") {
  const canonical = normalizeBrainOrigin(origin);
  const suffix = String(route || "");
  if (suffix && !suffix.startsWith("/")) {
    throw new Error(`Brain API route must begin with '/': ${suffix}`);
  }
  return `${canonical}/api/v1${suffix}`;
}

/**
 * Fetch without allowing the runtime to follow a request onto another origin.
 * Same-origin redirects are followed explicitly (bounded); a cross-origin
 * Location is rejected before credentials can be replayed.
 */
export async function fetchBrainOriginLocked(fetchImpl, url, options = {}, expectedOrigin) {
  const allowedOrigin = normalizeBrainOrigin(expectedOrigin || url);
  let current = new URL(url);
  if (current.origin !== allowedOrigin) {
    throw new Error(
      `Refusing Brain request outside confirmed origin ${allowedOrigin}: ${current.origin}`
    );
  }

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchImpl(current.href, { ...options, redirect: "manual" });
    if (!(response.status >= 300 && response.status < 400)) return response;

    const location = response.headers?.get?.("location");
    if (!location)
      throw new Error(`Brain returned redirect ${response.status} without a Location header.`);
    const next = new URL(location, current);
    if (next.origin !== allowedOrigin) {
      throw new Error(
        `Brain redirect changed origin from ${allowedOrigin} to ${next.origin}; confirm the correct Brain origin and try again.`
      );
    }
    current = next;
  }
  throw new Error("Brain returned too many redirects (maximum 3).");
}
