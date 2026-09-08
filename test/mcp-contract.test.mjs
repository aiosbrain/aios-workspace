import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { assertMcpContract } from "../scripts/mcp-contract.mjs";
import { TOOLS, SURFACES } from "../packages/mcp-core/index.mjs";
import { resolveBrainConfig } from "../scripts/mcp-config.mjs";
const fixture = JSON.parse(
  readFileSync(new URL("../docs/contract/mcp-tools-v1.json", import.meta.url))
);

test("contract gate rejects deliberate membership drift, including equal-count substitutions", () => {
  const contract = assertMcpContract(fixture);
  assert.equal(contract.standalone.size, 8);
  assert.equal(contract.toolkit.size, 9);
  assert.equal(contract.remoteSpecification.size, 2);
  assert.throws(() => assertMcpContract(fixture, { tools: TOOLS.slice(1) }), /membership drift/);
  assert.throws(
    () =>
      assertMcpContract(fixture, {
        surfaces: {
          ...SURFACES,
          standalone: [...SURFACES.standalone.slice(1), "aios_loop_collect"],
        },
      }),
    /standalone membership drift/
  );
  assert.throws(
    () => assertMcpContract({ ...fixture, tools: [fixture.tools[0], fixture.tools[0]] }),
    /remote specification membership drift/
  );
  assert.throws(
    () =>
      assertMcpContract({
        ...fixture,
        tools: [{ ...fixture.tools[0], description: "changed" }, fixture.tools[1]],
      }),
    /descriptor drift/
  );
  assert.throws(() => assertMcpContract({ ...fixture, status: "deployed" }));
});

test("configuration preserves workspace, dotenv and environment compatibility without encrypted values", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-config-"));
  try {
    mkdirSync(path.join(dir, "nested"));
    writeFileSync(
      path.join(dir, "aios.yaml"),
      'brain_url: "https://workspace.example/"\napi_key_env: CUSTOM_KEY\nteam_id: synthetic-team\nmember: synthetic-member\n'
    );
    writeFileSync(
      path.join(dir, "nested", ".env"),
      'CUSTOM_KEY="synthetic-custom"\nAIOS_BRAIN_URL=https://dotenv.example/\nDOTENV_PUBLIC_KEY=ignored\nAIOS_API_KEY=encrypted:ignored\n# ignore comment\n'
    );
    const cfg = resolveBrainConfig({ cwd: path.join(dir, "nested"), home: dir, env: {} });
    assert.equal(cfg.brain_url, "https://dotenv.example");
    assert.equal(cfg.api_key, "synthetic-custom");
    assert.equal(cfg.team_id, "synthetic-team");
    assert.equal(cfg.member, "synthetic-member");
    const env = resolveBrainConfig({
      cwd: path.join(dir, "nested"),
      home: dir,
      env: { AIOS_BRAIN_URL: "https://env.example", CUSTOM_KEY: "env-key" },
    });
    assert.equal(env.api_key, "env-key");
    assert.equal(env.brain_url, "https://env.example");
    rmSync(path.join(dir, "nested", ".env"));
    assert.deepEqual(resolveBrainConfig({ cwd: dir, home: dir, env: {} }).missing, ["CUSTOM_KEY"]);
    rmSync(path.join(dir, "aios.yaml"));
    const stdin = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n";
    const output = execFileSync(
      process.execPath,
      [new URL("../scripts/brain-mcp.mjs", import.meta.url).pathname],
      {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir },
        input: stdin,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert.deepEqual(
      JSON.parse(output).result.tools.map((t) => t.name),
      ["aios_loop_collect"]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public CLI reports selector mistakes as actionable usage errors", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-cli-usage-"));
  try {
    for (const args of [["--tools", "wat"], ["--toolsets", "wat"], ["--tools"], ["--bogus"]]) {
      const result = spawnSync(
        process.execPath,
        [new URL("../scripts/aios.mjs", import.meta.url).pathname, "mcp", ...args],
        {
          cwd: dir,
          env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir },
          input: "",
          encoding: "utf8",
          timeout: 10000,
        }
      );
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /AIOS_E_USAGE/);
      assert.match(result.stderr, /Unknown MCP|requires a comma-separated selection/);
      assert.equal(result.stdout, "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
