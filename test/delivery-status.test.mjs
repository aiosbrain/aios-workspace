// test/delivery-status.test.mjs — `aios delivery status` end-to-end orchestration (AIO-579,
// read-only slice). Exercises resolveLocalCheckout's path guessing, arg parsing, --json/--repo
// filtering, exit codes, and a full run against real temp git checkouts + a fake `gh` on PATH
// (no network, no fixtures-as-network — the local git repos ARE the fixture equivalent for
// local state; GitHub responses are canned JSON via the fake binary).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cmdDelivery, resolveLocalCheckout, DEFAULT_REPOS } from "../scripts/delivery-status.mjs";
import { findCommand } from "../scripts/cli/registry.mjs";

// ── resolveLocalCheckout ─────────────────────────────────────────────────────────────────────

test("resolveLocalCheckout: the aios-workspace entry returns the resolved repo path as-is when it IS the primary checkout", () => {
  assert.equal(
    resolveLocalCheckout("/Users/x/Projects/aios/aios-workspace", "aios-workspace"),
    "/Users/x/Projects/aios/aios-workspace"
  );
});

test("resolveLocalCheckout: from a WORKTREE of aios-workspace, the aios-workspace entry resolves to the PRIMARY checkout", () => {
  // `worktree list`/`for-each-ref` answer repo-wide from any worktree, but `git status` (the
  // dirty check) is per-working-tree — and the spec calls out "a dirty PRIMARY checkout is
  // reported". Resolving to the primary here is what makes that check mean what it says, even
  // when `aios delivery status` itself is run from inside a worktree (as it will be, since a
  // worktree is where all real work happens per this repo's conventions).
  assert.equal(
    resolveLocalCheckout(
      "/Users/x/Projects/aios/aios-workspace-worktrees/feat-x",
      "aios-workspace"
    ),
    "/Users/x/Projects/aios/aios-workspace"
  );
});

test("resolveLocalCheckout: a sibling repo is guessed from the primary checkout's container", () => {
  assert.equal(
    resolveLocalCheckout("/Users/x/Projects/aios/aios-workspace", "aios-team-brain"),
    "/Users/x/Projects/aios/aios-team-brain"
  );
});

test("resolveLocalCheckout: a sibling repo is guessed correctly from INSIDE a *-worktrees container", () => {
  assert.equal(
    resolveLocalCheckout(
      "/Users/x/Projects/aios/aios-workspace-worktrees/feat-x",
      "aios-team-brain"
    ),
    "/Users/x/Projects/aios/aios-team-brain"
  );
});

test("DEFAULT_REPOS covers exactly the two AIO-579 read-only-slice repos", () => {
  assert.deepEqual(DEFAULT_REPOS.map((r) => r.slug).sort(), [
    "aiosbrain/aios-team-brain",
    "aiosbrain/aios-workspace",
  ]);
});

// ── registry wiring ──────────────────────────────────────────────────────────────────────────

test("registry: `delivery` is offline-resolution, owns --repo (a GitHub slug), and has an exit code", () => {
  const desc = findCommand("delivery");
  assert.ok(desc, "delivery command not registered");
  assert.equal(desc.resolution, "offline");
  assert.equal(desc.ownsRepoFlag, true);
  assert.equal(desc.exit, "exit-code");
});

// ── end-to-end: fake gh + real temp git checkouts ───────────────────────────────────────────

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function initRepo(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `delivery-e2e-${name}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "a.txt"), "1\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

// Fake `gh` that answers `pr list` from a fixture map keyed by --repo, and refuses anything else
// (so a test asserting delivery-status never issues a mutating gh call fails loudly if it did).
// `fn` may be async — this MUST await it before the `finally` cleans up the fake bin dir, or an
// async callback's post-await code runs after the bin dir (and PATH override) is already gone.
async function withFakeGh(fixturesBySlug, fn) {
  const bin = mkdtempSync(path.join(tmpdir(), "delivery-e2e-fakegh-"));
  const record = path.join(bin, "record.log");
  writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const argv = process.argv.slice(2);",
      "appendFileSync(process.env.RECORD, JSON.stringify(argv) + '\\n');",
      "if (argv[0] !== 'pr' || argv[1] !== 'list') { process.stderr.write('refused'); process.exit(1); }",
      "const repoIdx = argv.indexOf('--repo');",
      "const slug = argv[repoIdx + 1];",
      `const fixtures = ${JSON.stringify(fixturesBySlug)};`,
      "process.stdout.write(JSON.stringify(fixtures[slug] ?? []));",
    ].join("\n")
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  const originalPath = process.env.PATH;
  const originalRecord = process.env.RECORD;
  const originalGhBin = process.env.AIOS_DELIVERY_GH_BIN;
  process.env.PATH = `${bin}:${originalPath}`;
  // safe-exec resolves `gh` to an absolute system path (Sonar S4036), so a PATH-only fake
  // no longer intercepts it — point the named stub seam at this fake too.
  process.env.AIOS_DELIVERY_GH_BIN = path.join(bin, "gh");
  process.env.RECORD = record;
  try {
    return await fn(() =>
      readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    );
  } finally {
    process.env.PATH = originalPath;
    if (originalGhBin === undefined) delete process.env.AIOS_DELIVERY_GH_BIN;
    else process.env.AIOS_DELIVERY_GH_BIN = originalGhBin;
    if (originalRecord === undefined) delete process.env.RECORD;
    else process.env.RECORD = originalRecord;
    rmSync(bin, { recursive: true, force: true });
  }
}

function captureConsole(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => lines.push(msg);
  try {
    return { result: fn(), output: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("cmdDelivery: end-to-end against real local checkouts + a fake gh, human + --json", async () => {
  const workspaceRepo = initRepo("workspace");
  const brainRepo = initRepo("brain");
  try {
    const fixtures = {
      "aiosbrain/aios-workspace": [
        {
          number: 1,
          title: "an open PR",
          url: "https://github.com/aiosbrain/aios-workspace/pull/1",
          state: "OPEN",
          isDraft: false,
          headRefName: "main",
          headRefOid: git(workspaceRepo, ["rev-parse", "HEAD"]).trim(),
          baseRefName: "main",
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
          reviewDecision: "",
          statusCheckRollup: [{ __typename: "CheckRun", conclusion: "SUCCESS" }],
        },
      ],
      "aiosbrain/aios-team-brain": [],
    };

    await withFakeGh(fixtures, async (readRecords) => {
      const { result: code, output } = captureConsole(() =>
        cmdDelivery(workspaceRepo, {}, [
          "status",
          // Temp dirs don't sit under a real `aios/` Tessera container, so both repos are
          // pinned explicitly here — the sibling-guessing default is covered separately by
          // the resolveLocalCheckout unit tests above.
          "--local",
          `aiosbrain/aios-workspace=${workspaceRepo}`,
          "--local",
          `aiosbrain/aios-team-brain=${brainRepo}`,
        ])
      );
      const exitCode = await code;
      assert.equal(exitCode, 0);
      assert.match(output, /aiosbrain\/aios-workspace/);
      assert.match(output, /aiosbrain\/aios-team-brain/);
      assert.match(output, /#1/);
      assert.match(output, /Read-only:/);

      // Only `pr list` was ever called — no mutating gh command reached the fake binary.
      const records = readRecords();
      assert.ok(records.length >= 2);
      for (const argv of records) assert.deepEqual(argv.slice(0, 2), ["pr", "list"]);
    });

    await withFakeGh(fixtures, async () => {
      const { result: code, output } = captureConsole(() =>
        cmdDelivery(workspaceRepo, {}, [
          "status",
          "--json",
          "--repo",
          "aiosbrain/aios-workspace",
          "--local",
          `aiosbrain/aios-workspace=${workspaceRepo}`,
          "--local",
          `aiosbrain/aios-team-brain=${brainRepo}`,
        ])
      );
      assert.equal(await code, 0);
      const parsed = JSON.parse(output);
      assert.equal(parsed.repos.length, 1, "--repo filter should restrict to one repo");
      assert.equal(parsed.repos[0].slug, "aiosbrain/aios-workspace");
      assert.equal(parsed.repos[0].prs[0].headRefName, "main");
    });
  } finally {
    rmSync(workspaceRepo, { recursive: true, force: true });
    rmSync(brainRepo, { recursive: true, force: true });
  }
});

test("cmdDelivery: a gh fetch failure is reported, not thrown, and the process exits non-zero", async () => {
  const workspaceRepo = initRepo("workspace-fail");
  try {
    const bin = mkdtempSync(path.join(tmpdir(), "delivery-e2e-failgh-"));
    writeFileSync(
      path.join(bin, "gh"),
      ["#!/usr/bin/env node", "process.stderr.write('HTTP 502');", "process.exit(1);"].join("\n")
    );
    chmodSync(path.join(bin, "gh"), 0o755);
    const originalPath = process.env.PATH;
    const originalGhBin = process.env.AIOS_DELIVERY_GH_BIN;
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.AIOS_DELIVERY_GH_BIN = path.join(bin, "gh");
    try {
      const { result: code, output } = captureConsole(() =>
        cmdDelivery(workspaceRepo, {}, ["status", "--repo", "aiosbrain/aios-workspace"])
      );
      assert.equal(await code, 1);
      assert.match(output, /GitHub PR fetch failed/);
    } finally {
      process.env.PATH = originalPath;
      if (originalGhBin === undefined) delete process.env.AIOS_DELIVERY_GH_BIN;
      else process.env.AIOS_DELIVERY_GH_BIN = originalGhBin;
      rmSync(bin, { recursive: true, force: true });
    }
  } finally {
    rmSync(workspaceRepo, { recursive: true, force: true });
  }
});

test("cmdDelivery: a missing local checkout (no --local override) is reported, not thrown", async () => {
  const workspaceRepo = initRepo("workspace-missing");
  try {
    await withFakeGh(
      { "aiosbrain/aios-workspace": [], "aiosbrain/aios-team-brain": [] },
      async () => {
        const { result: code, output } = captureConsole(() =>
          cmdDelivery(workspaceRepo, {}, [
            "status",
            "--json",
            "--local",
            `aiosbrain/aios-workspace=${workspaceRepo}`,
            // aios-team-brain is deliberately left un-overridden: this temp dir has no real
            // `aios/` sibling, so the guessed path won't exist — exactly the "local checkout not
            // found" case this test is for.
          ])
        );
        assert.equal(await code, 1, "the un-overridden aios-team-brain sibling won't exist here");
        const parsed = JSON.parse(output);
        const brain = parsed.repos.find((r) => r.slug === "aiosbrain/aios-team-brain");
        assert.ok(brain.localError, "missing local checkout should be reported, not thrown");
        const workspace = parsed.repos.find((r) => r.slug === "aiosbrain/aios-workspace");
        assert.equal(workspace.localError, null, "the overridden aios-workspace path is fine");
      }
    );
  } finally {
    rmSync(workspaceRepo, { recursive: true, force: true });
  }
});

test("cmdDelivery: `aios delivery` (no subcommand) prints usage and exits 1; `--help` exits 0", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "delivery-e2e-help-"));
  try {
    const { result: code1, output: out1 } = captureConsole(() => cmdDelivery(dir, {}, []));
    assert.equal(await code1, 1);
    assert.match(out1, /usage:/);

    const { result: code2, output: out2 } = captureConsole(() => cmdDelivery(dir, {}, ["--help"]));
    assert.equal(await code2, 0);
    assert.match(out2, /usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdDelivery: an unknown subcommand dies with a non-zero exit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "delivery-e2e-badsub-"));
  const previousExit = process.exit;
  const exitCalls = [];
  process.exit = (code) => {
    exitCalls.push(code);
    throw new Error("__exit__");
  };
  try {
    // cmdDelivery is `async` — a synchronous throw (from die()'s process.exit override) inside
    // it surfaces as a REJECTED promise, not a synchronous throw, so this awaits the rejection.
    await assert.rejects(() => cmdDelivery(dir, {}, ["bogus"]), /__exit__/);
    assert.deepEqual(exitCalls, [1]);
  } finally {
    process.exit = previousExit;
    rmSync(dir, { recursive: true, force: true });
  }
});
