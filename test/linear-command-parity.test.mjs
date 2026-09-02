// AIO-1067 — the command-parity matrix. Two claims, both load-bearing:
//
//   1. STATIC: the canonical `aios linear` verb surface (the adapter's VERBS matrix) is
//      exactly the legacy CLI surface — no verb silently dropped out of the move, and every
//      verb names a real adapter module.
//   2. DYNAMIC: for every verb, the `linear` compat bin produces byte-identical stdout and
//      the same exit status as `aios linear`, and its ONLY addition is one deprecation
//      warning on stderr. Both processes run against the same mocked GraphQL provider —
//      no network, no live credentials (LINEAR_API_KEY is synthetic).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const AIOS = path.join(ROOT, "scripts", "aios.mjs");
const LINEAR_BIN = path.join(ROOT, "scripts", "linear.mjs");
const MOCK = path.join(ROOT, "test", "helpers", "mock-linear-provider.mjs");

const LEGACY_VERBS = [
  "get",
  "export-desc",
  "verify-desc",
  "set-desc",
  "patch-desc",
  "set-title",
  "set-state",
  "set-priority",
  "comment",
  "comments",
  "list",
  "relations",
  "blocks",
  "related",
  "remove-relation",
  "set-project",
  "projects",
  "create-project",
  "set-parent",
  "add-label",
  "template",
  "create",
  "users",
  "assign",
];

test("static matrix: the adapter's verb surface is the legacy surface plus status/query/activity", async () => {
  const { VERBS } = await import("../scripts/connectors/linear/index.mjs");
  // `query` and `activity` are the AIO-1072 ports of the retired linear-direct descriptor
  // clients; `status` is the AIO-1067 setup verb. Everything else is the legacy surface.
  assert.deepEqual(
    Object.keys(VERBS).sort(),
    [...LEGACY_VERBS, "status", "query", "activity"].sort(),
    "canonical verb set drifted from the legacy CLI surface"
  );
  for (const [verb, entry] of Object.entries(VERBS)) {
    assert.ok(
      existsSync(path.join(ROOT, entry.module)),
      `${verb}: adapter module ${entry.module} does not exist`
    );
    assert.equal(typeof entry.credential, "boolean", `${verb}: credential flag missing`);
  }
  assert.equal(VERBS.template.credential, false, "template must not require a credential");
});

function runBoth(args, dir) {
  const env = {
    ...process.env,
    LINEAR_API_KEY: "synthetic-parity-key-not-real",
    AIOS_LINEAR_TEAM_KEY: "AIO",
  };
  delete env.AIOS_LINEAR_ORIGIN_LABEL;
  const opts = { cwd: ROOT, encoding: "utf8", env };
  const canonical = spawnSync(
    process.execPath,
    ["--import", MOCK, AIOS, "linear", ...args(dir, "canonical")],
    opts
  );
  const delegate = spawnSync(
    process.execPath,
    ["--import", MOCK, LINEAR_BIN, ...args(dir, "delegate")],
    opts
  );
  return { canonical, delegate };
}

/** verb → argv factory (per-run file targets so the two processes never collide). */
const MATRIX = {
  get: () => ["get", "AIO-73"],
  "export-desc": (dir, run) => ["export-desc", "AIO-73", path.join(dir, `${run}-export.md`)],
  "verify-desc": (dir) => ["verify-desc", "AIO-73", path.join(dir, "verify.md")],
  "set-desc": (dir) => ["set-desc", "AIO-73", path.join(dir, "set.md")],
  "patch-desc": (dir) => ["patch-desc", "AIO-73", path.join(dir, "patch.md")],
  "set-title": () => ["set-title", "AIO-73", "Renamed"],
  "set-state": () => ["set-state", "AIO-73", "In Progress"],
  "set-priority": () => ["set-priority", "AIO-73", "high"],
  comment: () => ["comment", "AIO-73", "done"],
  comments: () => ["comments", "AIO-73"],
  list: () => ["list", "AIO"],
  relations: () => ["relations", "AIO-73"],
  blocks: () => ["blocks", "AIO-73", "AIO-75"],
  related: () => ["related", "AIO-73", "AIO-75"],
  "remove-relation": () => ["remove-relation", "AIO-73", "AIO-75", "blocks"],
  "set-project": () => ["set-project", "AIO-73", "Proj"],
  projects: () => ["projects"],
  "create-project": () => ["create-project", "Ultraharden Parity"],
  "set-parent": () => ["set-parent", "AIO-73", "AIO-75"],
  "add-label": () => ["add-label", "AIO-73", "bug"],
  template: () => ["template", "aios"],
  create: () => ["create", "Parity slice", "--template", "aios"],
  users: () => ["users", "AIO"],
  assign: () => ["assign", "AIO-73", "alice@example.test"],
};

test(
  "dynamic matrix: delegate stdout/exit match `aios linear` for every verb",
  { timeout: 300_000 },
  () => {
    assert.deepEqual(
      Object.keys(MATRIX).sort(),
      [...LEGACY_VERBS].sort(),
      "matrix must cover every verb"
    );
    const dir = mkdtempSync(path.join(tmpdir(), "aio-1067-parity-"));
    try {
      writeFileSync(path.join(dir, "verify.md"), "body");
      writeFileSync(path.join(dir, "set.md"), "a replacement body\n");
      writeFileSync(
        path.join(dir, "patch.md"),
        "<<<<<<< SEARCH\nbody\n=======\npatched body\n>>>>>>> REPLACE\n"
      );
      for (const [verb, args] of Object.entries(MATRIX)) {
        const { canonical, delegate } = runBoth(args, dir);
        assert.equal(
          delegate.status,
          canonical.status,
          `${verb}: exit status diverged (canonical ${canonical.status}: ${canonical.stderr}; delegate ${delegate.status}: ${delegate.stderr})`
        );
        assert.equal(delegate.stdout, canonical.stdout, `${verb}: stdout schema diverged`);
        const [warning, ...restStderr] = delegate.stderr.split("\n");
        assert.match(
          warning,
          /^linear: deprecated compatibility command — use `aios linear /,
          `${verb}: delegate must warn on stderr`
        );
        assert.equal(
          restStderr.join("\n"),
          canonical.stderr,
          `${verb}: delegate stderr must be the canonical stderr plus the one warning line`
        );
        assert.doesNotMatch(canonical.stdout, /synthetic-parity-key/, `${verb}: credential leaked`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("usage and credential-missing parity between the two routes", () => {
  const env = { ...process.env, AIOS_DISABLE_WORKSPACE_CREDENTIALS: "1" };
  delete env.LINEAR_API_KEY;
  env.AIOS_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aio-1067-nocfg-"));
  try {
    const opts = { cwd: ROOT, encoding: "utf8", env };
    const canonical = spawnSync(process.execPath, [AIOS, "linear", "get", "AIO-73"], opts);
    const delegate = spawnSync(process.execPath, [LINEAR_BIN, "get", "AIO-73"], opts);
    for (const result of [canonical, delegate]) {
      assert.equal(result.status, 3, "missing credentials are exit class 3");
      assert.match(result.stderr, /AIOS_E_CREDENTIAL_MISSING/);
      assert.match(result.stderr, /remediation: aios connect linear/);
    }
    assert.equal(delegate.stdout, canonical.stdout);

    const usageCanonical = spawnSync(process.execPath, [AIOS, "linear"], opts);
    const usageDelegate = spawnSync(process.execPath, [LINEAR_BIN], opts);
    assert.equal(usageCanonical.status, 0);
    assert.equal(usageDelegate.status, 0);
    assert.equal(usageDelegate.stdout, usageCanonical.stdout);
  } finally {
    rmSync(env.AIOS_CONFIG_DIR, { recursive: true, force: true });
  }
});
