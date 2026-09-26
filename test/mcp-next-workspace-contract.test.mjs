// Executable specification reference only: these functions do not exercise runtime consumers.
// Runtime conformance is required separately when AIO-1190–1193 implement the reserved API.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const fixtures = JSON.parse(
  readFileSync(new URL("../docs/contract/mcp-next-v1/workspace-fixtures.json", import.meta.url))
);
const grantNames = ["brainActions", "workspaceRead", "workspaceDraft", "workspacePublish"];
const disabled = () => Object.fromEntries(grantNames.map((key) => [key, false]));
const hash = (content) => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function migrate(input) {
  if (!input.setupConsent && Object.values(input.requestedNewProfileGrants ?? {}).some(Boolean))
    return { code: "CAPABILITY_DENIED", writes: 0 };
  if (input.requestedIdenticalProfile)
    return {
      generation: input.existingProfile.generation,
      grants: input.existingProfile.grants,
      changed: false,
    };
  const { schemaVersion: _schemaVersion, ...preserved } = input.legacy;
  return { ...preserved, newProfileGrants: disabled(), cwdFallback: false };
}
function effectiveGrants(input) {
  return Object.fromEntries(
    grantNames.map((key) => [
      key,
      Boolean(input.grants[key] && (!input.readOnly || key === "workspaceRead")),
    ])
  );
}
function authorizePlan(input) {
  if ("storedGeneration" in input && input.storedGeneration !== input.currentGeneration)
    return { code: "PLAN_STALE", sends: 0 };
  if (input.serverAuthorized === false) return { code: "AUTH_REVOKED", sends: 0 };
  if ("storedHash" in input && input.storedHash !== input.currentHash)
    return { code: "PLAN_STALE", sends: 0 };
  if ("applyAt" in input) {
    const created = Date.parse(input.createdAt),
      expiry = Date.parse(input.expiresAt),
      now = Date.parse(input.applyAt);
    assert.equal(expiry - created, 900_000, "stored plan TTL must be exactly fifteen minutes");
    if (now < created || now >= expiry) return { code: "PLAN_EXPIRED", sends: 0 };
  }
  return { execute: true };
}
function evaluate(rule, input) {
  switch (rule) {
    case "migration-defaults":
    case "migration-repeat":
      return migrate(input);
    case "credential-resolution":
      return Object.hasOwn(input.credentialSources, input.profileSource)
        ? { resolvedReferences: [input.credentialSources[input.profileSource]] }
        : { code: "PROFILE_NOT_FOUND", resolvedReferences: [] };
    case "launch-profile":
      return input.launchProfile === input.requestProfile
        ? { accepted: true }
        : { code: "PROFILE_CHANGED", reads: 0, writes: 0 };
    case "grant-intersection":
      return { effectiveGrants: effectiveGrants(input) };
    case "path-identity": {
      const relative = path.posix.relative(input.root, input.resolved);
      return relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)
        ? { code: "PATH_DENIED", bytesRead: 0 }
        : { accepted: true };
    }
    case "file-admission": {
      const content = String.fromCodePoint(
        Number.parseInt(input.contentCodePoint.slice(2), 16)
      ).repeat(input.repeat);
      const utf8Bytes = Buffer.byteLength(content, "utf8");
      return utf8Bytes > 262144 ? { utf8Bytes, code: "LIMIT_EXCEEDED", writes: 0 } : { utf8Bytes };
    }
    case "hash-bytes":
      return { hash: hash(input.utf8) };
    case "expected-hash":
      return input.expectedHash === input.observedHash
        ? { accepted: true }
        : { code: "CONTENT_CONFLICT", writes: 0 };
    case "plan-expiry":
    case "plan-generation":
    case "call-time-authorization":
    case "preview-hash":
      return authorizePlan(input);
    case "setup-consent":
      return {
        additionalApprovalPrompt: false,
        execute: Boolean(
          input.unchangedPlan && input.unexpired && input.publishGrant && input.serverAuthorized
        ),
      };
    case "resume": {
      const allowed = input.unchangedPlan && input.unexpired && input.authorized;
      return {
        sendItemIds: allowed
          ? input.receipts
              .filter((r) => r.state === "not_attempted" || (r.state === "failed" && r.retryable))
              .map((r) => r.itemId)
          : [],
        reuseOperationIds: true,
        replaySucceeded: false,
      };
    }
    case "durable-intent":
      return {
        resolveByOperationIdBeforeResend:
          input.transportOutcome === "timeout" && input.durableIntent,
        newOperationId: false,
      };
    case "publish-tier": {
      const eligibleItems = input.paths.filter((item) =>
        ["team", "external"].includes(item.access)
      ).length;
      return eligibleItems
        ? { eligibleItems }
        : { code: "INVALID_CONTENT", sends: 0, eligibleItems };
    }
    default:
      throw new Error(`Unknown semantic rule: ${rule}`);
  }
}
for (const fixture of fixtures.semantic) {
  test(`workspace reference semantics: ${fixture.name}`, () =>
    assert.deepEqual(evaluate(fixture.rule, fixture.input), fixture.expected));
}
test("workspace reference admits an unexpired plan, but not a rolled-back clock", () => {
  assert.deepEqual(
    authorizePlan({
      createdAt: "2026-09-24T10:00:00Z",
      expiresAt: "2026-09-24T10:15:00Z",
      applyAt: "2026-09-24T10:14:59Z",
    }),
    { execute: true }
  );
  assert.deepEqual(
    authorizePlan({
      createdAt: "2026-09-24T10:00:00Z",
      expiresAt: "2026-09-24T10:15:00Z",
      applyAt: "2026-09-24T09:59:59Z",
    }),
    { code: "PLAN_EXPIRED", sends: 0 }
  );
  assert.equal(same(effectiveGrants({ grants: disabled(), readOnly: false }), disabled()), true);
});
