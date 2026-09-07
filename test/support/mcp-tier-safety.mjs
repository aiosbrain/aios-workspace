#!/usr/bin/env node
// AIO-1109: disposable production builds + isolated real Postgres, never staging secrets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";

const workspace = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const brain = resolve(process.env.MCP_BRAIN_DIR || "../aios-team-brain");
const sha = process.env.MCP_BRAIN_SHA;
if (!/^[a-f0-9]{40}$/.test(sha || ""))
  throw new Error("MCP_BRAIN_SHA must be an explicit full commit SHA");
const evidence = resolve(process.env.MCP_EVIDENCE_DIR || join(workspace, ".tmp/mcp-tier-evidence"));
await mkdir(evidence, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "aios-mcp-safety-"));
const env = {
  PATH: process.env.PATH,
  HOME: scratch,
  CI: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  DB_BACKEND: "postgres",
  NEXT_PUBLIC_DB_BACKEND: "postgres",
  AUTH_SECRET: randomUUID(),
  SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
  LLM_BASE_URL: "",
};
const children = new Set();
let cancelled = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    cancelled = true;
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* process already exited */
      }
    }
  });
function run(
  command,
  args,
  { cwd = scratch, extraEnv = {}, allowFailure = false, timeout = 600000, cleanup = false } = {}
) {
  if (cancelled && !cleanup) return Promise.reject(new Error("MCP safety run cancelled"));
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, ...extraEnv },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* process already exited */
      }
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      children.delete(child);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      if (code !== 0 && !allowFailure)
        reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${output.slice(-12000)}`));
      else resolveRun({ code, output });
    });
  });
}
async function port() {
  const server = createServer();
  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", res);
  });
  const selected = server.address().port;
  await new Promise((res) => server.close(res));
  return selected;
}
const digest = (text) => createHash("sha256").update(text).digest("hex");
const report = {
  brainSha: sha,
  workspaceSha: (await run("git", ["rev-parse", "HEAD"], { cwd: workspace })).output.trim(),
  runs: [],
};
let failed;
try {
  await run("docker", ["info"]);
  const resolved = (
    await run("git", ["rev-parse", `${sha}^{commit}`], { cwd: brain })
  ).output.trim();
  if (resolved !== sha) throw new Error("Brain pin mismatch");
  for (const mutation of ["baseline", "project-denial", "item-visibility"]) {
    const directory = join(scratch, mutation);
    await mkdir(directory);
    const archive = join(scratch, `${mutation}.tar`);
    await run("git", ["archive", "--format=tar", "-o", archive, sha], { cwd: brain });
    await run("tar", ["-xf", archive, "-C", directory]);
    await symlink(
      await realpath(join(brain, "node_modules")),
      join(directory, "node_modules"),
      "dir"
    );
    let mutationDigest = null;
    if (mutation !== "baseline") {
      const target =
        mutation === "project-denial"
          ? "app/api/v1/projects/route.ts"
          : "app/api/v1/items/route.ts";
      const before =
        mutation === "project-denial"
          ? 'if (auth.memberTier !== "team") {'
          : 'q = q.in("id", [...ids]);';
      const after =
        mutation === "project-denial"
          ? "if (false) {"
          : "// AIO-1109 disposable mutation: omit item visibility intersection";
      const original = await readFile(join(directory, target), "utf8");
      if (original.split(before).length !== 2) throw new Error(`Mutation target drift: ${target}`);
      const modified = original.replace(before, after);
      await writeFile(join(directory, target), modified);
      mutationDigest = digest(modified);
    }
    const container = `aios-mcp-${randomUUID()}`;
    let created = false;
    let primaryError;
    const result = { mutation, mutationDigest, cleanup: false };
    report.runs.push(result);
    try {
      console.log(`MCP safety: ${mutation}: provisioning isolated Postgres`);
      created = true;
      await run("docker", [
        "run",
        "-d",
        "--name",
        container,
        "-e",
        "POSTGRES_USER=app",
        "-e",
        "POSTGRES_PASSWORD=app",
        "-e",
        "POSTGRES_DB=app_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:16",
      ]);
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (
          (
            await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "app"], {
              allowFailure: true,
            })
          ).code === 0
        ) {
          ready = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      if (!ready) throw new Error("Postgres readiness failed");
      const mapping = (await run("docker", ["port", container, "5432/tcp"])).output.trim();
      const dbPort = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
      if (!dbPort) throw new Error("Missing isolated Postgres port");
      const database = `postgres://app:app@127.0.0.1:${dbPort}/app_test`;
      const httpPort = await port();
      const extraEnv = {
        DATABASE_URL: database,
        DATABASE_TEST_URL: database,
        HTTP_TEST_PORT: String(httpPort),
        APP_URL: `http://127.0.0.1:${httpPort}`,
        MCP_WORKSPACE_DIR: workspace,
        MCP_HTTP_ATTACHED: "1",
      };
      const schema = await run(process.execPath, ["scripts/pg-load-schema.mjs"], {
        cwd: directory,
        extraEnv,
      });
      await writeFile(join(evidence, `${mutation}-schema.log`), schema.output);
      console.log(`MCP safety: ${mutation}: building production Brain ${sha}`);
      const build = await run(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
        cwd: directory,
        extraEnv,
        allowFailure: true,
      });
      await writeFile(join(evidence, `${mutation}-build.log`), build.output);
      if (build.code !== 0) throw new Error(`Brain build failed; see ${mutation}-build.log`);
      console.log(`MCP safety: ${mutation}: running live stdio outcome assertions`);
      const test = await run(
        process.execPath,
        ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.mcp.config.ts"],
        { cwd: directory, extraEnv, allowFailure: true, timeout: 240000 }
      );
      await writeFile(join(evidence, `${mutation}-test.log`), test.output);
      result.exitCode = test.code;
      result.logSha256 = digest(test.output);
      if (!test.output.includes("MCP_FIXTURE_CLEANUP_OK"))
        throw new Error(`Fixture cleanup unverified: ${mutation}`);
      if (
        !test.output.includes("HTTP_SERVER_CLEANUP_OK") ||
        test.output.split("MCP_PROCESS_CLEANUP_OK").length !== 3
      ) {
        throw new Error(`Process cleanup unverified: ${mutation}`);
      }
      const assertion =
        mutation === "project-denial" ? "MCP_PROJECT_DENIAL:" : "MCP_ITEM_VISIBILITY:";
      const outcomeFailed =
        mutation === "baseline"
          ? test.code !== 0
          : test.code === 0 || !test.output.includes(assertion);
      if (outcomeFailed) {
        throw new Error(`Outcome gate failed: ${mutation}; see ${mutation}-test.log`);
      }
      console.log(`MCP safety: ${mutation}: expected outcome verified`);
    } catch (error) {
      primaryError = error;
      result.error = String(error);
    }
    try {
      if (created) {
        const existing = await run(
          "docker",
          ["ps", "-a", "--filter", `name=^${container}$`, "--format", "{{.Names}}"],
          { cleanup: true }
        );
        if (existing.output.trim())
          await run("docker", ["rm", "-f", "-v", container], { cleanup: true });
        const remaining = await run(
          "docker",
          ["ps", "-a", "--filter", `name=^${container}$`, "--format", "{{.Names}}"],
          { cleanup: true }
        );
        assert.equal(remaining.output.trim(), "", "Isolated database cleanup failed");
      }
      result.cleanup = true;
    } catch (error) {
      result.cleanupError = String(error);
      throw new AggregateError(
        [primaryError, error].filter(Boolean),
        [result.error, result.cleanupError].filter(Boolean).join("; ")
      );
    }
    if (primaryError) throw primaryError;
  }
} catch (error) {
  failed = error;
  report.error = String(error);
} finally {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* process already exited */
    }
  }
  await rm(scratch, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, "evidence.json"), JSON.stringify(report, null, 2) + "\n");
}
if (failed) throw failed;
