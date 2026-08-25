import { AiosError } from "./errors.mjs";

function rawAuthority(input) {
  const match = String(input).match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/);
  if (!match || match[1].includes("@")) return null;
  return match[1].replace(/:\d+$/, "");
}

function literalLoopback(authority) {
  if (authority === "[::1]") return true;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(authority ?? "")) return false;
  const parts = authority.split(".");
  if (parts.some((part) => (part.length > 1 && part.startsWith("0")) || Number(part) > 255))
    return false;
  return Number(parts[0]) === 127;
}

function hasCredentialHeader(headers = {}) {
  return Object.keys(headers).some((name) =>
    /(?:authorization|cookie|api[-_]?key|token|secret)/i.test(name)
  );
}

export function validateDestination(input, options = {}) {
  let url;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new AiosError(
      "AIOS_E_DESTINATION_UNTRUSTED",
      "The destination is not a valid absolute URL.",
      "Configure an absolute HTTPS destination.",
      { cause }
    );
  }
  if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) {
    throw new AiosError(
      "AIOS_E_DESTINATION_UNTRUSTED",
      "The destination scheme or authority is not trusted.",
      "Use credential-free authority syntax and HTTPS."
    );
  }
  if (url.protocol === "https:") return url;
  const allowed =
    options.allowInsecureLoopback === true || options.env?.AIOS_ALLOW_INSECURE_LOOPBACK === "1";
  if (!allowed || options.credentialed || !literalLoopback(rawAuthority(input))) {
    throw new AiosError(
      "AIOS_E_DESTINATION_UNTRUSTED",
      "HTTP is allowed only for explicitly enabled, credential-free literal loopback.",
      "Use HTTPS, or remove credentials and set AIOS_ALLOW_INSECURE_LOOPBACK=1 for literal loopback."
    );
  }
  return url;
}

export async function trustedFetch(input, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const credentialed =
    typeof options.credentialFactory === "function" || hasCredentialHeader(options.headers);
  let url = validateDestination(input, { ...options, credentialed });
  let headers = { ...(options.headers ?? {}) };
  if (typeof options.credentialFactory === "function") {
    headers = { ...headers, ...(await options.credentialFactory()) };
  }
  let method = options.method;
  let body = options.body;
  const origin = url.origin;
  for (let redirects = 0; ; redirects++) {
    const response = await fetchImpl(url, {
      method,
      body,
      headers,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= (options.maxRedirects ?? 5) || !response.headers.get("location")) {
      throw new AiosError(
        "AIOS_E_NETWORK",
        "The destination returned an invalid or excessive redirect chain.",
        "Correct the destination or redirect configuration and retry."
      );
    }
    const next = new URL(response.headers.get("location"), url);
    if (credentialed && next.origin !== origin) {
      throw new AiosError(
        "AIOS_E_DESTINATION_UNTRUSTED",
        "A credentialed redirect attempted to cross origins.",
        "Use a same-origin redirect or configure the final trusted HTTPS destination directly."
      );
    }
    url = validateDestination(next.href, { ...options, credentialed });
    if (response.status === 303 || ([301, 302].includes(response.status) && method === "POST")) {
      method = "GET";
      body = undefined;
      for (const name of Object.keys(headers)) {
        if (/^content-/i.test(name)) delete headers[name];
      }
    }
  }
}
