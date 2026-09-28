/** Exact installed profile commands against a disposable HTTPS Brain. No command/verifier seam. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:https";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { prepareProfile } from "./mcp-support.mjs";

async function child(ctx, args, env, cwd, label) {
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      process_.kill();
      reject(new Error(`${label} timed out`));
    }, 300000);
    process_.stdout.on("data", (data) => (stdout += data));
    process_.stderr.on("data", (data) => (stderr += data));
    process_.on("error", reject);
    process_.on("close", (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
  });
  ctx.recordCommand({ cmd: process.execPath, args, ...result, label, started });
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  return result;
}
function session(command, env, cwd) {
  const process_ = spawn(command.command, command.args, {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "",
    stderr = "";
  const received = new Map();
  process_.stdout.on("data", (data) => {
    buffer += data;
    for (let at; (at = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(at + 1)) {
      const message = JSON.parse(buffer.slice(0, at));
      received.set(message.id, message);
    }
  });
  process_.stderr.on("data", (data) => (stderr += data));
  return {
    async rpc(id, method, params = {}) {
      process_.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      for (let n = 0; n < 1000; n++) {
        if (received.has(id)) return received.get(id);
        if (process_.exitCode !== null) throw new Error(`Profile server exited: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Profile server response deadline");
    },
    async close() {
      process_.stdin.end();
      await new Promise((resolve) => process_.once("close", resolve));
    },
    kill() {
      process_.kill();
    },
  };
}
export async function profileHostJourney(ctx, install) {
  const root = path.join(ctx.base, "mcp-profiles");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const cert = path.join(root, "certificate.pem"),
    key = path.join(root, "private.pem");
  ctx.runWithAmbientEnv(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { cwd: root, label: "profile-fixture-certificate" }
  );
  const requests = [];
  const server = createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (request, response) => {
      requests.push(request.url);
      request.resume();
      request.on("end", () => {
        const authorized = request.headers.authorization === "Bearer synthetic-profile-key";
        const body =
          request.url === "/api/v1/me"
            ? { actor: "synthetic-member", team: "synthetic-team", role: "member", tier: "team" }
            : request.url === "/api/v1/projects/synthetic-project"
              ? { project_id: "synthetic-project", team_id: "synthetic-team" }
              : { items: [] };
        response.writeHead(authorized ? 200 : 401, { "Content-Type": "application/json" });
        response.end(JSON.stringify(authorized ? body : { error: "unauthorized" }));
      });
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${server.address().port}`,
    results = [];
  try {
    for (const mode of ["brain-only", "workspace"]) {
      const home = path.join(root, mode);
      fs.mkdirSync(home, { mode: 0o700 });
      prepareProfile(ctx, home);
      const workspace = path.join(home, "selected");
      fs.mkdirSync(workspace);
      const neutral = path.join(home, "neutral");
      fs.mkdirSync(neutral);
      const env = ctx.cliEnv({
        HOME: home,
        USERPROFILE: home,
        AIOS_CONFIG_DIR: path.join(home, "config"),
        PROFILE_KEY: "synthetic-profile-key",
        NODE_EXTRA_CA_CERTS: cert,
      });
      const register = [
        install.bin,
        "mcp",
        "profile",
        "register",
        "--profile",
        "selected",
        "--mode",
        mode,
        "--brain-origin",
        origin,
        "--team",
        "synthetic-team",
        "--project-id",
        "synthetic-project",
        "--credential-source",
        "selected",
        "--reference",
        "env:PROFILE_KEY",
        ...(mode === "workspace"
          ? ["--root", workspace, "--grant", "workspaceRead", "--read-root", "2-work"]
          : []),
      ];
      await child(ctx, register, env, neutral, `profile-register-${mode}`);
      const status = await child(
        ctx,
        [install.bin, "mcp", "profile", "status", "--profile", "selected", "--json"],
        env,
        neutral,
        `profile-status-${mode}`
      );
      assert.equal(JSON.parse(status.stdout).identityVerified, true);
      const artifact = ctx.profileArtifact(mode),
        tarball = path.join(home, "artifact.tgz");
      fs.writeFileSync(tarball, artifact.tarball, { mode: 0o600 });
      const data = path.join(home, "install-input.json");
      fs.writeFileSync(
        data,
        JSON.stringify({
          home,
          project: workspace,
          profileId: "selected",
          hosts: ["cursor"],
          artifactInput: { ...artifact, tarball: undefined },
          tarball,
        }),
        { mode: 0o600 }
      );
      const runner = path.join(home, "install-fixture.mjs");
      fs.writeFileSync(
        runner,
        `import fs from 'node:fs';import {installMcpHosts} from ${JSON.stringify(pathToFileURL(path.join(install.pkgDir, "scripts/mcp-host-install.mjs")).href)};const o=JSON.parse(fs.readFileSync(process.argv[2]));o.artifactInput.tarball=fs.readFileSync(o.tarball);o.env=process.env;o.runningHosts=()=>[];console.log(JSON.stringify(await installMcpHosts(o)));`
      );
      await child(ctx, [runner, data], env, neutral, `profile-installed-host-${mode}`);
      const records = JSON.parse(
        fs.readFileSync(path.join(home, ".aios", "mcp-installations.json"))
      );
      const entry = records.installations[0].entry;
      assert.ok(!JSON.stringify(entry).includes(ctx.checkoutRoot));
      assert.ok(entry.args.includes("--profile"));
      assert.ok(
        entry.args.some((arg) =>
          arg.endsWith(mode === "workspace" ? "scripts/brain-mcp.mjs" : "bin/aios-brain-mcp.mjs")
        )
      );
      const live = session(entry, env, neutral);
      try {
        assert.equal((await live.rpc(1, "tools/list")).result.tools.length, 9);
        const checked = await live.rpc(2, "tools/call", { name: "brain_status" });
        assert.notEqual(checked.result.isError, true);
        await child(
          ctx,
          [install.bin, "mcp", "profile", "revoke", "--profile", "selected"],
          env,
          neutral,
          `profile-revoke-${mode}`
        );
        const before = requests.length;
        assert.equal((await live.rpc(3, "tools/list")).error.code, -32000);
        assert.equal(
          (await live.rpc(4, "tools/call", { name: "brain_status" })).result.isError,
          true
        );
        assert.equal(requests.length, before, "revoked cached tool does not reach Brain");
      } finally {
        await live.close();
      }
      // Public uninstall exercises ownership but leaves the revoked profile and its epoch intact.
      await child(
        ctx,
        [install.bin, "mcp", "uninstall", "--host", "cursor"],
        env,
        neutral,
        `profile-uninstall-${mode}`
      );
      const after = JSON.parse(fs.readFileSync(path.join(home, ".aios", "mcp-installations.json")));
      assert.equal(after.profileEpochs.selected.revoked, true);
      results.push({
        mode,
        artifactIntegrity: artifact.integrity,
        recordedCommand: true,
        identityVerified: true,
        revocationLive: true,
        uninstallPreservedAuthorityRecord: true,
      });
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  ctx.record("mcp-profile-installed-journeys", results);
  return results;
}
