import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hostTargets } from "../scripts/mcp-hosts.mjs";
import {
  installMcpHosts,
  inspectMcpHosts,
  validateInstallerCredential,
  verifyServerCommand,
} from "../scripts/mcp-host-install.mjs";
import { filePolicy } from "../scripts/mcp-host-files.mjs";
import { offerOnboardingMcp, cmdMcpHost } from "../scripts/mcp-host-command.mjs";
import { TOOLSETS } from "../packages/mcp-core/capabilities.mjs";

import { credential, fetchImpl, fixture, put, tree } from "./lib/mcp-host-fixture.mjs";

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
  assert.ok(
    !JSON.stringify(tree(f.home)).includes(Buffer.from(credential.api_key).toString("base64"))
  );
  assert.deepEqual(fs.readdirSync(f.home), ["project"]);
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
    `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({id:1,result:{protocolVersion:'2025-11-25',serverInfo:{version:'0.1.1'}}}));console.log(JSON.stringify({id:2,result:{tools:${JSON.stringify(names)}.map(name=>({name,annotations:{readOnlyHint:true}}))}}))})`;
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

test(
  "macOS Desktop installation distinguishes Claude Code and the browser bridge",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const otherProcesses = [
      "/Users/example/.local/bin/claude",
      "/Applications/Claude.app/Contents/Helpers/chrome-native-host",
    ];
    const before = tree(f.home);
    const result = await installMcpHosts({
      ...f,
      hosts: ["claude-desktop"],
      dryRun: true,
      runningHosts: () => otherProcesses,
    });
    assert.equal(result.dry_run, true);
    assert.deepEqual(tree(f.home), before);
    for (const desktop of [
      "Claude",
      "/Applications/Claude.app/Contents/MacOS/Claude",
      '"/Applications/Claude.app/Contents/MacOS/Claude"',
    ]) {
      await assert.rejects(
        installMcpHosts({
          ...f,
          hosts: ["claude-desktop"],
          dryRun: true,
          runningHosts: () => [...otherProcesses, desktop],
        }),
        /Claude Desktop is running/
      );
    }
    await assert.rejects(
      installMcpHosts({
        ...f,
        hosts: ["claude-code"],
        dryRun: true,
        runningHosts: () => otherProcesses,
      }),
      /Claude Code is running/
    );
  }
);

test(
  "Linux lowercase Cursor blocks preflight and a mid-transaction launch",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = { ...fixture(t), platform: "linux" };
    const processLine = "/opt/cursor/cursor --no-sandbox";
    const before = tree(f.home);
    await assert.rejects(
      installMcpHosts({ ...f, hosts: ["cursor"], runningHosts: () => [processLine] }),
      /Cursor is running/
    );
    assert.deepEqual(tree(f.home), before);
    let calls = 0;
    await assert.rejects(
      installMcpHosts({
        ...f,
        hosts: ["cursor"],
        runningHosts: () => (++calls === 1 ? [] : [processLine]),
      }),
      /started during/
    );
    assert.equal(fs.existsSync(hostTargets(f)[3].file), false);
  }
);
