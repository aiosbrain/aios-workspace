import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveLinearCredential } from "../scripts/connectors/linear/credentials.mjs";
import { slackCall } from "../scripts/connectors/slack/web.mjs";
import { describeContentDrift } from "../scripts/connectors/linear/template.mjs";
import { CellContext, SENTINELS, scanTextForSentinels } from "./package-acceptance/lib/context.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-release-regression-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function env(dir, extra = {}) {
  return { HOME: dir, PATH: path.dirname(process.execPath), AIOS_CONFIG_DIR: dir, ...extra };
}

test("malformed credentials remain value-free through canonical, bare and real shim commands", (t) => {
  const dir = fixture(t);
  const preload = path.join(dir, "never-network.mjs");
  const trace = path.join(dir, "trace");
  writeFileSync(
    preload,
    `import fs from 'node:fs';fs.appendFileSync(process.env.TRACE,'fixture\\n');globalThis.fetch=async()=>{throw Error('fetch must not run')};`
  );
  const secret = "synthetic-key\ninvalid";
  for (const [bin, args] of [
    ["scripts/aios.mjs", ["linear", "get", "FIX-1"]],
    ["scripts/linear.mjs", ["get", "FIX-1"]],
    ["scaffold/scripts/aios.mjs", ["linear", "get", "FIX-1"]],
  ]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, bin), ...args], {
      cwd: dir,
      encoding: "utf8",
      env: env(dir, {
        LINEAR_API_KEY: secret,
        AIOS_TOOLKIT_DIR: ROOT,
        NODE_OPTIONS: `--import=${preload}`,
        TRACE: trace,
      }),
    });
    assert.equal(result.status, 3);
    assert.equal((result.stdout + result.stderr).includes(secret), false);
    assert.match(result.stderr, /AIOS_E_CREDENTIAL_INCOMPLETE/);
  }
  assert.ok(
    readFileSync(trace, "utf8").split("fixture\n").length >= 5,
    "preload must execute in canonical, bare, shim and delegated child"
  );
});

test("configured user source outranks workspace; incomplete higher sources never fall back", async (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, ".env"), "LINEAR_API_KEY=synthetic-workspace\n");
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ schemaVersion: 2, credentialSources: { linear: "env:SELECTED_KEY" } })
  );
  const options = { cwd: dir, env: env(dir, { SELECTED_KEY: "synthetic-selected" }) };
  const selected = await resolveLinearCredential(options);
  assert.equal(selected.source.name, "user-config");
  assert.equal(selected.values.apiKey === options.env.SELECTED_KEY, true);
  await assert.rejects(resolveLinearCredential({ ...options, env: env(dir) }), {
    code: "AIOS_E_CREDENTIAL_INCOMPLETE",
  });
  await assert.rejects(
    resolveLinearCredential({
      ...options,
      env: env(dir, { LINEAR_API_KEY: "", SELECTED_KEY: "synthetic-selected" }),
    }),
    { code: "AIOS_E_CREDENTIAL_INCOMPLETE" }
  );
});

for (const stream of ["stdout", "stderr"]) {
  for (const exit of [0, 1]) {
    test(`raw ${stream} captured and scanned even with exit ${exit}`, (t) => {
      const dir = fixture(t);
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ tarball: "unused" }));
      const ctx = new CellContext({
        artifactDir: dir,
        evidenceDir: path.join(dir, "evidence"),
        checkoutRoot: ROOT,
        base: dir,
      });
      const result = ctx.run(
        process.execPath,
        [
          "-e",
          `process.${stream}.write('x'.repeat(5000)+process.env.FIXTURE_KEY);process.exitCode=${exit}`,
        ],
        { expectFailure: true, env: ctx.cliEnv({ FIXTURE_KEY: SENTINELS.linearKey }) }
      );
      assert.equal(result.status, exit);
      assert.equal(ctx.sentinelHits.length, 1);
      const text = readFileSync(ctx.writeEvidence({ ok: false }), "utf8");
      assert.deepEqual(scanTextForSentinels(text), []);
    });
  }
}

for (const failure of ["disconnect", "server-error"]) {
  test(`ambiguous Slack message ${failure} is never resubmitted`, async () => {
    let calls = 0;
    await assert.rejects(
      slackCall(
        {
          token: "synthetic",
          sleep: async () => {},
          env: {},
          fetch: async () => {
            calls++;
            if (failure === "disconnect") throw new TypeError("lost response");
            return new Response("error", { status: 500 });
          },
        },
        "chat.postMessage",
        { channel: "C_FIXTURE", text: "fixture" }
      ),
      (error) => error.code === "AIOS_E_NETWORK" && /may have succeeded/.test(error.message)
    );
    assert.equal(calls, 1);
  });
}

test("Slack safe reads and explicit 429 refusals retain bounded retries", async () => {
  for (const [method, status] of [
    ["auth.test", 500],
    ["chat.postMessage", 429],
  ]) {
    let calls = 0;
    const result = await slackCall(
      {
        token: "synthetic",
        sleep: async () => {},
        env: {},
        fetch: async () =>
          ++calls === 1 ? new Response("retry", { status }) : Response.json({ ok: true }),
      },
      method
    );
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
  }
});

test("usage JSON is a single typed value and unsupported Linear JSON is refused before credentials", (t) => {
  const dir = fixture(t);
  for (const args of [
    ["bogus-command", "--json"],
    ["linear", "get", "FIX-1", "--json"],
  ]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/aios.mjs"), ...args], {
      cwd: dir,
      env: env(dir),
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error.code, "AIOS_E_USAGE");
    assert.equal(result.stderr, "");
  }
});

test("equivalent inline link brackets normalize without hiding URL/label/title/code changes", () => {
  for (const suffix of ["", ' "title"']) {
    assert.equal(
      describeContentDrift(
        `[doc](https://example.test/a${suffix})`,
        `[doc](<https://example.test/a>${suffix})`
      ),
      null
    );
  }
  for (const [a, b] of [
    ["[doc](https://example.test/a)", "[doc](<https://example.test/b>)"],
    ["[doc](https://example.test/a)", "[other](<https://example.test/a>)"],
    ['[doc](https://example.test/a "one")', '[doc](<https://example.test/a> "two")'],
    ["`[doc](https://example.test/a)`", "`[doc](<https://example.test/a>)`"],
    ["```\n[doc](https://example.test/a)\n```", "```\n[doc](<https://example.test/a>)\n```"],
  ])
    assert.notEqual(describeContentDrift(a, b), null);
});

test("production cell fails and retains evidence when cleanup fails", async (t) => {
  const { executeCell } = await import("./package-acceptance/run-cell.mjs");
  const dir = fixture(t);
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ tarball: "unused" }));
  const ctx = new CellContext({
    artifactDir: dir,
    evidenceDir: path.join(dir, "evidence"),
    checkoutRoot: ROOT,
    base: path.join(dir, "work"),
  });
  await assert.rejects(
    executeCell(ctx, {
      journey: async () => {},
      cleanup: () => {
        throw new Error("synthetic filesystem refusal");
      },
    }),
    /cleanup failed/
  );
  const evidence = JSON.parse(readFileSync(path.join(ctx.evidenceDir, "evidence.json")));
  assert.equal(evidence.ok, false);
  assert.equal(evidence.sections.cleanup.state, "failed");
});

test("production cell rejects an otherwise successful stderr-leaking journey", async (t) => {
  const { executeCell } = await import("./package-acceptance/run-cell.mjs");
  const dir = fixture(t);
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ tarball: "unused" }));
  const ctx = new CellContext({
    artifactDir: dir,
    evidenceDir: path.join(dir, "evidence"),
    checkoutRoot: ROOT,
    base: path.join(dir, "work"),
  });
  await assert.rejects(
    executeCell(ctx, {
      journey: (cell) => {
        cell.run(process.execPath, ["-e", "process.stderr.write(process.env.LEAK_FIXTURE)"], {
          env: cell.cliEnv({ LEAK_FIXTURE: SENTINELS.linearKey }),
        });
      },
    }),
    /secret sentinel leaked/
  );
  const evidence = JSON.parse(readFileSync(path.join(ctx.evidenceDir, "evidence.json")));
  assert.equal(evidence.ok, false);
  assert.equal(evidence.sentinelHits.length, 1);
  assert.equal(evidence.sections.cleanup.state, "removed");
});
