// Unified inbox — remote-access device identity (I-15 / AIO-396, G6b).
//
// The remote-access workstream G6a deliberately skipped: device identity + enrollment + revocation +
// scoped tokens for the GUI/CLI reaching the remote read-model API. No bare port exposure — every
// request to the read-model API carries a token minted for an ENROLLED device, scoped to a capability
// (`read-model` for `aios inbox --json`, `status` for `aios inbox status`). A REVOKED device is
// rejected even with a structurally valid token.
//
// The token is a stateless HMAC over `deviceId · scope · exp · nonce` under a host secret, so
// verification needs no round-trip; revocation is enforced against the durable registry (a revoked or
// unknown device fails even if the signature is valid and unexpired). Tamper of any field — device,
// scope, or expiry — invalidates the signature. This is inbox-domain host logic; it value-imports
// only `node:crypto` + node fs. The host secret and the registry are admin-tier local state, never
// synced.

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  "malformed" | "bad-signature" | "expired" | "unknown-device" | "revoked" | "scope-not-granted";

export type DeviceVerifyResult =
  | { ok: true; deviceId: string; scope: DeviceScope; expiresAt: number }
  | { ok: false; reason: DeviceVerifyReason };

/** Durable store for the device registry (injectable so tests can use an in-memory backing). */
export interface DeviceStore {
  load(): DeviceRecord[];
  save(records: readonly DeviceRecord[]): void;
}

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
  /** Mint a token for an enrolled, non-revoked device scoped to `scope`. Throws otherwise. */
  mintToken(input: {
    deviceId: string;
    scope: DeviceScope;
    expiresAt: number;
    nonce: string;
  }): string;
  /** Verify a token: signature, expiry, enrollment, revocation, and scope grant — all default-deny. */
  verifyToken(token: string, now: number): DeviceVerifyResult;
}

/**
 * Build a device registry over a durable store + a host secret. Enrollment/revocation mutate the
 * store; token verification reads it, so a device revoked on the host is rejected on the next request
 * even though its token signature is still valid — revocation is authoritative, not advisory.
 */
export function createDeviceRegistry(store: DeviceStore, secret: string): DeviceRegistry {
  if (!secret) throw new Error("device-identity: a non-empty host secret is required");
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
      const body = `${b64url(deviceId)}.${scope}.${expiresAt}.${b64url(nonce)}`;
      const sig = sign(secret, payloadOf(deviceId, scope, expiresAt, nonce));
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
