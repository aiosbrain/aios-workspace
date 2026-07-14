// Unified inbox — remote-access device identity (I-15 / AIO-396, G6b).
//
// The remote-access workstream G6a deliberately skipped: device identity + enrollment + revocation +
// scoped tokens for the GUI/CLI reaching the remote read-model API. No bare port exposure — every
// request to the read-model API carries a token minted for an ENROLLED device, scoped to a capability
// (`read-model` for `aios inbox --json`, `status` for `aios inbox status`). A REVOKED device is
// rejected even with a structurally valid token.
//
// The token is an HMAC over `deviceId · scope · exp · nonce` under a host secret. Verification is
// stateless for the crypto/enrollment checks (no round-trip), but a valid token is SINGLE-USE: the
// per-token `nonce` is consumed atomically on the first successful verify and any replay — including
// after a process restart — is rejected. Revocation is enforced against the durable registry (a
// revoked or unknown device fails even if the signature is valid and unexpired). Tamper of any field
// — device, scope, or expiry — invalidates the signature. This is inbox-domain host logic; it
// value-imports only `node:crypto` + node fs. The host secret, the registry, and the consumed-nonce
// store are admin-tier local state, never synced.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { INBOX_DIR_REL } from "./journal.js";

/** Capabilities a device token can be scoped to. `read-model` = `aios inbox --json`; `status` = health. */
export type DeviceScope = "read-model" | "status";
export const DEVICE_SCOPES: readonly DeviceScope[] = ["read-model", "status"];

export const DEVICE_REGISTRY_BASENAME = "device-registry.json";
export const DEVICE_REGISTRY_REL = `${INBOX_DIR_REL}/${DEVICE_REGISTRY_BASENAME}`;
export const DEVICE_REGISTRY_VERSION = 1;

export interface DeviceRecord {
  device_id: string;
  /** Scopes this device is enrolled for. A token may only be minted for a scope in this set. */
  scopes: DeviceScope[];
  enrolled_at: string;
  revoked_at: string | null;
}

export type DeviceVerifyReason =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "unknown-device"
  | "revoked"
  | "scope-not-granted"
  | "replayed"
  | "nonce-store-full"
  | "nonce-unavailable";

export type DeviceVerifyResult =
  | { ok: true; deviceId: string; scope: DeviceScope; expiresAt: number }
  | { ok: false; reason: DeviceVerifyReason };

/** Durable store for the device registry (injectable so tests can use an in-memory backing). */
export interface DeviceStore {
  load(): DeviceRecord[];
  save(records: readonly DeviceRecord[]): void;
}

// ── nonce (single-use) store ─────────────────────────────────────────────────────────────────────────

/** Result of an atomic nonce consumption. `unavailable` = the store could not be locked (a durable
 *  store under contention/corruption) — callers MUST treat it as fail-closed (deny), never accept. */
export type NonceConsumeResult = "fresh" | "replay" | "store-full" | "unavailable";

/**
 * Durable, bounded store of consumed token nonces — the replay-protection spine. `consume` MUST be
 * atomic (check-and-record in one step) so two concurrent verifies of the same token cannot both
 * succeed, and MUST survive a process restart so a token replayed after the coordinator restarts is
 * still rejected. Implementations prune entries whose token has expired (a nonce is only replayable
 * while its token is unexpired) and enforce a hard size cap (DoS bound: an attacker minting/flooding
 * distinct nonces cannot grow the store without limit).
 */
export interface NonceStore {
  /** Atomically consume `key` carrying token `expiresAt` (ms). Prunes expired, enforces the cap. */
  consume(key: string, expiresAt: number, now: number): NonceConsumeResult;
  /** Current count of live (unexpired) consumed nonces, as of `now`. */
  size(now: number): number;
}

/** Default hard cap on live consumed-nonces (DoS bound). Generous vs. realistic issuance × TTL. */
export const DEFAULT_MAX_NONCES = 50_000;

// ── token codec (stateless HMAC) ─────────────────────────────────────────────────────────────────────

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Canonical, un-ambiguous signing payload (fields joined by a separator that can't appear in them). */
function payloadOf(deviceId: string, scope: string, exp: number, nonce: string): string {
  return `v1\n${deviceId}\n${scope}\n${exp}\n${nonce}`;
}

// ── registry ─────────────────────────────────────────────────────────────────────────────────────────

export interface DeviceRegistry {
  enroll(deviceId: string, scopes: readonly DeviceScope[], nowIso: string): DeviceRecord;
  revoke(deviceId: string, nowIso: string): boolean;
  get(deviceId: string): DeviceRecord | null;
  list(): DeviceRecord[];
  /** Mint a SINGLE-USE token for an enrolled, non-revoked device scoped to `scope`. Throws otherwise.
   *  `nonce` is optional — omit it and a cryptographically-random one is generated (the norm; an
   *  explicit nonce exists for deterministic tests). Each nonce may be verified at most once. */
  mintToken(input: {
    deviceId: string;
    scope: DeviceScope;
    expiresAt: number;
    nonce?: string;
  }): string;
  /** Verify a token: signature, expiry, enrollment, revocation, scope grant, THEN single-use nonce
   *  consumption — all default-deny. A successful verify atomically consumes the nonce (replay-safe). */
  verifyToken(token: string, now: number): DeviceVerifyResult;
}

export interface DeviceRegistryOptions {
  /** Consumed-nonce store (replay protection). Defaults to a bounded in-memory store. Pass a durable
   *  one (`fileNonceStore`) so replays are rejected across process restarts. */
  nonceStore?: NonceStore;
}

/**
 * Build a device registry over a durable store + a host secret. Enrollment/revocation mutate the
 * store; token verification reads it, so a device revoked on the host is rejected on the next request
 * even though its token signature is still valid — revocation is authoritative, not advisory. A
 * successful verify consumes the token's nonce via the injected `nonceStore` so the token cannot be
 * replayed (including across a restart when a durable nonce store is used).
 */
export function createDeviceRegistry(
  store: DeviceStore,
  secret: string,
  opts: DeviceRegistryOptions = {}
): DeviceRegistry {
  if (!secret) throw new Error("device-identity: a non-empty host secret is required");
  const nonceStore = opts.nonceStore ?? memoryNonceStore();
  const index = new Map<string, DeviceRecord>();
  for (const r of store.load()) index.set(r.device_id, r);

  const persist = (): void =>
    store.save([...index.values()].sort((a, b) => a.device_id.localeCompare(b.device_id)));

  return {
    enroll(deviceId, scopes, nowIso) {
      const clean = [...new Set(scopes)]
        .filter((s): s is DeviceScope => DEVICE_SCOPES.includes(s))
        .sort();
      const rec: DeviceRecord = {
        device_id: deviceId,
        scopes: clean,
        enrolled_at: nowIso,
        revoked_at: null,
      };
      index.set(deviceId, rec);
      persist();
      return rec;
    },
    revoke(deviceId, nowIso) {
      const rec = index.get(deviceId);
      if (!rec || rec.revoked_at) return false;
      rec.revoked_at = nowIso;
      persist();
      return true;
    },
    get(deviceId) {
      return index.get(deviceId) ?? null;
    },
    list() {
      return [...index.values()].sort((a, b) => a.device_id.localeCompare(b.device_id));
    },
    mintToken({ deviceId, scope, expiresAt, nonce }) {
      const rec = index.get(deviceId);
      if (!rec) throw new Error(`device-identity: cannot mint for unknown device "${deviceId}"`);
      if (rec.revoked_at)
        throw new Error(`device-identity: cannot mint for revoked device "${deviceId}"`);
      if (!rec.scopes.includes(scope)) {
        throw new Error(
          `device-identity: device "${deviceId}" is not enrolled for scope "${scope}"`
        );
      }
      // Default: a fresh random nonce so every minted token is single-use with overwhelming
      // uniqueness. An explicit nonce is accepted only for deterministic tests.
      const n = nonce ?? randomBytes(18).toString("base64url");
      const body = `${b64url(deviceId)}.${scope}.${expiresAt}.${b64url(n)}`;
      const sig = sign(secret, payloadOf(deviceId, scope, expiresAt, n));
      return `${body}.${sig}`;
    },
    verifyToken(token, now) {
      const parts = typeof token === "string" ? token.split(".") : [];
      if (parts.length !== 5) return { ok: false, reason: "malformed" };
      const [dEnc, scope, expRaw, nEnc, sig] = parts as [string, string, string, string, string];
      let deviceId: string;
      let nonce: string;
      try {
        deviceId = Buffer.from(dEnc, "base64url").toString();
        nonce = Buffer.from(nEnc, "base64url").toString();
      } catch {
        return { ok: false, reason: "malformed" };
      }
      const exp = Number(expRaw);
      if (!Number.isFinite(exp) || !DEVICE_SCOPES.includes(scope as DeviceScope)) {
        return { ok: false, reason: "malformed" };
      }
      const expected = sign(secret, payloadOf(deviceId, scope, exp, nonce));
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        return { ok: false, reason: "bad-signature" };
      if (now >= exp) return { ok: false, reason: "expired" };
      const rec = index.get(deviceId);
      if (!rec) return { ok: false, reason: "unknown-device" };
      if (rec.revoked_at) return { ok: false, reason: "revoked" };
      if (!rec.scopes.includes(scope as DeviceScope))
        return { ok: false, reason: "scope-not-granted" };
      // Single-use gate — LAST, only for an otherwise-valid token, so a replay of a tampered/revoked/
      // expired token never consumes a nonce slot (that would be a DoS lever). Atomic consume: two
      // concurrent verifies of the same token yield exactly one "fresh"; the rest are "replay".
      // Key on the base64url device+nonce parts (neither contains `.`) — unambiguous even if the
      // decoded deviceId contains spaces or NUL bytes.
      const consumed = nonceStore.consume(`${dEnc}.${nEnc}`, exp, now);
      if (consumed === "replay") return { ok: false, reason: "replayed" };
      if (consumed === "store-full") return { ok: false, reason: "nonce-store-full" };
      // Fail closed: if the durable nonce store could not be locked we cannot rule out a replay, so
      // we must DENY rather than accept an unverifiable token.
      if (consumed === "unavailable") return { ok: false, reason: "nonce-unavailable" };
      return { ok: true, deviceId, scope: scope as DeviceScope, expiresAt: exp };
    },
  };
}

// ── file-backed store (admin-tier local; never synced) ───────────────────────────────────────────────

export function deviceRegistryPath(root: string): string {
  return path.join(root, INBOX_DIR_REL, DEVICE_REGISTRY_BASENAME);
}

/** A durable JSON-file `DeviceStore` under `.aios/loop/inbox/` (admin-tier; default-denied at sync). */
export function fileDeviceStore(root: string): DeviceStore {
  const file = deviceRegistryPath(root);
  return {
    load() {
      if (!existsSync(file)) return [];
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { devices?: DeviceRecord[] };
        return Array.isArray(parsed.devices) ? parsed.devices : [];
      } catch {
        return [];
      }
    },
    save(records) {
      mkdirSync(path.dirname(file), { recursive: true });
      const body = { registry_version: DEVICE_REGISTRY_VERSION, devices: records };
      writeFileSync(file, JSON.stringify(body, null, 2) + "\n", "utf8");
    },
  };
}

/** A simple in-memory `DeviceStore` (tests + the verify script's `--self-test`). */
export function memoryDeviceStore(seed: readonly DeviceRecord[] = []): DeviceStore {
  let state: DeviceRecord[] = seed.map((r) => ({ ...r, scopes: [...r.scopes] }));
  return {
    load() {
      return state.map((r) => ({ ...r, scopes: [...r.scopes] }));
    },
    save(records) {
      state = records.map((r) => ({ ...r, scopes: [...r.scopes] }));
    },
  };
}

// ── nonce store implementations ──────────────────────────────────────────────────────────────────────

export const NONCE_STORE_BASENAME = "device-nonces.json";
export const NONCE_STORE_REL = `${INBOX_DIR_REL}/${NONCE_STORE_BASENAME}`;

/** Drop expired entries in place; return the surviving count. */
function pruneExpired(map: Map<string, number>, now: number): number {
  for (const [k, exp] of map) if (exp <= now) map.delete(k);
  return map.size;
}

/**
 * In-memory consumed-nonce store, bounded at `maxEntries` (DoS bound). Atomic in a single-threaded
 * Node process: `consume` is synchronous check-and-set, so two verifies of the same token in the same
 * tick can never both get "fresh". Not durable across restarts on its own — pair the coordinator with
 * `fileNonceStore` for that.
 */
export function memoryNonceStore(maxEntries: number = DEFAULT_MAX_NONCES): NonceStore {
  const seen = new Map<string, number>();
  return {
    consume(key, expiresAt, now) {
      pruneExpired(seen, now);
      if (seen.has(key)) return "replay";
      if (seen.size >= maxEntries) return "store-full"; // fail closed rather than grow unbounded
      seen.set(key, expiresAt);
      return "fresh";
    },
    size(now) {
      return pruneExpired(seen, now);
    },
  };
}

function nonceStorePath(root: string): string {
  return path.join(root, INBOX_DIR_REL, NONCE_STORE_BASENAME);
}

/** Thrown when the nonce lock cannot be acquired within the bounded retry budget. Callers in the
 *  verify path translate this to the fail-closed `unavailable` result (deny), never to acceptance. */
class NonceLockError extends Error {
  constructor() {
    super("device-identity: could not acquire nonce lock");
    this.name = "NonceLockError";
  }
}

// A minimal exclusive-lock discipline (asks-store style) so a cross-process consume is atomic.
function withNonceLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const staleMs = 10_000;
  const retries = 100;
  const delayMs = 10;
  let fd: number | null = null;
  for (let attempt = 0; attempt <= retries && fd === null; attempt++) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > staleMs;
      } catch {
        stale = false;
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* lost the reclaim race — retry */
        }
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  if (fd === null) throw new NonceLockError();
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      /* best-effort release */
    }
  }
}

/**
 * Durable, file-backed consumed-nonce store under `.aios/loop/inbox/` — replays are rejected across
 * process restarts (the coordinator reloads consumed nonces on every consume). Cross-process atomic
 * via an exclusive lockfile. Bounded: expired entries are pruned on every consume, and the store
 * fails closed at `maxEntries` (DoS bound) rather than growing without limit. Admin-tier local; never
 * synced (content-free — just opaque nonce keys + numeric expiries).
 */
export function fileNonceStore(root: string, maxEntries: number = DEFAULT_MAX_NONCES): NonceStore {
  const file = nonceStorePath(root);
  const lock = file + ".lock";
  const read = (): Map<string, number> => {
    if (!existsSync(file)) return new Map();
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { nonces?: Record<string, number> };
      const map = new Map<string, number>();
      if (parsed && parsed.nonces && typeof parsed.nonces === "object") {
        for (const [k, v] of Object.entries(parsed.nonces)) {
          if (typeof v === "number" && Number.isFinite(v)) map.set(k, v);
        }
      }
      return map;
    } catch {
      return new Map();
    }
  };
  const write = (map: Map<string, number>): void => {
    const nonces: Record<string, number> = {};
    for (const [k, v] of map) nonces[k] = v;
    writeFileSync(file, JSON.stringify({ store_version: 1, nonces }, null, 2) + "\n", "utf8");
  };
  return {
    consume(key, expiresAt, now) {
      try {
        return withNonceLock(lock, () => {
          const map = read();
          pruneExpired(map, now);
          if (map.has(key)) {
            write(map); // persist the prune even on a replay
            return "replay";
          }
          if (map.size >= maxEntries) {
            write(map);
            return "store-full";
          }
          map.set(key, expiresAt);
          write(map);
          return "fresh";
        });
      } catch (e) {
        // Fail closed: an un-lockable durable store means we cannot prove single-use → deny.
        if (e instanceof NonceLockError) return "unavailable";
        throw e;
      }
    },
    size(now) {
      try {
        return withNonceLock(lock, () => {
          const map = read();
          const n = pruneExpired(map, now);
          write(map);
          return n;
        });
      } catch (e) {
        if (e instanceof NonceLockError) return -1; // unknown (contended) — caller decides
        throw e;
      }
    },
  };
}

/**
 * Convenience for the coordinator: a device registry wired to the DURABLE file-backed device store +
 * file-backed nonce store under `root`. This is the production wiring — enrollment/revocation AND
 * replay-protection all survive a restart. (Tests use the in-memory variants for determinism.)
 */
export function createHostDeviceRegistry(root: string, secret: string): DeviceRegistry {
  return createDeviceRegistry(fileDeviceStore(root), secret, { nonceStore: fileNonceStore(root) });
}
