/**
 * cursor-auth.mjs — resolve Cursor dashboard session cookie from local stores.
 *
 * The Agent API key (crsr_…) cannot read usage; the web dashboard uses
 * WorkosCursorSessionToken. Same resolution order as community cursor-usage.
 * Zero dependencies.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const KEYCHAIN_SERVICE = "cursor-access-token";

function jwtClaims(token) {
  try {
    let payload = token.split(".")[1];
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function cookieId(claims) {
  const sub = claims.sub;
  if (!sub) return null;
  return String(sub).split("|").pop();
}

function fromEnv() {
  const raw = process.env.CURSOR_SESSION_TOKEN?.trim();
  if (!raw) return null;
  const token = raw.replace(/%3A%3A/gi, "::");
  if (token.includes("::")) return token;
  const cid = cookieId(jwtClaims(token));
  return cid ? `${cid}::${token}` : null;
}

function fromMacKeychain() {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function* stateDbCandidates(home = os.homedir()) {
  const base =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"))
        : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"));
  for (const app of ["Cursor", "Cursor Nightly"]) {
    yield path.join(base, app, "User", "globalStorage", "state.vscdb");
  }
}

function fromStateDb() {
  for (const dbPath of stateDbCandidates()) {
    if (!existsSync(dbPath)) continue;
    try {
      const out = execFileSync(
        "sqlite3",
        ["-readonly", "-json", dbPath, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      const rows = JSON.parse(out.trim() || "[]");
      const val = rows[0]?.value;
      if (val) return String(val).trim().replace(/^"|"$/g, "");
    } catch {
      /* try next */
    }
  }
  return null;
}

function normalizeToken(token) {
  token = token.trim().replace(/%3A%3A/gi, "::");
  if (token.includes("::")) return token;
  const claims = jwtClaims(token);
  if (claims.type === "api_key_token") return null;
  const cid = cookieId(claims);
  return cid ? `${cid}::${token}` : null;
}

/** @returns {string} cookie value `<sub>::<jwt>` */
export function resolveCursorSession(verbose = false) {
  const env = fromEnv();
  if (env) {
    if (verbose) console.error("[costs] cursor auth: $CURSOR_SESSION_TOKEN");
    return env;
  }
  for (const [name, fn] of [
    ["macOS keychain", fromMacKeychain],
    ["Cursor state DB", fromStateDb],
  ]) {
    const raw = fn();
    if (!raw) continue;
    const cookie = normalizeToken(raw);
    if (cookie) {
      if (verbose) console.error(`[costs] cursor auth: ${name}`);
      return cookie;
    }
  }
  throw new Error(
    "Could not find Cursor web session token. Sign in via Cursor app or set CURSOR_SESSION_TOKEN."
  );
}
