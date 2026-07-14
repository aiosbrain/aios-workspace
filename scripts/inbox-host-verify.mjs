#!/usr/bin/env node
/**
 * inbox-host-verify.mjs — the DEPLOY VERIFICATION script for the Fly coordinator (I-15 / AIO-396).
 *
 * Exits 0 ONLY when all three pilot-host guarantees hold:
 *   • ISOLATION   — an adapter uid/container cannot read another adapter's credential (scope + path),
 *                   and no credential is granted to two adapters (`crossScopeLeaks` empty).
 *   • ENROLLMENT  — an enrolled device reaches the read-model API with a scoped token.
 *   • REVOCATION  — a revoked device is rejected even with a structurally valid token.
 *
 * Two modes:
 *   --self-test  Runs every check against the SAME compiled isolation/identity logic using local
 *                fixtures (fake broker scopes + in-memory device registry). Deterministic, no host,
 *                no secrets — this is what the test suite drives, and it proves the LOGIC the live run
 *                depends on. DEFAULT when no --live is given.
 *   --live       Runs the checks against the REAL Fly machine (env: AIOS_HOST_URL, AIOS_HOST_SECRET,
 *                per-adapter uids). *** MERGE-GATED ***: the authorized live Fly deployment is gated
 *                until I-11 / PR #321 is merged. Do NOT run --live before then — it will refuse.
 *
 * Usage:
 *   node scripts/inbox-host-verify.mjs [--self-test] [--json]
 *   node scripts/inbox-host-verify.mjs --live   (only after I-11 merges + Fly app is provisioned)
 */

import { loadOperatorLoop } from "./operator-loop-loader.mjs";
import { c } from "./cli-common.mjs";

// ── fixtures for --self-test (the isolation config a provisioned host would carry) ───────────────────

/** Two adapters, each scoped to ONLY its own credential key. This is the isolation invariant. */
const FIXTURE_SCOPES = {
  gmail: ["gmail.oauth-token"],
  telegram: ["telegram.bot-token"],
};
const FIXTURE_SECRETS = {
  "gmail.oauth-token": "fixture-gmail-token",
  "telegram.bot-token": "fixture-telegram-token",
};
const FIXTURE_SANDBOXES = {
  gmail: {
    adapter: "gmail",
    uid: 10001,
    allowedPathPrefixes: ["/data/adapters/gmail"],
    allowedEgressHosts: ["gmail.googleapis.com", "oauth2.googleapis.com"],
  },
  telegram: {
    adapter: "telegram",
    uid: 10002,
    allowedPathPrefixes: ["/data/adapters/telegram"],
    allowedEgressHosts: ["api.telegram.org"],
  },
};

function selfTest(loop) {
  const steps = [];
  const check = (name, pass, detail) => steps.push({ name, pass, detail });

  // ISOLATION 1 — scope map has no shared credential (config lint).
  const leaks = loop.crossScopeLeaks(FIXTURE_SCOPES);
  check(
    "isolation:no-shared-credentials",
    leaks.length === 0,
    leaks.length ? JSON.stringify(leaks) : "each credential granted to exactly one adapter"
  );

  // ISOLATION 2 — a broker read of ANOTHER adapter's credential throws (default-deny scope).
  const broker = loop.createCredentialBroker(FIXTURE_SCOPES, (k) => FIXTURE_SECRETS[k]);
  let crossDenied = false;
  try {
    broker.read("telegram", "gmail.oauth-token");
  } catch (e) {
    crossDenied = e instanceof loop.CredentialScopeError;
  }
  const ownAllowed =
    broker.read("gmail", "gmail.oauth-token") === FIXTURE_SECRETS["gmail.oauth-token"];
  check(
    "isolation:cross-adapter-credential-denied",
    crossDenied && ownAllowed,
    crossDenied
      ? "telegram→gmail token read rejected; gmail→own token allowed"
      : "cross-read was NOT denied"
  );

  // ISOLATION 3 — the fs fence: adapter A cannot read adapter B's credential PATH.
  const bPath = "/data/adapters/telegram/session.key";
  const aReadsB = loop.checkPathAccess(FIXTURE_SANDBOXES.gmail, bPath);
  const aReadsOwn = loop.checkPathAccess(
    FIXTURE_SANDBOXES.gmail,
    "/data/adapters/gmail/token.json"
  );
  const escapeBlocked = !loop.checkPathAccess(
    FIXTURE_SANDBOXES.gmail,
    "/data/adapters/gmail/../telegram/session.key"
  );
  check(
    "isolation:cross-adapter-path-denied",
    !aReadsB && aReadsOwn && escapeBlocked,
    `gmail→telegram path ${aReadsB ? "READABLE (BAD)" : "denied"}; own path ${aReadsOwn ? "ok" : "BAD"}; traversal ${escapeBlocked ? "blocked" : "ESCAPED (BAD)"}`
  );

  // ENROLLMENT — an enrolled device reaches the read-model API with a scoped token.
  const store = loop.memoryDeviceStore();
  const registry = loop.createDeviceRegistry(store, "self-test-host-secret");
  const now = 1_000_000;
  registry.enroll("device-A", ["read-model"], new Date(now).toISOString());
  const token = registry.mintToken({
    deviceId: "device-A",
    scope: "read-model",
    expiresAt: now + 60_000,
    nonce: "n1",
  });
  const enrolledVerify = registry.verifyToken(token, now + 1_000);
  check(
    "enrollment:scoped-token-accepted",
    enrolledVerify.ok === true && enrolledVerify.scope === "read-model",
    enrolledVerify.ok
      ? "enrolled device accepted for read-model"
      : `rejected: ${enrolledVerify.reason}`
  );

  // REPLAY — the SAME token, already consumed above, is rejected on a second use (single-use nonce).
  const replayVerify = registry.verifyToken(token, now + 1_500);
  check(
    "enrollment:replay-rejected",
    replayVerify.ok === false && replayVerify.reason === "replayed",
    replayVerify.ok ? "replayed token STILL accepted (BAD)" : `rejected: ${replayVerify.reason}`
  );

  // ENROLLMENT (negative) — a token for a scope the device wasn't enrolled for is refused at mint.
  let scopeRefused = false;
  try {
    registry.mintToken({
      deviceId: "device-A",
      scope: "status",
      expiresAt: now + 60_000,
      nonce: "n2",
    });
  } catch {
    scopeRefused = true;
  }
  check(
    "enrollment:unenrolled-scope-refused",
    scopeRefused,
    scopeRefused ? "mint for un-enrolled scope refused" : "un-enrolled scope was minted (BAD)"
  );

  // REVOCATION — a revoked device is rejected even though its token signature is still valid.
  registry.revoke("device-A", new Date(now + 2_000).toISOString());
  const revokedVerify = registry.verifyToken(token, now + 3_000);
  check(
    "revocation:revoked-device-rejected",
    revokedVerify.ok === false && revokedVerify.reason === "revoked",
    revokedVerify.ok ? "revoked device STILL accepted (BAD)" : `rejected: ${revokedVerify.reason}`
  );

  // TAMPER — a field-mutated token fails the signature (belt-and-braces on the identity seam).
  const tampered = token.replace(/\.read-model\./, ".status.");
  const tamperVerify = registry.verifyToken(tampered, now + 1_000);
  check(
    "revocation:tampered-token-rejected",
    tamperVerify.ok === false,
    tamperVerify.ok ? "tampered token accepted (BAD)" : `rejected: ${tamperVerify.reason}`
  );

  return steps;
}

// ── live mode (merge-gated) ──────────────────────────────────────────────────────────────────────────

function liveRefusal() {
  return (
    "inbox-host-verify --live is MERGE-GATED.\n" +
    "  The authorized live Fly deployment is gated until I-11 / PR #321 is merged.\n" +
    "  Before running --live on the provisioned Fly machine, confirm ALL of:\n" +
    "    1. I-11 (AIO-392) merged to main.\n" +
    "    2. `fly deploy` from deploy/fly/fly.toml.template completed for this user's app.\n" +
    "    3. env present: AIOS_HOST_URL, AIOS_HOST_SECRET, and the per-adapter uids.\n" +
    "  Then --live will: (a) attempt a cross-adapter credential read under each adapter uid and\n" +
    "  require EACCES/scope-denied; (b) enroll a device + GET the read-model API with its scoped\n" +
    "  token (expect 200); (c) revoke it + repeat (expect 401). Output is pasted into the PR.\n" +
    "  See docs/v1-operator-loop/host/provisioning-runbook.md §Deploy + smoke (merge-gated)."
  );
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const asJson = args.has("--json");
  const live = args.has("--live");

  if (live) {
    // Fail closed and loud — never silently "pass" a live check we cannot actually run here.
    console.error(liveRefusal());
    process.exit(2);
  }

  const loop = await loadOperatorLoop();
  const steps = selfTest(loop);
  const ok = steps.every((s) => s.pass);

  if (asJson) {
    console.log(JSON.stringify({ mode: "self-test", ok, checks: steps }, null, 2));
  } else {
    console.log(
      c.blue("inbox host verify") + c.dim("  --self-test (isolation · enrollment · revocation)")
    );
    for (const s of steps)
      console.log(`  ${s.pass ? c.green("✓") : c.red("✗")} ${s.name}  ${c.dim(s.detail)}`);
    console.log(
      ok
        ? c.green("  ✓ isolation, enrollment, and revocation logic verified (self-test)")
        : c.red("  ✗ VERIFY FAILED")
    );
    console.log(
      c.dim(
        "  live verification on the Fly machine is merge-gated (run with --live after I-11 merges)"
      )
    );
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`inbox-host-verify: ${e?.stack || e?.message || e}`);
  process.exit(1);
});
