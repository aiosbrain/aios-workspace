// Unified inbox — outbox credential wrapper (I-11 / AIO-392, "where cheap").
//
// The G5 claim is scoped honestly: on John's Mac the ambient `gog` CLI still holds its own OAuth
// token, so the inbox path is GATED but not un-bypassable (G6b/I-15 owns the cannot-bypass broker +
// per-adapter uid isolation). Where cheap, the gog send credential moves behind the gateway process:
// the token file is readable ONLY by the gateway uid, mode `0600`. This module is the deterministic
// assertion the outbox runs before trusting a wrapped send client — a stat check, not a broker.
//
// Kept OUT of `outbox.ts` (which stays injection-only / I/O-free): the credential check is the one
// place the outbox touches the filesystem, so it lives in its own tiny module.

import { statSync } from "node:fs";

/** The result of the gateway-token security assertion. `skipped` on platforms without POSIX
 *  mode/uid semantics (e.g. win32) carries a named reason instead of a hard failure. */
export interface TokenSecurityResult {
  ok: boolean;
  skipped: boolean;
  reason: string;
}

export interface TokenSecurityOptions {
  /** The uid the token must be owned by (the gateway process uid). Defaults to the current uid. */
  expectedUid?: number;
  /** Force the unsupported-platform skip path (tests). Defaults to `process.platform === "win32"`. */
  platform?: string;
}

/**
 * Assert the gog send credential is gateway-private: regular file, mode `0600` (no group/other
 * bits), owned by the gateway uid. Returns `{ ok, skipped, reason }` — a violation is `ok:false`
 * (the caller refuses to wrap the send), and an unsupported platform is `skipped:true` with a named
 * reason (POSIX mode/uid checks are meaningless there). Never throws on a missing/unreadable file;
 * that is reported as `ok:false` so the outbox fails closed.
 */
export function assertGatewayTokenSecurity(
  tokenPath: string,
  opts: TokenSecurityOptions = {}
): TokenSecurityResult {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    return {
      ok: false,
      skipped: true,
      reason:
        "POSIX mode/ownership checks unsupported on win32 — gateway isolation deferred to G6b",
    };
  }
  let stat;
  try {
    stat = statSync(tokenPath);
  } catch {
    return {
      ok: false,
      skipped: false,
      reason: `token file not found or unreadable: ${tokenPath}`,
    };
  }
  if (!stat.isFile()) {
    return { ok: false, skipped: false, reason: `token path is not a regular file: ${tokenPath}` };
  }
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    return {
      ok: false,
      skipped: false,
      reason: `token mode is 0${mode.toString(8)} (expected 0600 — gateway-private)`,
    };
  }
  const expectedUid =
    opts.expectedUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  if (expectedUid >= 0 && stat.uid !== expectedUid) {
    return {
      ok: false,
      skipped: false,
      reason: `token owned by uid ${stat.uid} (expected gateway uid ${expectedUid})`,
    };
  }
  return { ok: true, skipped: false, reason: "token is gateway-private (0600, gateway uid)" };
}
