// Unified inbox — per-adapter credential broker + sandbox constraints (I-15 / AIO-396, G6b).
//
// The pilot-host isolation bar (spec §Isolation contract): "credential broker with per-adapter
// scopes; fs/egress constraints; no community-plugin access to other adapters' credentials or the
// store." This module is that broker, expressed as PURE policy so the deploy-verification script can
// assert it without a live host:
//
//   • A `CredentialBroker` mediates every credential read. An adapter may read ONLY the keys in its
//     own scope; a read of another adapter's key (or of the read-model store) throws
//     `CredentialScopeError`. The broker never returns, logs, or embeds the secret VALUE anywhere
//     except the single return to the scoped caller (content-free by construction).
//   • `crossScopeLeaks(scopes)` is a config lint: it reports any credential key granted to more than
//     one adapter — the isolation invariant is "no two adapters share a credential", so a non-empty
//     result is a deploy-blocking finding.
//   • An `AdapterSandbox` captures the fs/egress fence (uid, allowed path prefixes, allowed egress
//     hosts); `checkPathAccess` / `checkEgress` are the pure predicates the verify script drives to
//     prove adapter A cannot read adapter B's credential PATH or reach an un-allowed host.
//
// Self-contained inbox-domain logic; no cross-domain imports.

/** A key that is NEVER grantable to any adapter — the coordinator's read-model store + journal. */
export const STORE_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "read-model.db",
  "inbox-events.ndjson",
  "coordinator.key",
]);

export class CredentialScopeError extends Error {
  readonly adapter: string;
  readonly key: string;
  constructor(adapter: string, key: string, message: string) {
    super(`credential-broker: ${message}`);
    this.name = "CredentialScopeError";
    this.adapter = adapter;
    this.key = key;
  }
}

/** adapter-id → the exact set of credential keys that adapter is allowed to read. */
export type CredentialScopes = Readonly<Record<string, readonly string[]>>;

/** Resolves a credential key to its secret VALUE (reads env/mounted secret/vault). Injected. */
export type CredentialResolver = (key: string) => string | undefined;

export interface CredentialBroker {
  /** True iff `adapter` is scoped to read `key` (and `key` is not a reserved store key). */
  canAccess(adapter: string, key: string): boolean;
  /** Read `key` for `adapter`, or throw `CredentialScopeError`. The value is returned, never logged. */
  read(adapter: string, key: string): string;
  /** The keys `adapter` is scoped to (copy; never the reserved store keys). */
  scopeOf(adapter: string): string[];
}

function normalizeScopes(scopes: CredentialScopes): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [adapter, keys] of Object.entries(scopes)) {
    const set = new Set<string>();
    for (const k of keys) {
      // A reserved store key can never enter a scope — reject the config outright, don't silently drop.
      if (STORE_RESERVED_KEYS.has(k)) {
        throw new CredentialScopeError(
          adapter,
          k,
          `adapter "${adapter}" may not be scoped to reserved store key "${k}"`
        );
      }
      set.add(k);
    }
    out.set(adapter, set);
  }
  return out;
}

/**
 * Build a broker over a static scope map + an injected resolver. Default-deny: an adapter/key pair
 * not present in `scopes` is rejected. Constructing with a scope that includes a reserved store key
 * throws immediately (fail-closed config).
 */
export function createCredentialBroker(
  scopes: CredentialScopes,
  resolver: CredentialResolver
): CredentialBroker {
  const norm = normalizeScopes(scopes);
  return {
    canAccess(adapter, key) {
      if (STORE_RESERVED_KEYS.has(key)) return false;
      return norm.get(adapter)?.has(key) ?? false;
    },
    scopeOf(adapter) {
      return [...(norm.get(adapter) ?? [])].sort();
    },
    read(adapter, key) {
      if (STORE_RESERVED_KEYS.has(key)) {
        throw new CredentialScopeError(
          adapter,
          key,
          `"${key}" is a reserved store key and is never brokered to an adapter`
        );
      }
      const scope = norm.get(adapter);
      if (!scope) {
        throw new CredentialScopeError(
          adapter,
          key,
          `unknown adapter "${adapter}" (not in the scope map)`
        );
      }
      if (!scope.has(key)) {
        throw new CredentialScopeError(
          adapter,
          key,
          `adapter "${adapter}" is not scoped to read "${key}"`
        );
      }
      const value = resolver(key);
      if (value === undefined) {
        throw new CredentialScopeError(
          adapter,
          key,
          `credential "${key}" is scoped but unresolved (missing secret)`
        );
      }
      return value;
    },
  };
}

/** A credential key granted to ≥2 adapters — a violation of the "no shared credentials" invariant. */
export interface CrossScopeLeak {
  key: string;
  adapters: string[];
}

/**
 * Lint a scope map for isolation violations: any credential key granted to more than one adapter.
 * The deploy-verification script treats a non-empty result as a hard failure — one compromised
 * adapter must not be able to reach another channel's tokens.
 */
export function crossScopeLeaks(scopes: CredentialScopes): CrossScopeLeak[] {
  const byKey = new Map<string, string[]>();
  for (const [adapter, keys] of Object.entries(scopes)) {
    for (const k of keys) {
      const arr = byKey.get(k) ?? [];
      arr.push(adapter);
      byKey.set(k, arr);
    }
  }
  const leaks: CrossScopeLeak[] = [];
  for (const [key, adapters] of byKey) {
    if (adapters.length > 1) leaks.push({ key, adapters: [...adapters].sort() });
  }
  return leaks.sort((a, b) => a.key.localeCompare(b.key));
}

// ── fs / egress sandbox (the per-adapter fence) ──────────────────────────────────────────────────────

export interface AdapterSandbox {
  adapter: string;
  /** Dedicated uid the adapter's container runs as (isolation: per-adapter uid, spec §Isolation). */
  uid: number;
  /** Absolute path prefixes the adapter may read/write (its own credential + data dir). */
  allowedPathPrefixes: readonly string[];
  /** Egress host allowlist (e.g. `["gmail.googleapis.com"]`); everything else is denied. */
  allowedEgressHosts: readonly string[];
}

function normalizePath(p: string): string {
  // Collapse `.`/`..` segments so `/a/b/../../etc/passwd` can't escape an allowed prefix.
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** True iff `sandbox` may access `targetPath` (under one of its allowed prefixes, after normalization). */
export function checkPathAccess(sandbox: AdapterSandbox, targetPath: string): boolean {
  const norm = normalizePath(targetPath);
  return sandbox.allowedPathPrefixes.some((prefix) => {
    const np = normalizePath(prefix);
    return norm === np || norm.startsWith(np.endsWith("/") ? np : np + "/");
  });
}

/** True iff `sandbox` may open egress to `host` (exact match against its allowlist). */
export function checkEgress(sandbox: AdapterSandbox, host: string): boolean {
  return sandbox.allowedEgressHosts.includes(host);
}
