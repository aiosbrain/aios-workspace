#!/usr/bin/env node
// test/monorepo-package.test.mjs — contract tests for @aios-alpha/monorepo (AIO-601).
//
//   (a) Freezes the PUBLIC API surface: every public subpath must expose exactly the
//       named exports listed below (measured from the pre-move scripts/*.mjs hubs at
//       origin/main 7912c0f). The root specifier and undeclared deep paths must NOT
//       resolve. The ./internal/* subpaths are deliberately NOT part of this frozen
//       surface — they are private/unstable shim plumbing (see the package README).
//   (b) `npm pack --dry-run --json` ships src + README.md + LICENSE (+ package.json)
//       and nothing else — no tests, no fixtures.
//   (c) Tarball install smoke: `npm pack`, install the tarball into a temp project,
//       import every public subpath there (proves the package is self-contained).
//
// Zero-dep, no network (the package has no dependencies, so the tarball install
// resolves nothing from the registry).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = path.join(ROOT, "packages", "monorepo");

/** The frozen public surface. Changing this table IS a semver event for the package. */
const PUBLIC_EXPORTS = {
  runtimes: [
    "DRIVER_CAPS",
    "EXPORT_RUNTIMES",
    "GUI_RUNTIMES",
    "RUNTIMES",
    "RUNTIME_MODEL_CATALOGS",
    "RUNTIME_NAMES",
    "allowedApprovalModeIds",
    "claudeApprovalModes",
    "fullAccessEnabled",
    "isModelAllowed",
    "isWellFormedModelId",
    "modelCatalog",
    "modelRejectionMessage",
    "runtimeCapabilities",
  ],
  "workspace-parse": [
    "DECISION_REDACTION_VERSION",
    "classifyKind",
    "evidencePayloadContent",
    "isCanonicalEvidencePath",
    "normalizeTier",
    "parseDecisionRows",
    "parseEvidenceRows",
    "parseFactRows",
    "parseFrontmatter",
    "parseStakeholderMentionRows",
    "redactAdminDecisionRows",
    "validEvidenceDeclaration",
    "validateItemPayload",
  ],
  "brain-config": [
    "decryptDotenvKey",
    "dotenvxEncryptedHint",
    "envGet",
    "isDotenvxEncrypted",
    "loadDotEnv",
    "resolveBrainConfig",
  ],
  "linear-client": [
    "LINEAR_API_URL",
    "LinearError",
    "createLinearClient",
    "extractRepoFileRefs",
    "normalizeBlockedBy",
    "resolveLinearApiKey",
  ],
  "brain-client": ["createBrainClient", "parseSseBlock", "splitSseBlocks"],
  // Promoted from ./internal/tasks-table in AIO-600 C3: the GUI tasks panel needs the
  // exact parse/writeback the CLI + brain-pull use (round-trip fidelity), and the C1
  // contract bars the GUI from internal subpaths — so the surface freezes here.
  "tasks-table": [
    "CANONICAL_TASK_STATUSES",
    "canonicalTaskStatus",
    "dateCell",
    "mergeTaskWriteback",
    "parsePmCell",
    "parseTableRows",
    "parseTaskRows",
    "planSyncOriginWriteback",
    "syncOriginRowsFor",
  ],
  "git-files": ["gitFiles"],
  // AIO-600 C5: the run-gui ↔ gui-server workspace-marker single source, and the
  // adapter-registry/guard contract checks (OGR07 inversion) — see
  // docs/gui-toolkit-contract.md §C5.
  "workspace-markers": ["WORKSPACE_MARKERS"],
  "adapter-contract": [
    "CLAUDE_CODE_EXPECTATIONS",
    "GUARD_SCENARIOS",
    "checkAdapterRegistry",
    "checkGuardWrite",
  ],
  constitution: [
    "CONSTITUTION_RELPATH",
    "DIGEST_END",
    "DIGEST_START",
    "constitutionPromptLines",
    "extractDigest",
    "loadConstitutionDigest",
  ],
};

// Internal subpaths only need to RESOLVE (the scripts/ shims depend on them); their
// export lists are unfrozen on purpose.
const INTERNAL_SUBPATHS = [
  "internal/flat-yaml",
  "internal/brain-origin",
  "internal/transcript-adapters",
  "internal/skill-scan", // AIO-600 C2 — consumed by gui/server (documented-private)
];

// npm_config_* vars leaked by the parent `npm run` would reconfigure nested npm
// invocations (workspace mode, prefix, etc.) — strip them for child npm calls.
function cleanNpmEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
}

function npmJson(args, cwd) {
  const stdout = execFileSync("npm", [...args, "--json"], {
    cwd,
    env: cleanNpmEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test("every public subpath exposes exactly its frozen named exports", async () => {
  for (const [subpath, expected] of Object.entries(PUBLIC_EXPORTS)) {
    const mod = await import(`@aios-alpha/monorepo/${subpath}`);
    assert.deepEqual(
      Object.keys(mod).sort(),
      [...expected].sort(),
      `export surface drifted for @aios-alpha/monorepo/${subpath}`
    );
    assert.ok(!("default" in mod), `${subpath} must not grow a default export`);
  }
});

test("internal subpaths resolve (shim plumbing, surface unfrozen)", async () => {
  for (const subpath of INTERNAL_SUBPATHS) {
    const mod = await import(`@aios-alpha/monorepo/${subpath}`);
    assert.ok(Object.keys(mod).length > 0, `${subpath} resolved but exports nothing`);
  }
});

test("the root specifier and undeclared deep paths do not resolve", async () => {
  const denied = [
    "@aios-alpha/monorepo",
    "@aios-alpha/monorepo/src/runtimes.mjs",
    "@aios-alpha/monorepo/src/internal/flat-yaml.mjs",
    "@aios-alpha/monorepo/internal",
    "@aios-alpha/monorepo/internal/tasks-table", // promoted to ./tasks-table (AIO-600 C3)
    "@aios-alpha/monorepo/workspace-parse/core",
    "@aios-alpha/monorepo/package.json",
  ];
  for (const specifier of denied) {
    await assert.rejects(
      () => import(specifier),
      (err) => err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || err.code === "ERR_MODULE_NOT_FOUND",
      `${specifier} must not resolve`
    );
  }
});

test("npm pack ships src + README + LICENSE and nothing else", () => {
  const [report] = npmJson(["pack", "--dry-run"], PKG_DIR);
  const files = report.files.map((f) => f.path);
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "src/runtimes.mjs",
    "src/workspace-parse/index.mjs",
    "src/workspace-parse/index.d.mts",
    "src/internal/flat-yaml.mjs",
  ]) {
    assert.ok(files.includes(required), `tarball is missing ${required}`);
  }
  for (const file of files) {
    assert.ok(
      file === "package.json" ||
        file === "README.md" ||
        file === "LICENSE" ||
        file.startsWith("src/"),
      `unexpected file in tarball: ${file}`
    );
    assert.ok(
      !/(^|\/)(test|tests|__fixtures__|fixtures)\//.test(file),
      `test/fixture file leaked into tarball: ${file}`
    );
  }
});

test("tarball installs into a fresh project and every public subpath imports", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "aios-monorepo-pack-"));
  try {
    execFileSync("npm", ["pack", "--pack-destination", scratch], {
      cwd: PKG_DIR,
      env: cleanNpmEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarball = readdirSync(scratch).find((f) => f.endsWith(".tgz"));
    assert.ok(tarball, "npm pack produced no tarball");

    const proj = path.join(scratch, "consumer");
    execFileSync("mkdir", ["-p", proj]);
    writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({ name: "consumer", private: true, type: "module" })
    );
    execFileSync("npm", ["install", "--no-audit", "--no-fund", path.join(scratch, tarball)], {
      cwd: proj,
      env: cleanNpmEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const script = `
      const surface = ${JSON.stringify(PUBLIC_EXPORTS)};
      for (const [subpath, expected] of Object.entries(surface)) {
        const mod = await import("@aios-alpha/monorepo/" + subpath);
        const got = Object.keys(mod).sort().join(",");
        const want = [...expected].sort().join(",");
        if (got !== want) throw new Error(subpath + " drifted in tarball: " + got);
      }
      console.log("tarball-smoke-ok");
    `;
    const out = execFileSync("node", ["--input-type=module", "-e", script], {
      cwd: proj,
      env: cleanNpmEnv(),
      encoding: "utf8",
    });
    assert.match(out, /tarball-smoke-ok/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
