// Direct mutation-sensitive tests for the fail-closed gateway token assertion (AIO-513).
// Keep these separate from the outbox integration tests: wrappers may deliberately transform
// TokenSecurityResult, while this suite pins every field returned by the security boundary itself.
//
// Equivalent survivors after this suite:
// - Replacing the getuid conditional with `false` also selects the documented -1 fallback.
// - Replacing the string literal "function" with "" also selects that same fallback.
// Both are observationally identical when getuid is absent; when it is present, a valid
// current-user-owned token still produces the same success result. All fail-closed result
// semantics (ok/skipped/reason) and the explicit -1 bypass remain mutation-pinned below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertGatewayTokenSecurity } from "../../dist/operator-loop/index.js";

function makeToken(t, mode = 0o600) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-outbox-credential-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, "token");
  writeFileSync(tokenPath, "synthetic-test-token");
  chmodSync(tokenPath, mode);
  return tokenPath;
}

test("win32 is a named fail-closed skip", () => {
  assert.deepEqual(assertGatewayTokenSecurity("C:/unused", { platform: "win32" }), {
    ok: false,
    skipped: true,
    reason: "POSIX mode/ownership checks unsupported on win32 — gateway isolation deferred to G6b",
  });
});

test("a missing token fails closed and names the unreadable path", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-outbox-credential-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, "missing-token");

  assert.deepEqual(assertGatewayTokenSecurity(tokenPath), {
    ok: false,
    skipped: false,
    reason: `token file not found or unreadable: ${tokenPath}`,
  });
});

test("a directory fails closed as a non-regular token file", (t) => {
  const tokenPath = mkdtempSync(path.join(tmpdir(), "aios-outbox-credential-directory-"));
  t.after(() => rmSync(tokenPath, { recursive: true, force: true }));

  assert.deepEqual(assertGatewayTokenSecurity(tokenPath), {
    ok: false,
    skipped: false,
    reason: `token path is not a regular file: ${tokenPath}`,
  });
});

for (const [mode, displayedMode] of [
  [0o400, "0400"],
  [0o644, "0644"],
  [0o660, "0660"],
  [0o755, "0755"],
]) {
  test(`mode ${displayedMode} fails because the token must be exactly 0600`, (t) => {
    const tokenPath = makeToken(t, mode);

    assert.deepEqual(assertGatewayTokenSecurity(tokenPath), {
      ok: false,
      skipped: false,
      reason: `token mode is ${displayedMode} (expected 0600 — gateway-private)`,
    });
  });
}

test("a mismatched positive gateway uid fails and reports both uid values", (t) => {
  const tokenPath = makeToken(t);
  const actualUid = statSync(tokenPath).uid;
  const expectedUid = actualUid + 1;

  assert.deepEqual(assertGatewayTokenSecurity(tokenPath, { expectedUid }), {
    ok: false,
    skipped: false,
    reason: `token owned by uid ${actualUid} (expected gateway uid ${expectedUid})`,
  });
});

test("uid zero remains a checked gateway uid boundary", (t) => {
  const tokenPath = makeToken(t);
  const actualUid = statSync(tokenPath).uid;
  const result = assertGatewayTokenSecurity(tokenPath, { expectedUid: 0 });

  if (actualUid === 0) {
    assert.deepEqual(result, {
      ok: true,
      skipped: false,
      reason: "token is gateway-private (0600, gateway uid)",
    });
  } else {
    assert.deepEqual(result, {
      ok: false,
      skipped: false,
      reason: `token owned by uid ${actualUid} (expected gateway uid 0)`,
    });
  }
});

test("expectedUid -1 explicitly bypasses ownership without changing success semantics", (t) => {
  const tokenPath = makeToken(t);

  assert.deepEqual(assertGatewayTokenSecurity(tokenPath, { expectedUid: -1 }), {
    ok: true,
    skipped: false,
    reason: "token is gateway-private (0600, gateway uid)",
  });
});

test("an unavailable process.getuid uses the documented -1 fallback", (t) => {
  const tokenPath = makeToken(t);
  const originalGetuid = process.getuid;
  process.getuid = undefined;
  try {
    assert.deepEqual(assertGatewayTokenSecurity(tokenPath), {
      ok: true,
      skipped: false,
      reason: "token is gateway-private (0600, gateway uid)",
    });
  } finally {
    process.getuid = originalGetuid;
  }
});

test("an exact 0600 token owned by the expected uid passes with a named reason", (t) => {
  const tokenPath = makeToken(t);
  const actualUid = statSync(tokenPath).uid;

  assert.deepEqual(assertGatewayTokenSecurity(tokenPath, { expectedUid: actualUid }), {
    ok: true,
    skipped: false,
    reason: "token is gateway-private (0600, gateway uid)",
  });
});
