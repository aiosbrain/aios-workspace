import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BUNDLE_SCHEMA_VERSION,
  PAYLOAD_FILES,
  installBundle,
  packBundle,
} from "../scripts/coverage-bundle.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/coverage-bundle.mjs", import.meta.url));
const IDENTITY = Object.freeze({
  repository: "aiosbrain/aios-workspace",
  sha: "a".repeat(40),
  runId: "30908530200",
});

function writeCoverage(source) {
  mkdirSync(source);
  writeFileSync(
    path.join(source, "coverage-summary.json"),
    `${JSON.stringify({ total: { lines: { total: 2, covered: 1, pct: 50 } } })}\n`
  );
  writeFileSync(
    path.join(source, "lcov.info"),
    "TN:\nSF:scripts/example.mjs\nDA:1,1\nend_of_record\n"
  );
  writeFileSync(
    path.join(source, "coverage-baseline-candidate.json"),
    `${JSON.stringify({ minimum: { lines: 50 } })}\n`
  );
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "coverage-bundle-test-"));
  const source = path.join(root, "source");
  const bundle = path.join(root, "bundle");
  const dest = path.join(root, "coverage");
  writeCoverage(source);
  return { root, source, bundle, dest };
}

function packedFixture() {
  const result = fixture();
  packBundle({ source: result.source, out: result.bundle, ...IDENTITY });
  return result;
}

function editManifest(bundle, edit) {
  const file = path.join(bundle, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  edit(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function withFixture(make, run) {
  const value = make();
  try {
    return run(value);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
}

test("pack and install publish one exact-identity, digest-verified bundle", () =>
  withFixture(fixture, ({ source, bundle, dest }) => {
    const manifest = packBundle({ source, out: bundle, ...IDENTITY });
    assert.equal(manifest.schemaVersion, BUNDLE_SCHEMA_VERSION);
    assert.deepEqual(readdirSync(bundle).sort(), [...PAYLOAD_FILES, "manifest.json"].sort());
    for (const name of PAYLOAD_FILES) {
      assert.equal(manifest.files[name].bytes, readFileSync(path.join(source, name)).length);
      assert.match(manifest.files[name].sha256, /^[0-9a-f]{64}$/);
    }

    assert.deepEqual(installBundle({ bundle, dest, ...IDENTITY }), manifest);
    assert.deepEqual(readdirSync(dest).sort(), readdirSync(bundle).sort());
    for (const name of [...PAYLOAD_FILES, "manifest.json"]) {
      assert.deepEqual(readFileSync(path.join(dest, name)), readFileSync(path.join(bundle, name)));
    }
  }));

test("the CLI exposes the documented pack and install contract", () =>
  withFixture(fixture, ({ source, bundle, dest }) => {
    const identityArgs = [
      "--repository",
      IDENTITY.repository,
      "--sha",
      IDENTITY.sha,
      "--run-id",
      IDENTITY.runId,
    ];
    const packed = spawnSync(
      process.execPath,
      [SCRIPT, "pack", "--source", source, "--out", bundle, ...identityArgs],
      { encoding: "utf8" }
    );
    assert.equal(packed.status, 0, packed.stderr);
    const installed = spawnSync(
      process.execPath,
      [SCRIPT, "install", "--bundle", bundle, "--dest", dest, ...identityArgs],
      { encoding: "utf8" }
    );
    assert.equal(installed.status, 0, installed.stderr);
  }));

test("pack rejects every missing required source without creating output", async (t) => {
  for (const name of PAYLOAD_FILES) {
    await t.test(name, () =>
      withFixture(fixture, ({ source, bundle }) => {
        unlinkSync(path.join(source, name));
        assert.throws(() => packBundle({ source, out: bundle, ...IDENTITY }), /is missing/);
        assert.equal(readdirSync(path.dirname(bundle)).includes(path.basename(bundle)), false);
      })
    );
  }
});

test("pack rejects symlinked source payloads", () =>
  withFixture(fixture, ({ root, source, bundle }) => {
    const target = path.join(root, "outside-summary.json");
    writeFileSync(target, '{"total":{}}\n');
    unlinkSync(path.join(source, "coverage-summary.json"));
    symlinkSync(target, path.join(source, "coverage-summary.json"));
    assert.throws(() => packBundle({ source, out: bundle, ...IDENTITY }), /must not be a symlink/);
  }));

test("install rejects each missing bundle file and leaves destination absent", async (t) => {
  for (const name of [...PAYLOAD_FILES, "manifest.json"]) {
    await t.test(name, () =>
      withFixture(packedFixture, ({ bundle, dest }) => {
        unlinkSync(path.join(bundle, name));
        assert.throws(() => installBundle({ bundle, dest, ...IDENTITY }), /invalid file set/);
        assert.equal(readdirSync(path.dirname(dest)).includes(path.basename(dest)), false);
      })
    );
  }
});

test("install rejects unexpected and non-regular bundle entries", () =>
  withFixture(packedFixture, ({ bundle, dest }) => {
    writeFileSync(path.join(bundle, "unexpected.txt"), "nope");
    assert.throws(() => installBundle({ bundle, dest, ...IDENTITY }), /unexpected/);
    unlinkSync(path.join(bundle, "unexpected.txt"));
    unlinkSync(path.join(bundle, "lcov.info"));
    mkdirSync(path.join(bundle, "lcov.info"));
    assert.throws(() => installBundle({ bundle, dest, ...IDENTITY }), /regular file/);
  }));

test("install rejects symlinked bundle roots and payload entries", () =>
  withFixture(packedFixture, ({ root, bundle, dest }) => {
    const bundleLink = path.join(root, "bundle-link");
    symlinkSync(bundle, bundleLink);
    assert.throws(
      () => installBundle({ bundle: bundleLink, dest, ...IDENTITY }),
      /must not be a symlink/
    );
    const target = path.join(root, "outside-lcov.info");
    writeFileSync(target, "TN:\nSF:x.mjs\nend_of_record\n");
    unlinkSync(path.join(bundle, "lcov.info"));
    symlinkSync(target, path.join(bundle, "lcov.info"));
    assert.throws(() => installBundle({ bundle, dest, ...IDENTITY }), /must not be a symlink/);
  }));

test("install rejects malformed and non-canonical manifests", () => {
  withFixture(packedFixture, ({ bundle, dest }) => {
    writeFileSync(path.join(bundle, "manifest.json"), "{not-json\n");
    assert.throws(() => installBundle({ bundle, dest, ...IDENTITY }), /valid JSON/);
  });
  withFixture(packedFixture, ({ bundle, dest }) => {
    editManifest(bundle, (manifest) => {
      manifest.unexpected = true;
    });
    assert.throws(() => installBundle({ bundle, dest, ...IDENTITY }), /keys must be exactly/);
  });
  withFixture(packedFixture, ({ bundle, dest }) => {
    editManifest(bundle, (manifest) => {
      manifest.schemaVersion = 99;
    });
    assert.throws(() => installBundle({ bundle, dest, ...IDENTITY }), /schemaVersion/);
  });
});

test("install rejects repository, SHA, and run identity mismatches", async (t) => {
  for (const [field, value] of [
    ["repository", "aiosbrain/not-this-repo"],
    ["sha", "b".repeat(40)],
    ["runId", "30908530201"],
  ]) {
    await t.test(field, () =>
      withFixture(packedFixture, ({ bundle, dest }) => {
        assert.throws(
          () => installBundle({ bundle, dest, ...IDENTITY, [field]: value }),
          new RegExp(field)
        );
        assert.equal(readdirSync(path.dirname(dest)).includes(path.basename(dest)), false);
      })
    );
  }
});

test("install rejects declared size and digest mismatches", () => {
  for (const field of ["bytes", "sha256"]) {
    withFixture(packedFixture, ({ bundle, dest }) => {
      editManifest(bundle, (manifest) => {
        manifest.files["lcov.info"][field] = field === "bytes" ? 999 : "b".repeat(64);
      });
      assert.throws(
        () => installBundle({ bundle, dest, ...IDENTITY }),
        new RegExp(field === "bytes" ? "byte length" : "digest")
      );
    });
  }
});

test("install rejects payload mutation and malformed JSON", () => {
  withFixture(packedFixture, ({ bundle, dest }) => {
    writeFileSync(path.join(bundle, "lcov.info"), "TN:\nSF:changed.mjs\nend_of_record\n");
    assert.throws(() => installBundle({ bundle, dest, ...IDENTITY }), /(?:length|digest)/);
  });
  withFixture(packedFixture, ({ bundle, dest }) => {
    writeFileSync(path.join(bundle, "coverage-summary.json"), "not-json\n");
    assert.throws(() => installBundle({ bundle, dest, ...IDENTITY }), /valid JSON/);
  });
});

test("an interrupted install cleans staging and leaves destination absent", () =>
  withFixture(packedFixture, ({ root, bundle, dest }) => {
    assert.throws(
      () =>
        installBundle(
          { bundle, dest, ...IDENTITY },
          { afterStage: () => assert.fail("interrupt") }
        ),
      /interrupt/
    );
    assert.equal(readdirSync(root).includes(path.basename(dest)), false);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith(".coverage.install-")),
      false
    );
  }));

test("install never overwrites an existing scanner destination", () =>
  withFixture(packedFixture, ({ bundle, dest }) => {
    mkdirSync(dest);
    writeFileSync(path.join(dest, "owned.txt"), "keep");
    assert.throws(() => installBundle({ bundle, dest, ...IDENTITY }), /already exists/);
    assert.equal(readFileSync(path.join(dest, "owned.txt"), "utf8"), "keep");
  }));

test("a copied bundle remains independently verifiable", () =>
  withFixture(packedFixture, ({ root, bundle }) => {
    const copy = path.join(root, "artifact-download");
    const dest = path.join(root, "installed-copy");
    cpSync(bundle, copy, { recursive: true });
    installBundle({ bundle: copy, dest, ...IDENTITY });
    assert.deepEqual(readdirSync(dest).sort(), [...PAYLOAD_FILES, "manifest.json"].sort());
  }));
