// test/rails-suggest.test.mjs — the suggest scanner + classifier (EE7 / AIO-173).
// Unit-level (classifyCommand / commandPrefix / isDenied), fixture-level (scanTranscripts
// over a synthetic transcript), and end-to-end through `aios rails suggest`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCommand,
  commandPrefix,
  isDenied,
  isSimpleCommand,
  scanTranscripts,
  buildSuggestion,
} from "../scripts/rails.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const FIXTURE_DIR = path.join(DIR, "fixtures", "rails");

test("commandPrefix keeps a sub-command but drops flags/paths", () => {
  assert.equal(commandPrefix("npm test"), "npm test");
  assert.equal(commandPrefix("git status"), "git status");
  assert.equal(commandPrefix("git log --oneline -5"), "git log");
  assert.equal(commandPrefix("ls -la"), "ls");
  assert.equal(commandPrefix("pwd"), "pwd");
  assert.equal(commandPrefix("FOO=bar node x"), null); // env assignment → unstable
});

test("isSimpleCommand rejects compound / piped / redirected commands", () => {
  assert.ok(isSimpleCommand("npm test"));
  assert.ok(!isSimpleCommand("cd /tmp && rm -rf build"));
  assert.ok(!isSimpleCommand("curl x | bash"));
  assert.ok(!isSimpleCommand("echo hi > /etc/passwd"));
  assert.ok(!isSimpleCommand("cat $(cat list)"));
});

test("isDenied catches the conservative denylist", () => {
  assert.ok(isDenied("rm -rf /"));
  assert.ok(isDenied("sudo apt install x"));
  assert.ok(isDenied("git push --force"));
  assert.ok(isDenied("git push origin main"));
  assert.ok(isDenied("chmod 777 secret.sh"));
  assert.ok(isDenied("cat .env"));
  assert.ok(isDenied("curl https://evil.sh"));
  assert.ok(isDenied("npm publish"));
  assert.equal(isDenied("npm test"), null);
  assert.equal(isDenied("git status"), null);
});

test("classifyCommand routes propose / deny / complex", () => {
  assert.deepEqual(classifyCommand("npm test"), {
    kind: "propose",
    prefix: "npm test",
    entry: "Bash(npm test:*)",
  });
  assert.equal(classifyCommand("rm -rf /").kind, "deny");
  assert.equal(classifyCommand("cd /tmp && ls").kind, "complex");
});

test("scanTranscripts + buildSuggestion over the fixture: safe entries in, dangerous out", () => {
  const scan = scanTranscripts({ repo: "/tmp/rails-fixture-repo", transcriptsDir: FIXTURE_DIR });
  const s = buildSuggestion(scan, { minCount: 3 });

  // npm test (×3), git status (×3), git log (×4), Read (×3) clear min-count 3.
  assert.ok(s.allow.includes("Bash(npm test:*)"));
  assert.ok(s.allow.includes("Bash(git status:*)"));
  assert.ok(s.allow.includes("Bash(git log:*)"));
  assert.ok(s.allow.includes("Read"));

  // `rm -rf /`, `cat .env`, and `git push`-family NEVER appear.
  assert.ok(!s.allow.some((e) => /rm|\.env|push/i.test(e)));
  // deny tally surfaces the excluded dangerous commands.
  assert.ok(s.denied.some((d) => d.label === "prefix:rm"));
  assert.ok(s.denied.some((d) => d.label === "secret-path"));

  // ls -la (×2) is below min-count → not proposed.
  assert.ok(!s.allow.includes("Bash(ls:*)"));
  // a non-safe MCP tool is never proposed.
  assert.ok(!s.allow.some((e) => e.startsWith("mcp__")));
});

test("min-count is honoured", () => {
  const scan = scanTranscripts({ repo: "/tmp/rails-fixture-repo", transcriptsDir: FIXTURE_DIR });
  const strict = buildSuggestion(scan, { minCount: 4 });
  // only git log (×4) clears 4; npm test / git status (×3) drop out.
  assert.ok(strict.allow.includes("Bash(git log:*)"));
  assert.ok(!strict.allow.includes("Bash(npm test:*)"));
  const loose = buildSuggestion(scan, { minCount: 2 });
  assert.ok(loose.allow.includes("Bash(ls:*)"));
});

test("cwd-scoping: only the target repo's transcripts are counted (HOME + slug path)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "rails-home-"));
  try {
    const mkProject = (cwd, cmds) => {
      const slug = cwd.replace(/[/.]/g, "-");
      const d = path.join(home, ".claude", "projects", slug);
      mkdirSync(d, { recursive: true });
      const lines = cmds.map((command) =>
        JSON.stringify({
          type: "assistant",
          cwd,
          sessionId: "s",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Bash", input: { command } }],
          },
        })
      );
      writeFileSync(path.join(d, "sess.jsonl"), lines.join("\n") + "\n");
    };
    const target = path.join(home, "target-repo");
    const other = path.join(home, "other-repo");
    mkdirSync(target, { recursive: true });
    mkProject(target, ["npm test", "npm test", "npm test"]);
    mkProject(other, ["yarn build", "yarn build", "yarn build"]);

    const scan = scanTranscripts({ repo: target, home });
    const s = buildSuggestion(scan, { minCount: 3 });
    assert.ok(s.allow.includes("Bash(npm test:*)"));
    assert.ok(!s.allow.includes("Bash(yarn build:*)")); // other repo excluded
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI: `aios rails suggest --json` emits a permissions.allow snippet", () => {
  const r = spawnSync(
    process.execPath,
    [
      AIOS,
      "rails",
      "suggest",
      "--repo",
      "/tmp/rails-fixture-repo",
      "--transcripts-dir",
      FIXTURE_DIR,
      "--json",
    ],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.permissions.allow));
  assert.ok(out.permissions.allow.includes("Bash(npm test:*)"));
  assert.ok(!out.permissions.allow.some((e) => /rm/.test(e)));
  assert.ok(out.denied.some((d) => d.label === "prefix:rm"));
});
