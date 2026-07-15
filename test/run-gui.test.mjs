import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildGuiClient, guiLaunchPlan, scrubGuiWorkspaceEnv } from "../scripts/run-gui.mjs";

test("builds the GUI client on every launch instead of trusting a stale dist", () => {
  const calls = [];
  const root = "/tmp/aios-workspace";

  buildGuiClient({
    root,
    run(command, args, options) {
      calls.push({ command, args, options });
    },
  });

  assert.deepEqual(calls, [
    {
      command: "npm",
      args: ["run", "build", "--workspace", "gui/client"],
      options: { cwd: root, stdio: "inherit" },
    },
  ]);
});

test("selected workspace replaces conflicting toolkit credentials and preserves GUI controls", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "run-gui-target-"));
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  try {
    writeFileSync(
      path.join(repo, ".env"),
      "LINEAR_API_KEY=target-linear-value\nAIOS_API_KEY=target-aios-value\n"
    );
    const plan = guiLaunchPlan({
      args: ["--repo", repo],
      root,
      ambient: {
        ...process.env,
        LINEAR_API_KEY: "toolkit-linear-value",
        AIOS_API_KEY: "toolkit-aios-value",
        AIOS_GUI_TOKEN: "keep-this-control-token",
        DOTENV_PRIVATE_KEY: "wrong-workspace-key",
        DOTENV_PRIVATE_KEY_PRODUCTION: "wrong-production-key",
      },
    });

    assert.equal(plan.options.env.LINEAR_API_KEY, undefined);
    assert.equal(plan.options.env.AIOS_API_KEY, undefined);
    assert.equal(plan.options.env.DOTENV_PRIVATE_KEY, undefined);
    assert.equal(plan.options.env.DOTENV_PRIVATE_KEY_PRODUCTION, undefined);
    assert.equal(plan.options.env.AIOS_GUI_TOKEN, "keep-this-control-token");

    // Exercise the real dotenvx process. It emits no values; the child communicates only by exit.
    execFileSync(
      plan.command,
      [
        ...plan.args.slice(0, plan.args.indexOf(process.execPath) + 1),
        "-e",
        "process.exit(process.env.LINEAR_API_KEY === 'target-linear-value' && process.env.AIOS_API_KEY === 'target-aios-value' && process.env.AIOS_GUI_TOKEN === 'keep-this-control-token' ? 0 : 1)",
      ],
      { ...plan.options, stdio: "ignore" }
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a key missing from the selected workspace cannot inherit the toolkit value", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "run-gui-missing-"));
  try {
    writeFileSync(path.join(repo, ".env"), "AIOS_MEMBER=target-member\n");
    const env = scrubGuiWorkspaceEnv({
      ambient: { LINEAR_API_KEY: "toolkit-only-value", AIOS_GUI_TOKEN: "preserved" },
      root: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
      repo,
    });
    assert.equal(env.LINEAR_API_KEY, undefined);
    assert.equal(env.AIOS_GUI_TOKEN, "preserved");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
