#!/usr/bin/env node

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rankFindings } from "../scripts/consolidate-findings.mjs";
import {
  cmdVerify,
  mergeLaneResults,
  parseVerifyArgs,
  readCommitDiff,
  MAX_LANES,
} from "../scripts/verify.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const VERIFY_SOURCE = path.join(REPO, "scripts", "verify.mjs");

function runGit(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd();
}

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-verify-"));
  runGit(repo, ["init", "-q"]);
  runGit(repo, ["config", "user.name", "AIOS Verify Test"]);
  runGit(repo, ["config", "user.email", "verify@example.invalid"]);
  writeFileSync(path.join(repo, "README.md"), "one\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-qm", "first"]);
  writeFileSync(path.join(repo, "README.md"), "one\ntwo\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-qm", "second"]);
  return repo;
}

function runCli(repo, args, env = {}) {
  const result = spawnSync(process.execPath, [AIOS, ...args, "--repo", repo], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("argument contract: defaults, cap, and usage errors", () => {
  assert.equal(parseVerifyArgs(["HEAD"]).lanes, 3);
  assert.equal(parseVerifyArgs(["HEAD"]).lanesExplicit, false);
  assert.equal(parseVerifyArgs(["HEAD", "--lanes", "1"]).lanes, 1);
  assert.equal(parseVerifyArgs(["HEAD", "--lanes", "1"]).lanesExplicit, true);
  const capped = parseVerifyArgs(["HEAD", "--lanes", String(MAX_LANES + 1)]);
  assert.equal(capped.exitCode, 4);
  assert.match(capped.error, /hard cap of 8/);
  assert.equal(parseVerifyArgs([]).exitCode, 4);
  assert.equal(parseVerifyArgs(["HEAD", "--lanes", "many"]).exitCode, 4);
});

test("unknown sha exits 4 and --lanes 9 names the cap", () => {
  const repo = makeRepo();
  try {
    const unknown = runCli(repo, ["verify", "not-a-commit"]);
    assert.equal(unknown.code, 4);
    assert.match(unknown.stderr, /unknown commit 'not-a-commit'/);

    const capped = runCli(repo, ["verify", "HEAD", "--lanes", "9"]);
    assert.equal(capped.code, 4);
    assert.match(capped.stderr, /hard cap of 8/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("missing provider key fails before launching a lane", async () => {
  const repo = makeRepo();
  let calls = 0;
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = await cmdVerify(repo, ["HEAD"], {
        runCouncil: async () => {
          calls++;
          throw new Error("must not run");
        },
      });
      assert.notEqual(code, 0);
    } finally {
      console.error = originalError;
    }
    assert.equal(calls, 0);

    const cli = runCli(repo, ["verify", "HEAD"], { OPENROUTER_API_KEY: "" });
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, /OPENROUTER_API_KEY is not set/);
    assert.match(cli.stderr, /zero lanes/);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("default lanes adapt to a two-model panel; an explicit overflow exits 4", async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, ".aios"));
  writeFileSync(
    path.join(repo, ".aios", "council-models.yaml"),
    "council_models:\n  - openai/model-a\n  - google/model-b\n"
  );
  let calls = 0;
  const runCouncil = async (_repo, _rest, options) => {
    calls++;
    assert.equal(options.lanes, 2);
    assert.deepEqual(options.models, ["openai/model-a", "google/model-b"]);
    return {
      models: options.models,
      results: options.models.map((model) => ({ model, ok: true, text: "[]" })),
    };
  };
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    assert.equal(await cmdVerify(repo, ["HEAD", "--json"], { apiKey: "test", runCouncil }), 0);
    assert.equal(JSON.parse(chunks.join("")).lanes, 2);

    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal(
        await cmdVerify(repo, ["HEAD", "--lanes", "3"], { apiKey: "test", runCouncil }),
        4
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(calls, 1);
  } finally {
    process.stdout.write = originalWrite;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lane findings use consolidate-findings' stable severity order", () => {
  const laneResults = [
    {
      model: "model-a",
      ok: true,
      text: JSON.stringify([
        { severity: "low", title: "low-first", detail: "a" },
        { severity: "HIGH", title: "high-first", detail: "b" },
      ]),
    },
    {
      model: "model-b",
      ok: true,
      text: JSON.stringify([
        { severity: "medium", title: "medium", detail: "c" },
        { severity: "high", title: "high-second", detail: "d" },
      ]),
    },
  ];
  const merged = mergeLaneResults(laneResults);
  const fixture = laneResults.flatMap((result, laneIndex) =>
    JSON.parse(result.text).map((finding) => ({
      ...finding,
      lane: laneIndex + 1,
      model: result.model,
    }))
  );
  assert.deepEqual(
    merged.map((finding) => finding.title),
    rankFindings(fixture).map((finding) => finding.title)
  );
  assert.deepEqual(
    merged.map((finding) => finding.title),
    ["high-first", "high-second", "medium", "low-first"]
  );
});

test("invalid or failed lanes fail closed as High findings", () => {
  const merged = mergeLaneResults([
    { model: "bad-json", ok: true, text: "not json" },
    { model: "down", ok: false, error: "provider unavailable" },
  ]);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((finding) => finding.severity === "High"));
});

test("root commits use an empty-tree diff", () => {
  const repo = makeRepo();
  try {
    const root = runGit(repo, ["rev-list", "--max-parents=0", "HEAD"]);
    const diff = readCommitDiff(repo, root);
    assert.match(diff, /README\.md/);
    assert.match(diff, /\+one/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("all failed providers still produce a blocking report", async () => {
  const repo = makeRepo();
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = await cmdVerify(repo, ["HEAD", "--lanes", "2", "--json"], {
      apiKey: "test-only-key",
      councilOptions: {
        callModel: async (model) => ({ model, ok: false, error: "provider unavailable" }),
      },
    });
    assert.equal(code, 1);
    const report = JSON.parse(chunks.join(""));
    assert.equal(report.blocking, true);
    assert.equal(report.findings.length, 2);
    assert.ok(report.findings.every((finding) => finding.severity === "High"));
  } finally {
    process.stdout.write = originalWrite;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Medium findings are blocking and egress is disclosed on stderr", () => {
  const repo = makeRepo();
  const preload = path.join(repo, "mock-fetch.mjs");
  writeFileSync(
    preload,
    [
      "globalThis.fetch = async () => ({",
      "  ok: true,",
      "  json: async () => ({ choices: [{ message: { content: JSON.stringify([",
      "    { severity: 'Medium', title: 'review me', detail: 'medium risk' },",
      "  ]) } }] }),",
      "  text: async () => '',",
      "});",
      "",
    ].join("\n")
  );

  try {
    const result = runCli(repo, ["verify", "HEAD", "--lanes", "1", "--json"], {
      OPENROUTER_API_KEY: "test-only-key",
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).blocking, true);
    assert.match(result.stderr, /sends the commit diff to OpenRouter/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("full JSON CLI run is report-only and preserves repository fingerprint", () => {
  const repo = makeRepo();
  const preload = path.join(repo, "mock-fetch.mjs");
  writeFileSync(
    preload,
    [
      "globalThis.fetch = async () => ({",
      "  ok: true,",
      "  json: async () => ({ choices: [{ message: { content: '[]' } }] }),",
      "  text: async () => '',",
      "});",
      "",
    ].join("\n")
  );

  try {
    const before = {
      status: runGit(repo, ["status", "--porcelain"]),
      head: runGit(repo, ["rev-parse", "HEAD"]),
    };
    const result = runCli(repo, ["verify", "HEAD", "--lanes", "2", "--json"], {
      OPENROUTER_API_KEY: "test-only-key",
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.lanes, 2);
    assert.equal(report.models.length, 2);
    assert.deepEqual(report.findings, []);
    assert.equal(report.blocking, false);

    const after = {
      status: runGit(repo, ["status", "--porcelain"]),
      head: runGit(repo, ["rev-parse", "HEAD"]),
    };
    assert.deepEqual(after, before);
    assert.equal(existsSync(path.join(repo, ".aios")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--out is the only explicit report file write", async () => {
  const repo = makeRepo();
  try {
    const code = await cmdVerify(repo, ["HEAD", "--lanes", "2", "--json", "--out", "report.json"], {
      apiKey: "test-only-key",
      runCouncil: async (_repo, _rest, options) => {
        assert.equal(options.persist, false);
        assert.equal(options.print, false);
        return {
          models: ["model-a", "model-b"],
          results: [
            { model: "model-a", ok: true, text: "[]" },
            { model: "model-b", ok: true, text: "[]" },
          ],
        };
      },
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(path.join(repo, "report.json"), "utf8")).lanes, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an unwritable --out path returns a controlled usage/output error", async () => {
  const repo = makeRepo();
  try {
    const code = await cmdVerify(repo, ["HEAD", "--lanes", "2", "--out", "missing/report.txt"], {
      apiKey: "test-only-key",
      runCouncil: async () => ({
        models: ["model-a", "model-b"],
        results: [
          { model: "model-a", ok: true, text: "[]" },
          { model: "model-b", ok: true, text: "[]" },
        ],
      }),
    });
    assert.equal(code, 4);
    assert.equal(existsSync(path.join(repo, "missing")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("static report-only guard permits only read-side git calls and no GitHub CLI", () => {
  const source = readFileSync(VERIFY_SOURCE, "utf8");
  assert.doesNotMatch(source, /execFileSync\(\s*["']gh["']/);
  assert.doesNotMatch(
    source,
    /gitRead\([^)]*\[\s*["'](?:commit|push|branch|merge|checkout|switch|reset|clean|add)["']/
  );
});
