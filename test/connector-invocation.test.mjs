import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const ROOT = path.resolve(import.meta.dirname, "..");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "connector-invocation-"));
  const a = path.join(root, "a"),
    b = path.join(root, "b"),
    toolkit = path.join(root, "toolkit");
  for (const [ws, label] of [
    [a, "a"],
    [b, "b"],
  ]) {
    mkdirSync(path.join(ws, "scripts"), { recursive: true });
    writeFileSync(path.join(ws, "aios.yaml"), "owner: fixture\npm_tool: none\n");
    writeFileSync(
      path.join(ws, ".env"),
      `LINEAR_API_KEY=fixture-${label}\nAIOS_BRAIN_URL=https://brain-${label}.example\nAIOS_API_KEY=brain-${label}\n`
    );
  }
  copyFileSync(path.join(ROOT, "scaffold/scripts/aios.mjs"), path.join(a, "scripts/aios.mjs"));
  mkdirSync(path.join(toolkit, "scripts"), { recursive: true });
  copyFileSync(path.join(ROOT, "scripts/aios.mjs"), path.join(toolkit, "scripts/aios.mjs"));
  writeFileSync(
    path.join(toolkit, "scripts/cli.mjs"),
    `export { run } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/cli.mjs")).href)};`
  );
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    AIOS_TOOLKIT_DIR: toolkit,
    AIOS_CONFIG_DIR: path.join(root, "config"),
  };
  return { root, a, b, env };
}
const command = (f, provider, route) =>
  route === "shim"
    ? [path.join(f.a, "scripts/aios.mjs"), provider]
    : route === "canonical"
      ? [path.join(ROOT, "scripts/aios.mjs"), provider]
      : [path.join(ROOT, `scripts/${provider}.mjs`)];

const MOCK = `import assert from "node:assert/strict";
const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.hostname === "api.linear.app") {
    assert.equal(init.headers.Authorization, "fixture-b");
    return json({ data: { viewer: { name: "fixture", assignedIssues: { nodes: [{ id: "target-b", identifier: "B-1", title: "Target B", updatedAt: "2026-09-01T00:00:00Z", state: { name: "Backlog" } }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  }
  if (target.pathname === "/api/v1/me/slack-token") {
    assert.equal(target.hostname, "brain-b.example"); assert.equal(init.headers.Authorization, "Bearer brain-b");
    return json({ connected: true, token: "xoxp-synthetic-parity-token-not-real", slack_user_id: "ME" });
  }
  assert.equal(target.hostname, "slack.com"); assert.equal(init.headers.Authorization, "Bearer xoxp-synthetic-parity-token-not-real");
  if (target.pathname.endsWith("auth.test")) return json({ ok: true, user_id: "ME", user: "fixture", team: "B", team_id: "B" });
  if (target.pathname.endsWith("conversations.list")) return json({ ok: true, channels: [{ id: "CB", name: "target", last_read: "100.000000", latest: { ts: "102.000000" }, unread_count: 1 }] });
  if (target.pathname.endsWith("conversations.history")) return json({ ok: true, messages: [{ type: "message", user: "OTHER", ts: "101.000000", text: "B activity" }] });
  throw new Error("unexpected mock request");
};`;

test("relative Slack uploads preserve caller bytes across workspace selection and delegation", () => {
  const f = fixture();
  try {
    const subdir = path.join(f.a, "reports");
    mkdirSync(subdir);
    writeFileSync(path.join(subdir, "report.txt"), "the caller's intended report");
    for (const ws of [f.a, f.b]) writeFileSync(path.join(ws, "report.txt"), "wrong root file");
    const preload = path.join(f.root, "upload-mock.mjs");
    writeFileSync(
      preload,
      `
import assert from "node:assert/strict";
const json = (value) => Response.json(value);
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.hostname === "uploads.example.test") {
    assert.equal(Buffer.from(init.body).toString(), "the caller's intended report");
    return new Response("ok");
  }
  assert.equal(target.hostname, "slack.com");
  assert.equal(init.headers.Authorization, "Bearer xoxp-synthetic-parity-token-not-real");
  if (target.pathname.endsWith("files.getUploadURLExternal")) return json({ ok: true, file_id: "FMOCK", upload_url: "https://uploads.example.test/file" });
  if (target.pathname.endsWith("files.completeUploadExternal")) return json({ ok: true, files: [{ id: "FMOCK" }] });
  throw new Error("unexpected mocked request");
};`
    );
    for (const route of ["canonical", "compatibility", "shim"])
      for (const repoArgs of [[], ["--repo", f.b]]) {
        const r = spawnSync(
          process.execPath,
          [
            ...command(f, "slack", route),
            "file",
            "--target",
            "C0GENERAL",
            "--path",
            "report.txt",
            "--json",
            ...repoArgs,
          ],
          {
            cwd: subdir,
            env: {
              ...f.env,
              NODE_OPTIONS: `--import ${preload}`,
              SLACK_USER_TOKEN: "xoxp-synthetic-parity-token-not-real",
            },
            encoding: "utf8",
          }
        );
        assert.equal(r.status, 0, `${route}/${repoArgs}: ${r.stderr}`);
        assert.equal(JSON.parse(r.stdout).files[0].id, "FMOCK");
      }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("one target supplies credentials and activity output through canonical, compatibility and real shim routes", () => {
  const f = fixture();
  try {
    const preload = path.join(f.root, "mock.mjs");
    writeFileSync(preload, MOCK);
    f.env.NODE_OPTIONS = `--import ${preload}`;
    for (const provider of ["linear", "slack"])
      for (const route of ["canonical", "compatibility", "shim"]) {
        for (const syntax of ["absolute", "relative", "equals"]) {
          const repoArgs =
            syntax === "equals"
              ? [`--repo=${f.b}`]
              : ["--repo", syntax === "relative" ? "../b" : f.b];
          const output = `logs/${provider}-${route}-${syntax}.jsonl`;
          const r = spawnSync(
            process.execPath,
            [
              "--import",
              preload,
              ...command(f, provider, route),
              "activity",
              "pull",
              ...repoArgs,
              "--activity-path",
              output,
            ],
            { cwd: f.a, env: f.env, encoding: "utf8" }
          );
          assert.equal(r.status, 0, `${provider}/${route}/${syntax}: ${r.stderr}`);
          assert.equal(
            JSON.parse(readFileSync(path.join(f.b, output), "utf8").trim()).source,
            provider
          );
          assert.equal(existsSync(path.join(f.a, "logs")), false);
        }
      }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("invalid connector input and help never access configuration, credentials, providers or destinations", () => {
  const f = fixture();
  try {
    const trace = path.join(f.root, "accessed"),
      preload = path.join(f.root, "guard.mjs");
    writeFileSync(
      preload,
      `import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeFileSync;
const touched = () => { write(${JSON.stringify(trace)}, "accessed"); throw new Error("unexpected protected access"); };
for (const name of ["readFileSync", "existsSync", "statSync", "lstatSync", "writeFileSync", "appendFileSync"]) {
  const original = fs[name]; fs[name] = (...args) => {
    const file = String(args[0]);
    if (file.startsWith(${JSON.stringify(f.root)}) && !file.endsWith("guard.mjs") && !file.startsWith(${JSON.stringify(path.join(f.root, "toolkit"))}) && file !== ${JSON.stringify(path.join(f.a, "scripts/aios.mjs"))}) touched();
    return original(...args);
  };
}
const spawn = cp.spawnSync;
cp.spawnSync = (command, ...args) => command === process.execPath ? spawn(command, ...args) : touched();
cp.execFileSync = touched; globalThis.fetch = touched;
syncBuiltinESMExports();`
    );
    f.env.NODE_OPTIONS = `--import ${preload}`;
    for (const configured of [false, true])
      for (const provider of ["linear", "slack"])
        for (const route of ["canonical", "compatibility", "shim"]) {
          const invalid = [
            ["activity", "pull", "--repo"],
            ["activity", "pull", "--repo", "--help"],
            ["activity", "pull", "--repo", f.a, "--repo", f.b],
            ["activity", "pull", "--repo="],
            ["activity", "pull", "--repo=-h"],
            ["activity", "pull", "--dry-rnu"],
          ];
          if (provider === "linear")
            invalid.push(
              ["query", "--nope"],
              ["query", "--vars"],
              ["query", "--vars", "invalid"],
              ["query", "--vars", "[]"],
              ["query", "one", "two"]
            );
          for (const [args, expected] of [
            ...invalid.map((args) => [args, 2]),
            [["activity", "pull", "--help", "--repo", f.b], 0],
          ]) {
            const r = spawnSync(
              process.execPath,
              ["--import", preload, ...command(f, provider, route), ...args],
              {
                cwd: f.a,
                env: {
                  ...f.env,
                  ...(configured
                    ? {
                        LINEAR_API_KEY: "fixture-b",
                        SLACK_USER_TOKEN: "xoxp-synthetic-parity-token-not-real",
                      }
                    : {}),
                },
                encoding: "utf8",
              }
            );
            assert.equal(r.status, expected, `${provider}/${route}/${args}: ${r.stderr}`);
            assert.equal(existsSync(trace), false, `${provider}/${args} touched protected state`);
          }
        }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("targeted templates, query, get and Slack whoami retain canonical/delegate parity", () => {
  const f = fixture();
  try {
    for (const [ws, label] of [
      [f.a, "A"],
      [f.b, "B"],
    ]) {
      const file = path.join(ws, "docs/agentic-ergonomics/aios-issue-template.md");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `Template ${label}\n`);
    }
    const slackMock = path.join(f.root, "slack.mjs");
    writeFileSync(slackMock, MOCK);
    for (const [provider, args] of [
      ["linear", ["template", "aios"]],
      ["linear", ["query"]],
      ["linear", ["get", "AIO-73"]],
      ["slack", ["whoami", "--json"]],
    ]) {
      const preload =
        provider === "linear"
          ? path.join(ROOT, "test/helpers/mock-linear-provider.mjs")
          : slackMock;
      const env = {
        ...f.env,
        NODE_OPTIONS: `--import ${preload}`,
        ...(provider === "linear" ? { MOCK_EXPECT_AUTH: "fixture-b" } : {}),
      };
      const outputs = ["canonical", "compatibility"].map((route) => {
        const r = spawnSync(
          process.execPath,
          [...command(f, provider, route), ...args, "--repo", f.b],
          { cwd: f.a, env, encoding: "utf8" }
        );
        assert.equal(r.status, 0, r.stderr);
        return r.stdout;
      });
      assert.equal(outputs[0], outputs[1]);
      if (args[0] === "template") assert.equal(outputs[0], "Template B\n");
    }
    for (const provider of ["linear", "slack"]) {
      const absolute = path.join(f.root, `${provider}-explicit.jsonl`);
      const r = spawnSync(
        process.execPath,
        [
          ...command(f, provider, "canonical"),
          "activity",
          "pull",
          "--repo",
          f.b,
          "--activity-path",
          absolute,
        ],
        { cwd: f.a, env: { ...f.env, NODE_OPTIONS: `--import ${slackMock}` }, encoding: "utf8" }
      );
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(absolute));
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
