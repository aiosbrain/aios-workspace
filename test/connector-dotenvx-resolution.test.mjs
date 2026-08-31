// test/connector-dotenvx-resolution.test.mjs — AIO-1004: the connector vault must resolve
// dotenvx DETERMINISTICALLY, independent of PATH and of npm invocation. A bare
// execFileSync("dotenvx", ...) took Homebrew's 1.52.0 in a plain shell (REPLACES the
// .env.keys block) and the vendored 2.21.0 under `npm run` (APPENDS a second block) —
// same code, opposite write behaviour, which is why a real .env.keys corruption could not
// be reproduced from a plain shell. These tests pin: (a) the resolver's layout semantics
// (checkout / local-hoist / global-nested / missing-package / vendored fallback), and
// (b) the end-to-end property — with a poisoned PATH, inside and outside an npm-style
// PATH, the SAME binary is chosen and the fake one is never executed.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDotenvxInvocation } from "../scripts/connector-vault.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VAULT_MJS = path.join(ROOT, "scripts", "connector-vault.mjs");

function tmpBase() {
  // realpath: on macOS tmpdir() is /var/... which is a symlink to /private/var/..., and
  // require.resolve returns realpaths — keep expected and actual on the same form.
  return realpathSync(mkdtempSync(path.join(tmpdir(), "aio1004-")));
}

/** Plant a fake @dotenvx/dotenvx package under the given node_modules dir. */
function plantDotenvx(nodeModulesDir, { binRel = "src/cli.js" } = {}) {
  const pkgDir = path.join(nodeModulesDir, "@dotenvx", "dotenvx");
  mkdirSync(path.join(pkgDir, path.dirname(binRel)), { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@dotenvx/dotenvx", version: "9.9.9", bin: { dotenvx: binRel } })
  );
  writeFileSync(path.join(pkgDir, binRel), "// fake dotenvx cli entry\n");
  return path.join(pkgDir, binRel);
}

test("checkout layout: dotenvx nested under the toolkit's own node_modules wins", () => {
  const base = tmpBase();
  try {
    const checkout = path.join(base, "aios-workspace");
    const cli = plantDotenvx(path.join(checkout, "node_modules"));
    const got = resolveDotenvxInvocation({
      from: pathToFileURL(path.join(checkout, "scripts", "connector-vault.mjs")).href,
      toolkitRoot: checkout,
    });
    assert.equal(got.command, process.execPath, "resolved entry must run under process.execPath");
    assert.deepEqual(got.args, [cli]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("local-hoist layout: a consumer install that hoists @dotenvx/dotenvx still resolves", () => {
  const base = tmpBase();
  try {
    // npm i in a consumer hoists the dep to consumer/node_modules — the package's own
    // node_modules has no copy (and no .bin). Module resolution walks up and finds it.
    const consumer = path.join(base, "consumer");
    const cli = plantDotenvx(path.join(consumer, "node_modules"));
    const pkgRoot = path.join(consumer, "node_modules", "@aiosbrain", "aios");
    mkdirSync(path.join(pkgRoot, "scripts"), { recursive: true });
    const got = resolveDotenvxInvocation({
      from: pathToFileURL(path.join(pkgRoot, "scripts", "connector-vault.mjs")).href,
      toolkitRoot: pkgRoot,
    });
    assert.equal(got.command, process.execPath);
    assert.deepEqual(got.args, [cli]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("global-nested layout: a global `npm i -g` nests the dep under the package", () => {
  const base = tmpBase();
  try {
    const pkgRoot = path.join(base, "global", "lib", "node_modules", "@aiosbrain", "aios");
    const cli = plantDotenvx(path.join(pkgRoot, "node_modules"));
    const got = resolveDotenvxInvocation({
      from: pathToFileURL(path.join(pkgRoot, "scripts", "connector-vault.mjs")).href,
      toolkitRoot: pkgRoot,
    });
    assert.equal(got.command, process.execPath);
    assert.deepEqual(got.args, [cli]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("missing package: vendored .bin shim, then bare PATH as the final fallback", () => {
  const base = tmpBase();
  try {
    const root = path.join(base, "bare");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    const from = pathToFileURL(path.join(root, "scripts", "connector-vault.mjs")).href;

    // No @dotenvx/dotenvx anywhere, no vendored shim → bare PATH, the actionable resort.
    assert.deepEqual(resolveDotenvxInvocation({ from, toolkitRoot: root }), {
      command: "dotenvx",
      args: [],
    });

    // With a vendored node_modules/.bin/dotenvx present, it beats bare PATH.
    const shim = path.join(root, "node_modules", ".bin", "dotenvx");
    mkdirSync(path.dirname(shim), { recursive: true });
    writeFileSync(shim, "#!/bin/sh\nexit 0\n");
    chmodSync(shim, 0o755);
    assert.deepEqual(resolveDotenvxInvocation({ from, toolkitRoot: root }), {
      command: shim,
      args: [],
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("this checkout pins the toolkit's own @dotenvx/dotenvx, run under process.execPath", () => {
  const got = resolveDotenvxInvocation();
  assert.equal(got.command, process.execPath);
  assert.equal(got.args.length, 1);
  assert.ok(
    got.args[0].includes(`${path.sep}@dotenvx${path.sep}dotenvx${path.sep}`),
    `resolved entry must live inside @dotenvx/dotenvx, got: ${got.args[0]}`
  );
  assert.ok(existsSync(got.args[0]), "resolved dotenvx entry must exist on disk");
});

// The end-to-end property AIO-1004 exists for: a fake `dotenvx` planted EARLIER in PATH
// must never be selected, and the chosen tuple + vault behaviour must be identical with a
// plain-shell PATH and an npm-run-style PATH (node_modules/.bin prepended).
test("poisoned PATH: fake dotenvx is never executed; identical inside and outside npm run", () => {
  const base = tmpBase();
  try {
    const poison = path.join(base, "poison");
    mkdirSync(poison, { recursive: true });
    const marker = path.join(base, "poison-ran.marker");
    writeFileSync(
      path.join(poison, "dotenvx"),
      `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 42\n`
    );
    chmodSync(path.join(poison, "dotenvx"), 0o755);

    const repo = path.join(base, "ws");
    mkdirSync(repo, { recursive: true });

    const probe = (extraPathEntries) => {
      const env = { ...process.env };
      delete env.DOTENV_PUBLIC_KEY;
      delete env.DOTENV_PRIVATE_KEY;
      env.PATH = [...extraPathEntries, poison, path.dirname(process.execPath), "/usr/bin", "/bin"]
        .filter(Boolean)
        .join(path.delimiter);
      const out = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { resolveDotenvxInvocation, vaultSet, vaultGet } from ${JSON.stringify(VAULT_MJS)};
           const repo = ${JSON.stringify(repo)};
           vaultSet(repo, "AIO_1004_PROBE", "sekret-1004");
           process.stdout.write(JSON.stringify({
             resolved: resolveDotenvxInvocation(),
             roundtrip: vaultGet(repo, "AIO_1004_PROBE"),
           }));`,
        ],
        { encoding: "utf8", env }
      );
      return JSON.parse(out);
    };

    // Outside npm run: poison dir is the first PATH hit for `dotenvx`.
    const plain = probe([]);
    // Inside npm run: npm prepends node_modules/.bin — simulate exactly that.
    const underNpm = probe([path.join(ROOT, "node_modules", ".bin")]);

    assert.deepEqual(
      plain.resolved,
      underNpm.resolved,
      "the chosen binary must be identical inside and outside npm run"
    );
    assert.equal(plain.resolved.command, process.execPath);
    assert.equal(plain.roundtrip, "sekret-1004", "vault roundtrip must work with poisoned PATH");
    assert.equal(underNpm.roundtrip, "sekret-1004");
    assert.ok(
      !existsSync(marker),
      "the fake dotenvx earlier in PATH must never have been executed"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
