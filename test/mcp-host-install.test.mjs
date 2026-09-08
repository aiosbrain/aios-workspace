import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hostTargets } from "../scripts/mcp-hosts.mjs";
import {
  installMcpHosts,
  inspectMcpHosts,
  validateInstallerCredential,
  verifyServerCommand,
} from "../scripts/mcp-host-install.mjs";
import { filePolicy, commitHostFiles } from "../scripts/mcp-host-files.mjs";
import { offerOnboardingMcp, cmdMcpHost } from "../scripts/mcp-host-command.mjs";
import { atomicHostReplace } from "../scripts/mcp-host-atomic.mjs";
import {
  installedServerCommand,
  prepareServerArtifact,
  decodeServerArtifact,
} from "../scripts/mcp-host-artifact.mjs";
import { createServer } from "node:http";
import { TOOLSETS } from "../packages/mcp-core/capabilities.mjs";

const credential = {
  brain_url: "https://brain.example",
  api_key: "test-key",
  team_id: "synthetic",
};
const fetchImpl = async () => ({
  ok: true,
  json: async () => ({ tier: "team", actor: "synthetic", role: "member", team: "synthetic" }),
});
function fixtureOwner(file) {
  if (process.platform !== "win32") return;
  // Elevated Windows CI creates files owned by Administrators by default. These
  // fixtures model an explicitly user-owned home; do not relax production checks.
  const script =
    "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; $p=$env:AIOS_TEST_OWNER_PATH; $a=Get-Acl -LiteralPath $p; $a.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User); Set-Acl -LiteralPath $p -AclObject $a";
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, AIOS_TEST_OWNER_PATH: file },
    stdio: "pipe",
    timeout: 5000,
  });
}
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-host-test-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  fixtureOwner(home);
  fixtureOwner(project);
  return {
    home,
    project,
    platform: process.platform === "win32" ? "win32" : "darwin",
    env: {},
    credential,
    fetchImpl,
    runningHosts: () => [],
    command: { command: process.execPath, args: ["synthetic-mcp-driver"] },
    verify: async () => ({ verified: true, tools: ["synthetic"] }),
  };
}
function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  if (process.platform === "win32") {
    fixtureOwner(file);
    for (let dir = path.dirname(file); dir.includes("mcp-host-test-"); dir = path.dirname(dir))
      fixtureOwner(dir);
  }
}
function tree(root) {
  const rows = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const s = fs.lstatSync(file);
      rows[file] = [
        s.mtimeMs,
        s.mode,
        entry.isDirectory() ? "directory" : fs.readFileSync(file).toString("base64"),
      ];
      if (entry.isDirectory()) walk(file);
    }
  }
  walk(root);
  return rows;
}

test("four platform adapters resolve documented global/project targets", () => {
  const win = hostTargets({
    home: "C:\\Users\\alex",
    project: "C:\\work",
    platform: "win32",
    env: { APPDATA: "C:\\Users\\alex\\AppData\\Roaming" },
  });
  assert.equal(
    win[0].file,
    "C:\\Users\\alex\\AppData\\Roaming\\Claude\\claude_desktop_config.json"
  );
  assert.equal(win[1].file, "C:\\work\\.mcp.json");
  assert.equal(win[2].file, "C:\\Users\\alex\\.codex\\config.toml");
  assert.equal(win[3].file, "C:\\Users\\alex\\.cursor\\mcp.json");
  assert.equal(hostTargets({ platform: "linux" })[0].supported, false);
});

test("install all four, preserve unrelated configuration, repeat, rotate and uninstall", async (t) => {
  const f = fixture(t);
  const hosts = hostTargets(f);
  const ids = hosts.map((host) => host.id);
  put(
    hosts[0].file,
    JSON.stringify({
      mcpServers: { unrelated: { command: "other", env: { TOKEN: "other-token" } } },
      preferences: { theme: "dark" },
    })
  );
  const toml =
    '# Preserve this exact text\nmodel = "example"\nlarge = 9223372036854775807\n[mcp_servers.other]\ncommand = "other"\n';
  put(hosts[2].file, toml);
  const result = await installMcpHosts({ ...f, hosts: ids });
  assert.equal(result.changes.length, 4);
  assert.equal(result.command_verification[0].verified, true);
  for (const host of hosts) {
    const text = fs.readFileSync(host.file, "utf8");
    assert.ok(!text.includes(credential.api_key));
    assert.ok(text.includes("AIOS_MCP_INSTALLER"));
  }
  assert.ok(fs.readFileSync(hosts[2].file, "utf8").startsWith(toml));
  assert.equal(
    JSON.parse(fs.readFileSync(hosts[0].file)).mcpServers.unrelated.env.TOKEN,
    "other-token"
  );
  const before = tree(f.home);
  await installMcpHosts({ ...f, hosts: ids });
  assert.deepEqual(tree(f.home), before);
  assert.ok(
    inspectMcpHosts(f).every(
      (host) => host.configured && host.owned && host.host_loading === "unverified"
    )
  );
  await installMcpHosts({
    ...f,
    hosts: ids,
    credential: { ...credential, api_key: "rotated-key" },
  });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.home, ".aios/credentials.json"))).default.api_key,
    "rotated-key"
  );
  const removed = await installMcpHosts({ ...f, hosts: ids, uninstall: true });
  assert.equal(removed.changes.length, 4);
  assert.equal(fs.readFileSync(hosts[2].file, "utf8"), toml);
  assert.ok(fs.existsSync(path.join(f.home, ".aios/credentials.json")));
  if (process.platform !== "win32")
    for (const backup of result.backups) assert.equal(fs.statSync(backup).mode & 0o077, 0);
});

test("dry-run leaves all bytes, permissions and mtimes unchanged, including absent state", async (t) => {
  const f = fixture(t);
  const host = hostTargets(f)[3];
  put(host.file, '{"mcpServers":{"other":{"command":"other","env":{"TOKEN":"other-token"}}}}');
  const before = tree(f.home);
  const result = await installMcpHosts({ ...f, hosts: [host.id], dryRun: true });
  assert.deepEqual(tree(f.home), before);
  assert.ok(!JSON.stringify(result).includes(credential.api_key));
  assert.ok(!JSON.stringify(result).includes("other-token"));
  assert.equal(fs.existsSync(path.join(f.home, ".aios")), false);
});

test("all targets preflight before writes; malformed JSON and TOML fail closed", async (t) => {
  for (const index of [2, 3]) {
    const f = fixture(t);
    const hosts = hostTargets(f);
    put(hosts[index].file, index === 2 ? "[mcp_servers\n" : '{"broken":');
    const before = tree(f.home);
    await assert.rejects(
      installMcpHosts({ ...f, hosts: [hosts[0].id, hosts[index].id] }),
      /malformed/
    );
    assert.deepEqual(tree(f.home), before);
  }
});

test("unowned and edited entries are refused on install and preserved on uninstall", async (t) => {
  const f = fixture(t);
  const host = hostTargets(f)[3];
  put(host.file, '{"mcpServers":{"aios-brain":{"command":"foreign"}}}');
  await assert.rejects(installMcpHosts({ ...f, hosts: [host.id] }), /unowned/);
  const before = tree(f.home);
  const result = await installMcpHosts({ ...f, hosts: [host.id], uninstall: true });
  assert.deepEqual(tree(f.home), before);
  assert.match(result.changes[0].action, /preserved/);
  fs.unlinkSync(host.file);
  await installMcpHosts({ ...f, hosts: [host.id] });
  const doc = JSON.parse(fs.readFileSync(host.file));
  doc.mcpServers["aios-brain"].args.push("edited");
  put(host.file, JSON.stringify(doc));
  const edited = tree(f.home);
  await installMcpHosts({ ...f, hosts: [host.id], uninstall: true });
  assert.deepEqual(tree(f.home), edited);
});

test("running hosts and process-list failures prevent all mutations", async (t) => {
  const f = fixture(t);
  const before = tree(f.home);
  await assert.rejects(
    installMcpHosts({ ...f, hosts: ["cursor"], runningHosts: () => ["Cursor"] }),
    /running/
  );
  await assert.rejects(
    installMcpHosts({
      ...f,
      hosts: ["cursor"],
      runningHosts: () => {
        throw new Error("process list unavailable");
      },
    }),
    /unavailable/
  );
  assert.deepEqual(tree(f.home), before);
});

test(
  "symlinks and foreign ownership fail closed",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const host = hostTargets(f)[3];
    put(path.join(f.home, "real.json"), "{}");
    fs.mkdirSync(path.dirname(host.file));
    fs.symlinkSync(path.join(f.home, "real.json"), host.file);
    await assert.rejects(installMcpHosts({ ...f, hosts: [host.id] }), /regular/);
    fs.unlinkSync(host.file);
    await assert.rejects(
      installMcpHosts({
        ...f,
        hosts: [host.id],
        policy: filePolicy({ uid: process.getuid() + 1 }),
      }),
      /ownership/
    );
  }
);

test("concurrent source edits are preserved and credentials roll back", async (t) => {
  const f = fixture(t);
  const host = hostTargets(f)[3];
  put(host.file, "{}");
  await assert.rejects(
    installMcpHosts({
      ...f,
      hosts: [host.id],
      beforeReplace: async (file) => {
        if (file === host.file) put(file, '{"concurrent":true}');
      },
    }),
    /Concurrent edit/
  );
  assert.equal(fs.readFileSync(host.file, "utf8"), '{"concurrent":true}');
  assert.equal(fs.existsSync(path.join(f.home, ".aios/credentials.json")), false);
});

test("partial failure restores prior writes but preserves a subsequently edited write", async (t) => {
  const f = fixture(t);
  const hosts = hostTargets(f);
  put(hosts[0].file, "{}");
  put(hosts[3].file, "{}");
  await assert.rejects(
    installMcpHosts({
      ...f,
      hosts: [hosts[0].id, hosts[3].id],
      afterReplace: async (file) => {
        if (file === hosts[0].file) put(file, '{"concurrent":true}');
      },
      beforeReplace: async (file) => {
        if (file === hosts[3].file) throw new Error("injected write failure");
      },
    }),
    /rollback conflicts/
  );
  assert.equal(fs.readFileSync(hosts[0].file, "utf8"), '{"concurrent":true}');
  assert.equal(fs.readFileSync(hosts[3].file, "utf8"), "{}");
});

test("failed command verification rolls back credentials before host writes", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    installMcpHosts({
      ...f,
      hosts: ["cursor"],
      verify: async () => {
        throw new Error("command failed");
      },
    }),
    /command failed/
  );
  assert.equal(fs.existsSync(hostTargets(f)[3].file), false);
  assert.equal(fs.existsSync(path.join(f.home, ".aios/credentials.json")), false);
});

test("credential validation rejects redirects, denied, malformed and delegated identities", async () => {
  for (const value of [{ ok: false }, { ok: true, json: async () => ({ tier: "team" }) }])
    await assert.rejects(validateInstallerCredential(credential, async () => value));
  await assert.rejects(
    validateInstallerCredential({ ...credential, api_key: "aiosd_synthetic" }, fetchImpl),
    /unsupported/
  );
  await validateInstallerCredential(credential, async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return fetchImpl();
  });
});

test("onboarding decline is first-class and never invokes the installer", async () => {
  assert.deepEqual(
    await offerOnboardingMcp(credential, {
      choose: async () => [],
      install: async () => {
        assert.fail("must not install");
      },
    }),
    { declined: true }
  );
  let passed;
  await offerOnboardingMcp(credential, {
    project: "/synthetic",
    choose: async () => ["cursor"],
    install: async (options) => {
      passed = options;
    },
  });
  assert.deepEqual(passed.hosts, ["cursor"]);
  assert.equal(passed.credential, credential);
});

test("source replacement with identical bytes is still a concurrent edit", async (t) => {
  const f = fixture(t);
  const host = hostTargets(f)[3];
  put(host.file, "{}");
  await assert.rejects(
    installMcpHosts({
      ...f,
      hosts: [host.id],
      beforeReplace: async (file) => {
        if (file === host.file) {
          fs.renameSync(file, file + ".concurrent");
          put(file, "{}");
        }
      },
    }),
    /Concurrent edit/
  );
  assert.equal(fs.readFileSync(host.file, "utf8"), "{}");
});

test("host starting after preflight aborts before replacement", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(
    installMcpHosts({
      ...f,
      hosts: ["cursor"],
      runningHosts: () => (++calls === 1 ? [] : ["Cursor"]),
    }),
    /started during/
  );
  assert.equal(fs.existsSync(hostTargets(f)[3].file), false);
});

test(
  "insecure existing credentials are not repaired implicitly",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const file = path.join(f.home, ".aios/credentials.json");
    put(file, JSON.stringify({ version: 1, default: credential }));
    fs.chmodSync(file, 0o644);
    const before = tree(f.home);
    await assert.rejects(installMcpHosts({ ...f, hosts: ["cursor"] }), /permissions/);
    assert.deepEqual(tree(f.home), before);
  }
);

test("recorded command verifies exact membership and rejects same-count drift", async (t) => {
  const f = fixture(t);
  const script = (names) =>
    `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({id:1,result:{protocolVersion:'2025-11-25',serverInfo:{version:'0.1.0'}}}));console.log(JSON.stringify({id:2,result:{tools:${JSON.stringify(names)}.map(name=>({name,annotations:{readOnlyHint:true}}))}}))})`;
  const entry = { command: process.execPath, args: ["-e", script(TOOLSETS.brain)], env: {} };
  const good = await verifyServerCommand(entry, { ...f, timeoutMs: 2000 });
  assert.equal(good.verified, true);
  await assert.rejects(
    verifyServerCommand(
      { ...entry, args: ["-e", script(["wrong", ...TOOLSETS.brain.slice(1)])] },
      { ...f, timeoutMs: 2000 }
    ),
    /did not pass/
  );
  await assert.rejects(
    verifyServerCommand(
      { ...entry, args: ["-e", "setInterval(()=>{},1000)"] },
      { ...f, timeoutMs: 100 }
    ),
    /did not pass/
  );
});

test("CLI dry-run, status and uninstall preserve redaction and report command verification", async (t) => {
  const f = fixture(t),
    output = [];
  const log = console.log;
  console.log = (value) => output.push(value);
  try {
    const before = tree(f.home);
    assert.equal(await cmdMcpHost(["install", "--host=cursor", "--dry-run", "--json"], f), 0);
    assert.deepEqual(tree(f.home), before);
    assert.equal(await cmdMcpHost(["install", "--host", "cursor"], f), 0);
    assert.equal(await cmdMcpHost(["status", "--host=cursor", "--json"], f), 0);
    const report = JSON.parse(output.at(-1));
    assert.equal(report.mcp_hosts[0].command_verification.verified, true);
    assert.equal(
      await cmdMcpHost(["status", "--host", "cursor"], {
        ...f,
        verify: async () => {
          throw new Error("probe failed");
        },
      }),
      1
    );
    assert.match(output.at(-1), /host loading\/restart: unverified/);
    assert.equal(await cmdMcpHost(["--host=cursor", "--uninstall"], f), 0);
    assert.ok(!output.join("\n").includes(credential.api_key));
    for (const args of [
      ["install", "--host"],
      ["install", "--unknown"],
      ["status", "--dry-run"],
      ["status", "--host=unknown"],
    ])
      await assert.rejects(cmdMcpHost(args, f));
  } finally {
    console.log = log;
  }
});

test(
  "unsafe private directory permissions fail before any credential write",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const directory = path.join(f.home, ".aios");
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0o770);
    const before = tree(f.home);
    await assert.rejects(
      installMcpHosts({ ...f, hosts: ["cursor"] }),
      /writable by another principal/
    );
    assert.deepEqual(tree(f.home), before);
  }
);

test("atomic replacement preserves edits made at the final syscall boundary", async (t) => {
  for (const kind of ["in-place", "replacement", "creation"]) {
    const f = fixture(t);
    const file = path.join(f.home, "config.json");
    if (kind !== "creation") put(file, "original");
    const policy = filePolicy();
    const source = policy.snapshot(file);
    let injected = false;
    await assert.rejects(
      commitHostFiles([{ source, bytes: Buffer.from("installer") }], {
        policy,
        atomicReplace: (...args) => {
          if (!injected) {
            injected = true;
            if (kind === "replacement") {
              put(file + ".editor", "concurrent");
              fs.renameSync(file + ".editor", file);
            } else put(file, "concurrent");
          }
          return atomicHostReplace(...args);
        },
      }),
      /Concurrent edit|EEXIST/
    );
    assert.equal(fs.readFileSync(file, "utf8"), "concurrent");
  }
});

test("published artifact resists project-local package shadowing and detects edits", async (t) => {
  const f = fixture(t);
  const marker = path.join(f.home, "shadow-ran");
  const shadow = path.join(f.project, "node_modules/@aiosbrain/mcp");
  put(
    path.join(shadow, "package.json"),
    JSON.stringify({
      name: "@aiosbrain/mcp",
      version: "0.1.0",
      bin: { "aios-brain-mcp": "evil.cjs" },
    })
  );
  put(
    path.join(shadow, "evil.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`
  );
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ tier: "team", actor: "synthetic", role: "member", team: "synthetic" })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const options = {
    ...f,
    command: undefined,
    verify: undefined,
    credential: { ...credential, brain_url: `http://127.0.0.1:${server.address().port}` },
    hosts: ["cursor"],
  };
  const before = tree(f.home);
  await installMcpHosts({ ...options, dryRun: true });
  assert.deepEqual(tree(f.home), before);
  const installed = await installMcpHosts(options);
  assert.equal(installed.command_verification[0].tools.length, 8);
  assert.equal(fs.existsSync(marker), false);
  const entry = installedServerCommand(f);
  assert.equal(entry.args.length, 1);
  assert.ok(entry.args[0].includes(path.join(".aios", "mcp", "0.1.0")));
  const repeated = tree(f.home);
  await installMcpHosts(options);
  assert.deepEqual(tree(f.home), repeated);
  assert.throws(() => decodeServerArtifact(Buffer.from("tampered")), /integrity/);
  const policy = filePolicy();
  await assert.rejects(
    prepareServerArtifact({ ...f, policy, fetchImpl: async () => ({ ok: false }) }),
    /download/
  );
  await assert.rejects(
    prepareServerArtifact({
      ...f,
      policy,
      fetchImpl: async () => ({
        ok: true,
        body: [Buffer.alloc(1024 * 1024 + 1)],
      }),
    }),
    /size limit/
  );
  put(entry.args[0], "edited");
  await assert.rejects(prepareServerArtifact({ ...f, policy, fetchImpl: fetch }), /edited/);
});

test(
  "Windows private parent ACL rejects an additional principal before mutation",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fixture(t);
    const directory = path.join(f.home, ".aios");
    fs.mkdirSync(directory);
    const policy = filePolicy();
    policy.secure(directory);
    const script =
      "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; " +
      "$p=$env:AIOS_TEST_OWNER_PATH; $a=Get-Acl -LiteralPath $p; " +
      "$sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); " +
      "$r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','Allow'); " +
      "$a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, AIOS_TEST_OWNER_PATH: directory },
      stdio: "pipe",
      timeout: 5000,
    });
    const before = tree(f.home);
    await assert.rejects(installMcpHosts({ ...f, hosts: ["cursor"] }), /ACL/);
    assert.deepEqual(tree(f.home), before);
  }
);

test("failure inspecting or securing a displaced file still rolls back the live write", async (t) => {
  for (const fault of ["permissions", ...(process.platform === "win32" ? [] : ["symlink"])]) {
    const f = fixture(t);
    const file = path.join(f.home, "config.json");
    put(file, "original");
    const policy = filePolicy();
    const secure = policy.secure;
    let armed = false;
    let injected = false;
    policy.secure = (target) => {
      if (armed && !injected && fault === "permissions") {
        injected = true;
        throw new Error("injected ACL failure");
      }
      secure(target);
    };
    await assert.rejects(
      commitHostFiles([{ source: policy.snapshot(file), bytes: Buffer.from("installer") }], {
        policy,
        atomicReplace: (...args) => {
          const displaced = atomicHostReplace(...args);
          armed = true;
          if (fault === "symlink" && !injected) {
            injected = true;
            fs.renameSync(displaced, displaced + ".preserved");
            fs.symlinkSync(displaced + ".preserved", displaced);
          }
          return displaced;
        },
      }),
      /ACL failure|regular/
    );
    assert.equal(fs.readFileSync(file, "utf8"), "original");
  }
});
