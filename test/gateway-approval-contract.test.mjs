import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(ROOT, "docs/contract", name));
const extensionBytes = read("gateway-approval-v1.10.json");
const fixture = JSON.parse(extensionBytes);

const jcs = (value) => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported JCS value");
};

test("approval fixture pins the byte-addressed AIO-401 base contract", () => {
  assert.equal(fixture.$schema, "aios-gateway-approval-contract/v1.10");
  assert.equal(fixture.versionBoundary.memberApi, "1.9");
  assert.equal(fixture.versionBoundary.internalGateway, "1.10");
  assert.equal(
    createHash("sha256").update(read(fixture.baseContract.path)).digest("hex"),
    fixture.baseContract.sha256
  );
});

test("brain-api externally pins the canonical approval extension bytes", () => {
  const contract = readFileSync(path.join(ROOT, "docs/brain-api.md"), "utf8");
  const pin = contract.match(
    /gateway-approval-v1\.10\.json\)[\s\S]{0,80}?SHA-256\s+`([0-9a-f]{64})`/
  );
  assert.ok(pin, "brain-api.md must publish the extension fixture SHA-256");
  assert.equal(createHash("sha256").update(extensionBytes).digest("hex"), pin[1]);
  assert.notEqual(pin[1], fixture.baseContract.sha256);
});

test("approval fixture discovery counts are exact and non-vacuous", () => {
  const actual = {
    resumeRoutes: 1,
    adminRoutes: Object.keys(fixture.admin.routes).length,
    errors: Object.keys(fixture.transport.errors).length,
    nonEnumerating404Families: fixture.transport.nonEnumerating404.length,
    authorizationRoles: Object.keys(fixture.admin.authorizationMatrix).length,
    policyVectors: fixture.policyPrecedence.vectors.length,
    stateTransitions: fixture.stateMachine.transitions.length,
    outcomeClassifications: fixture.stateMachine.transitions.filter((x) =>
      x.event.startsWith("outcome-")
    ).length,
    cryptographicVectors: Object.keys(fixture.vectors).length,
    securityNeverExpose: fixture.security.neverExpose.length,
  };
  for (const [family, expected] of Object.entries(fixture.discovery.expected)) {
    assert.ok(expected > 0, `${family} expected count must be non-zero`);
    assert.equal(actual[family], expected, family);
  }
});

test("resume schemas freeze the only credential-bearing response", () => {
  assert.equal(fixture.resumeClaim.request.additionalProperties, false);
  assert.deepEqual(fixture.resumeClaim.request.properties.toolkit, {
    const: "aios-github-readonly",
  });
  const claimed = fixture.resumeClaim.responses.claimed;
  const retry = fixture.resumeClaim.responses.alreadyClaimed;
  assert.equal(claimed.credentialBearing, true);
  assert.equal(retry.credentialBearing, false);
  assert.deepEqual(retry.body.forbidden.sort(), [
    "credentialExpiresAt",
    "normalizedArgs",
    "sealedCredential",
  ]);
  assert.equal(fixture.resumeClaim.custody.retryMayDecryptOrReseal, false);
});

test("admin routes, authorization, tagged subjects, and credential metadata are exhaustive", () => {
  assert.deepEqual(
    Object.values(fixture.admin.authorizationMatrix).sort((a, b) => a - b),
    [200, 401, 403, 403, 404, 422]
  );
  assert.deepEqual(
    fixture.admin.policy.subjectSelector.taggedUnion.map((x) => x.type),
    ["actor", "role", "tier", "team"]
  );
  assert.deepEqual(
    fixture.admin.policy.subjectSelector.taggedUnion.find((x) => x.type === "tier").tier,
    ["team", "external"]
  );
  const schemas = fixture.admin.schemas;
  for (const name of [
    "gateway-subject-selector",
    "gateway-policy-mutation",
    "gateway-policy-metadata",
    "gateway-credential-metadata",
  ]) {
    assert.equal(schemas[name].additionalProperties ?? false, false, name);
  }
  for (const route of Object.values(fixture.admin.routes)) {
    assert.ok(route.response, `${route.method} ${route.path} response schema`);
  }
  const rotation = fixture.admin.routes.credentialRotate.request;
  assert.equal(rotation.additionalProperties, false);
  assert.equal(rotation.properties.secret.decodedBytes, 32);
  assert.equal(rotation.properties.secret.minimumEntropyBits, 256);
  assert.deepEqual(
    fixture.admin.schemas["gateway-subject-selector"].oneOf.find(
      (x) => x.properties.type.const === "tier"
    ).properties.tier.enum,
    ["team", "external"]
  );
  assert.deepEqual(fixture.admin.policy.effects, ["block", "require_approval", "allow"]);
  assert.equal(fixture.admin.policy.storedEffectMapping.block, "deny");
  assert.equal(fixture.admin.rotation.secretReturned, false);
  assert.equal(fixture.admin.rotation.overlapUntilExplicitRevocationOrExpiry, true);
  assert.ok(!fixture.admin.credentialMetadataFieldsExactly.includes("secret"));
});

test("precedence and state transitions preserve the frozen ordering", () => {
  assert.deepEqual(fixture.policyPrecedence.dimensions, [
    ["actor", "role", "tier", "team"],
    ["exact-tool", "wildcard-tool"],
    ["exact-repository", "wildcard-repository"],
    ["highest-numeric-priority"],
    ["block", "require_approval", "allow"],
    ["no-match-blocks"],
  ]);
  assert.equal(
    fixture.policyPrecedence.vectors.find((x) => x.name === "default-deny").winner,
    "block"
  );
  assert.deepEqual(fixture.stateMachine.initial, {
    execution: "approval_required",
    approval: "pending",
  });
  assert.equal(
    fixture.stateMachine.transitions.find((x) => x.event === "claim").approval,
    "approved->approved"
  );
  assert.deepEqual(
    fixture.stateMachine.transitions
      .filter((x) => x.event.startsWith("outcome-"))
      .map((x) => x.classification),
    ["success", "credential", "network", "upstream", "response_too_large", "internal"]
  );
});

test("resume fingerprint and request-envelope hashes reproduce independently", () => {
  const fingerprint = fixture.vectors.resumeFingerprint;
  assert.deepEqual(Object.keys(fingerprint.value).sort(), fingerprint.fields.slice().sort());
  assert.equal(jcs(fingerprint.value), fingerprint.jcs);
  assert.equal(createHash("sha256").update(fingerprint.jcs).digest("hex"), fingerprint.sha256);

  const vector = fixture.vectors.requestEnvelope;
  assert.equal(
    createHash("sha256").update(vector.normalizedArgsJcs).digest("hex"),
    vector.requestHash
  );
  const key = Buffer.from(vector.keyHex, "hex");
  const nonce = Buffer.from(vector.nonceHex, "hex");
  const aad = Buffer.from(vector.aadUtf8, "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(vector.normalizedArgsJcs, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  assert.equal(encrypted.toString("hex"), vector.ciphertextAndTagHex);
  const wire = `v1.${nonce.toString("base64url")}.${encrypted.toString("base64url")}`;
  assert.equal(wire, vector.wire);
  assert.equal(createHash("sha256").update(wire).digest("hex"), vector.wireSha256);
});

test("rotated credential digest and seal are bound to credential version two", () => {
  const vector = fixture.vectors.rotatedCredentialSeal;
  const secret = Buffer.from(vector.materialBase64url, "base64url");
  assert.equal(createHash("sha256").update(secret).digest("hex"), vector.storedDigest);
  const salt = createHash("sha256").update("aios-gateway-sealed-credential:v1", "ascii").digest();
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      salt,
      Buffer.from(`${vector.credentialId}\0${vector.credentialVersion}`),
      32
    )
  );
  assert.equal(key.toString("hex"), vector.derivedMaterialHex);
  const header = Buffer.from(vector.protectedHeaderJcs, "utf8");
  const nonce = Buffer.from(vector.nonceHex, "hex");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const payload = Buffer.concat([
    cipher.update(vector.plaintextUtf8, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const sealed = `v1.${header.toString("base64url")}.${nonce.toString("base64url")}.${payload.toString("base64url")}`;
  assert.equal(sealed, vector.sealed);

  const parts = sealed.split(".");
  const decoded = Buffer.from(parts[3], "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64url"));
  decipher.setAAD(Buffer.from(parts[1], "base64url"));
  decipher.setAuthTag(decoded.subarray(-16));
  assert.equal(
    Buffer.concat([decipher.update(decoded.subarray(0, -16)), decipher.final()]).toString("utf8"),
    vector.plaintextUtf8
  );
});

test("security exclusions cover every sensitive runtime value", () => {
  const excluded = new Set(fixture.security.neverExpose);
  for (const value of [
    "pat",
    "service-secret",
    "credential-ciphertext",
    "encrypted-request-envelope",
    "request-envelope-plaintext",
    "lease",
    "full-request-hash",
    "derived-key",
    "credential-bearing-retry",
  ]) {
    assert.ok(excluded.has(value), value);
  }
  assert.equal(fixture.security.strictAuditRollback, true);
  assert.equal(fixture.security.recursiveCanaryScan, true);
});
