import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(path.join(ROOT, "docs/contract/gateway-v1.10.json"), "utf8")
);

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

test("gateway fixture discovers all frozen routes, tools, and negative families", () => {
  assert.deepEqual(Object.keys(fixture.routes).sort(), [
    "authorizeAndRedeem",
    "recordOutcome",
    "resolveLease",
  ]);
  assert.equal(Object.keys(fixture.tools.definitions).length, 7);
  assert.equal(fixture.tools.hashVectors.length, 7);
  assert.deepEqual(fixture.tools.negativeVectors.map((v) => v.name).sort(), [
    "dot-path",
    "fractional-page",
    "unknown-field",
  ]);
  assert.equal(fixture.transport.rawRequestLimitBytes, 65_536);
});

test("fixed normalized argument JCS and request hashes are reproducible", () => {
  for (const vector of fixture.tools.hashVectors) {
    const canonical = jcs(vector.normalizedArgs);
    assert.equal(canonical, vector.jcs, vector.name);
    assert.equal(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
      vector.requestHash,
      vector.name
    );
  }
});

test("service credential vector proves grammar and secret-byte hashing", () => {
  const vector = fixture.serviceAuthentication.vector;
  const match = new RegExp(fixture.serviceAuthentication.bearerPattern).exec(vector.bearer);
  assert.ok(match);
  assert.equal(match[1], vector.credentialId);
  assert.equal(match[2], vector.materialBase64url);
  assert.equal(Buffer.from(vector.credentialId, "base64url").length, 16);
  const secretBytes = Buffer.from(vector.materialBase64url, "base64url");
  assert.equal(secretBytes.length, 32);
  assert.equal(createHash("sha256").update(secretBytes).digest("hex"), vector.storedDigest);
});

test("independent seal and open reproduce the protected credential vector", () => {
  const vector = fixture.sealedCredential.vector;
  const secret = Buffer.from(vector.materialBytesHex, "hex");
  const salt = createHash("sha256")
    .update(fixture.sealedCredential.kdf.saltInputAscii, "ascii")
    .digest();
  assert.equal(salt.toString("hex"), vector.saltHex);
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
  const encrypted = Buffer.concat([
    cipher.update(vector.plaintextUtf8, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const sealed = `v1.${header.toString("base64url")}.${nonce.toString("base64url")}.${encrypted.toString("base64url")}`;
  assert.equal(sealed, vector.sealed);

  const parts = sealed.split(".");
  const payload = Buffer.from(parts[3], "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64url"));
  decipher.setAAD(Buffer.from(parts[1], "base64url"));
  decipher.setAuthTag(payload.subarray(-16));
  assert.equal(
    Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString("utf8"),
    vector.plaintextUtf8
  );
});
