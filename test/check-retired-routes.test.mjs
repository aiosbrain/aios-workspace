// AIO-1072 — retired-route gate (scripts/check-retired-routes.mjs). The AIO-1067/
// AIO-1068 cutover deletes the skill-vendored provider clients; this gate keeps
// them gone. These tests pin the contract's two halves:
//   (a) EXECUTABLE ownership fails — a file existing at a retired client path, a
//       spawn/import of one from a .mjs, a .py client under a .claude tree;
//   (b) innocent prose NEVER fails — markdown mentions, JS comment lines, and the
//       allowlisted compat delegates (scripts/linear.mjs, scripts/connectors/**).
// Runs the real script against synthetic trees via its argv[2] root override
// (mirrors test/check-linear-skill-parity.test.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-retired-routes.mjs");

function makeTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "retired-routes-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

// run(repoRoot) → { status, output } from the real script (argv[2] = root override).
function run(repoRoot) {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, repoRoot], { encoding: "utf8" });
    return { status: 0, output };
  } catch (err) {
    return { status: err.status, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// withTree(files, fn) — build, run the gate, always clean up.
function withTree(files, fn) {
  const root = makeTree(files);
  try {
    fn(run(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A minimal clean repo: connector routes + compat delegates, no retired clients.
const CLEAN = {
  [path.join("scripts", "aios.mjs")]: 'import { connectors } from "./connectors.mjs";\n',
  [path.join("scripts", "linear.mjs")]:
    '// compat delegate\nimport { spawnSync } from "node:child_process";\nspawnSync(process.execPath, ["scripts/connectors/linear/index.mjs"]);\n',
  [path.join("scripts", "connectors", "slack", "index.mjs")]:
    "// ported from slack.py — the one Slack implementation\nexport const VERBS = {};\n",
  [path.join("docs", "notes.md")]: "The old `.claude/skills/aios-linear/linear.mjs` is retired.\n",
};

test("clean repo passes", () => {
  withTree(CLEAN, ({ status, output }) => {
    assert.equal(status, 0, output);
    assert.match(output, /no retired connector routes/);
  });
});

for (const retired of [
  path.join(".claude", "skills", "aios-linear", "linear.mjs"),
  path.join(
    "scaffold",
    ".claude",
    "descriptors",
    "skills",
    "linear-direct",
    "linear-query-client.mjs"
  ),
  path.join("scaffold", ".claude", "descriptors", "skills", "slack-personal", "slack.py"),
  path.join(
    "scaffold",
    ".claude",
    "descriptors",
    "skills",
    "slack-personal",
    "slack-activity-pull.mjs"
  ),
]) {
  test(`planted retired file fails naming the path: ${retired}`, () => {
    withTree({ ...CLEAN, [retired]: "// resurrected client\n" }, ({ status, output }) => {
      assert.equal(status, 1);
      const posix = retired.split(path.sep).join("/");
      assert.ok(output.includes(posix), `names the path, got:\n${output}`);
      assert.match(output, /retired client path exists/);
    });
  });
}

test("a spawn of .claude/skills/aios-linear/linear.mjs from a .mjs fails", () => {
  withTree(
    {
      ...CLEAN,
      [path.join("scripts", "board-sync.mjs")]:
        'import { spawnSync } from "node:child_process";\n' +
        'spawnSync(process.execPath, [".claude/skills/aios-linear/linear.mjs", "get", "AIO-1"]);\n',
    },
    ({ status, output }) => {
      assert.equal(status, 1);
      assert.match(output, /board-sync\.mjs:2/);
      assert.match(output, /imports\/spawns retired client \(skills\/aios-linear\/linear\.mjs\)/);
    }
  );
});

test("an import of linear-query-client from a .mjs fails", () => {
  withTree(
    {
      ...CLEAN,
      [path.join("scripts", "query.mjs")]:
        'import { queryAssignedOpenIssues } from "./linear-query-client.mjs";\n',
    },
    ({ status, output }) => {
      assert.equal(status, 1);
      assert.match(output, /query\.mjs:1/);
      assert.match(output, /linear-query-client/);
    }
  );
});

test("a shell script invoking slack.py on a non-comment line fails", () => {
  withTree(
    {
      ...CLEAN,
      [path.join("scripts", "pull.sh")]:
        "#!/usr/bin/env bash\n# slack.py used to live here\npython3 .claude/skills/slack-personal/slack.py whoami\n",
    },
    ({ status, output }) => {
      assert.equal(status, 1);
      assert.match(output, /pull\.sh:3/);
      assert.match(output, /slack\.py/);
    }
  );
});

test("a .py provider client under a .claude tree fails even off the retired-path list", () => {
  withTree(
    { ...CLEAN, [path.join(".claude", "skills", "slack-cli", "slack.py")]: "print('hi')\n" },
    ({ status, output }) => {
      assert.equal(status, 1);
      assert.match(
        output,
        /slack\.py — \.py provider client under a \.claude skills\/descriptors tree/
      );
    }
  );
});

test("a skill's unrelated Python tooling under .claude passes (not a provider client)", () => {
  withTree(
    {
      ...CLEAN,
      [path.join(".claude", "skills", "evolve", "scripts", "analyze_history.py")]: "print('hi')\n",
    },
    ({ status, output }) => {
      assert.equal(status, 0, output);
    }
  );
});

test("a markdown file mentioning linear.mjs passes (prose is never flagged)", () => {
  withTree(
    {
      ...CLEAN,
      [path.join("docs", "migration.md")]:
        "Run `node .claude/skills/aios-linear/linear.mjs` — retired; also spawnSync of slack.py.\n",
    },
    ({ status, output }) => {
      assert.equal(status, 0, output);
    }
  );
});

test("a JS comment mentioning slack.py passes (comment lines are never flagged)", () => {
  withTree(
    {
      ...CLEAN,
      [path.join("test", "slack-parity.test.mjs")]:
        "// parity baseline against slack.py's argparse surface\n" +
        "/* the old spawn of skills/aios-linear/linear.mjs is gone */\n" +
        " * import of linear-query-client used to happen here\n" +
        "export const ok = true;\n",
    },
    ({ status, output }) => {
      assert.equal(status, 0, output);
    }
  );
});

test("a non-import string mention in JS passes (executable context only)", () => {
  withTree(
    {
      ...CLEAN,
      [path.join("test", "guard.test.mjs")]:
        'const blocked = ["python3 .claude/skills/slack-personal/slack.py whoami"];\n' +
        "export default blocked;\n",
    },
    ({ status, output }) => {
      assert.equal(status, 0, output);
    }
  );
});

test("allowlisted delegates and connectors are never flagged", () => {
  withTree(
    {
      ...CLEAN,
      // exec-context references inside allowlisted files must not fail the gate
      [path.join("scripts", "slack.mjs")]:
        'import { spawnSync } from "node:child_process";\n' +
        '// governed delegate: replaced slack.py\nspawnSync("node", ["scripts/connectors/slack/index.mjs"]);\n',
      [path.join("scripts", "connectors", "linear", "index.mjs")]:
        'import { relabel } from "./verbs.mjs"; // ports linear-query-client behavior\n',
    },
    ({ status, output }) => {
      assert.equal(status, 0, output);
    }
  );
});
