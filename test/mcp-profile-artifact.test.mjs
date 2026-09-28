import { fixtureOwner } from "./lib/mcp-host-fixture.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareProfileArtifact } from "../scripts/mcp-profile-artifact.mjs";
import { verifyProfileArtifactReceipt } from "../scripts/mcp-artifact-receipt.mjs";

test("profile setup refuses missing release pins and invalid candidate integrity before filesystem writes", async () => {
  const options = {
    mode: "brain-only",
    policy: { snapshot: () => assert.fail("must not touch disk") },
  };
  await assert.rejects(prepareProfileArtifact(options), { code: "UNAVAILABLE" });
  await assert.rejects(
    prepareProfileArtifact({
      ...options,
      artifactInput: {
        profileVersion: "1.0.0",
        packageName: "@aiosbrain/mcp",
        packageVersion: "0.2.1",
        integrity: "sha512-wrong",
        tarball: Buffer.from("candidate"),
      },
    }),
    { code: "UNAVAILABLE" }
  );
});

test("launch receipt rejects changed installed entrypoint and escaping file reference", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profile-receipt-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    "package.json": '{"name":"@aiosbrain/mcp","version":"0.2.1"}',
    "entry.mjs": "export {};",
  };
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(root, name), content, { mode: 0o600 });
  const receipt = {
    version: 1,
    packageName: "@aiosbrain/mcp",
    packageVersion: "0.2.1",
    packageRoot: root,
    entrypoint: "entry.mjs",
    integrity: "sha512-YQ==",
    hashes: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        createHash("sha256").update(content).digest("hex"),
      ])
    ),
  };
  const file = path.join(root, "receipt.json");
  fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  for (const target of [root, ...Object.keys(files).map((name) => path.join(root, name)), file])
    fixtureOwner(target);
  assert.equal(verifyProfileArtifactReceipt(file).packageVersion, "0.2.1");
  fs.writeFileSync(path.join(root, "entry.mjs"), "changed");
  assert.throws(() => verifyProfileArtifactReceipt(file), { code: "UNAVAILABLE" });
  receipt.hashes["../outside"] = "digest";
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => verifyProfileArtifactReceipt(file), { code: "UNAVAILABLE" });
});

test("launch verifies every artifact path owner/ACL and writable intermediate directories", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profile-acl-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, "package"),
    bin = path.join(pkg, "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const files = {
    "package.json": '{"name":"@aiosbrain/mcp","version":"0.2.1"}',
    "bin/entry.mjs": "export {};",
  };
  for (const [name, value] of Object.entries(files))
    fs.writeFileSync(path.join(pkg, name), value, { mode: 0o600 });
  const receipt = {
    version: 1,
    packageName: "@aiosbrain/mcp",
    packageVersion: "0.2.1",
    packageRoot: pkg,
    entrypoint: "bin/entry.mjs",
    integrity: "sha512-YQ==",
    hashes: Object.fromEntries(
      Object.entries(files).map(([name, value]) => [
        name,
        createHash("sha256").update(value).digest("hex"),
      ])
    ),
  };
  const file = path.join(root, "receipt.json");
  fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  for (const unsafe of [pkg, bin, path.join(pkg, "package.json"), path.join(bin, "entry.mjs")]) {
    const visited = [];
    const readAcl = (target) => {
      visited.push(target);
      return {
        owner: "owner",
        current: "owner",
        allow: target === unsafe ? ["owner", "foreign"] : ["owner"],
      };
    };
    assert.throws(() => verifyProfileArtifactReceipt(file, { platform: "win32", readAcl }), {
      code: "UNAVAILABLE",
    });
    assert.ok(visited.includes(unsafe));
  }
  if (process.platform !== "win32") {
    fs.chmodSync(bin, 0o777);
    assert.throws(() => verifyProfileArtifactReceipt(file), { code: "UNAVAILABLE" });
    fs.chmodSync(bin, 0o700);
    assert.equal(verifyProfileArtifactReceipt(file).packageVersion, "0.2.1");
  }
});

import { filePolicy } from "../scripts/mcp-host-files.mjs";
import { profileArtifactFixture } from "./lib/mcp-profile-artifact-fixture.mjs";
test("standalone setup stages the verified closure, reuses it, and refuses changed or unsafe destinations", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profile-stage-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fixtureOwner(home);
  const artifactInput = profileArtifactFixture(home);
  const options = {
    mode: "brain-only",
    profileId: "demo",
    home,
    policy: filePolicy(),
    artifactInput,
  };
  const preview = await prepareProfileArtifact({ ...options, dryRun: true });
  assert.equal(
    fs.existsSync(path.join(home, ".aios")),
    false,
    "preview makes no artifact directory"
  );
  const result = await prepareProfileArtifact(options);
  assert.deepEqual(result.command, preview.command);
  const receiptPath = result.command.args[result.command.args.indexOf("--artifact-receipt") + 1];
  assert.equal(verifyProfileArtifactReceipt(receiptPath).packageName, "@aiosbrain/mcp");
  const before = fs.statSync(receiptPath).mtimeMs;
  assert.deepEqual((await prepareProfileArtifact(options)).command, result.command);
  assert.equal(fs.statSync(receiptPath).mtimeMs, before, "safe reuse does not rewrite the receipt");
  fs.appendFileSync(result.command.args[0], "\n// changed executable\n");
  await assert.rejects(prepareProfileArtifact(options), { code: "UNAVAILABLE" });
  fs.unlinkSync(receiptPath);
  await assert.rejects(prepareProfileArtifact(options), /incomplete profile artifact/);
  if (process.platform !== "win32") {
    const linked = path.join(home, "linked");
    fs.symlinkSync(home, linked);
    await assert.rejects(prepareProfileArtifact({ ...options, home: linked }), /Unsafe directory/);
  }
});
