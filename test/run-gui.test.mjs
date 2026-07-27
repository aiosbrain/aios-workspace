import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A real secp256k1 keypair in dotenvx's hex form (64-char zero-padded private). */
function dotenvKeypair() {
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.generateKeys();
  return {
    priv: ecdh.getPrivateKey("hex").padStart(64, "0"),
    pub: ecdh.getPublicKey("hex", "compressed"),
  };
}

import {
  buildGuiClient,
  guiLaunchPlan,
  normalizeGuiLauncherArgs,
  scrubGuiWorkspaceEnv,
} from "../scripts/run-gui.mjs";

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

test("desktop skip-build still routes through the credential-safe launcher", () => {
  const launch = normalizeGuiLauncherArgs([
    "--skip-build",
    "--repo",
    "/tmp/selected-workspace",
    "--port",
    "8790",
  ]);
  assert.equal(launch.skipBuild, true);
  assert.deepEqual(launch.serverArgs, ["--repo", "/tmp/selected-workspace", "--port", "8790"]);
});

test("selected workspace replaces conflicting toolkit credentials and preserves GUI controls", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "run-gui-target-"));
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const targetLinear = ["target", "linear", "value"].join("-");
  const targetAios = ["target", "aios", "value"].join("-");
  const toolkitLinear = ["toolkit", "linear", "value"].join("-");
  const toolkitAios = ["toolkit", "aios", "value"].join("-");
  const guiControl = ["keep", "this", "control"].join("-");
  try {
    writeFileSync(
      path.join(repo, ".env"),
      `LINEAR_API_KEY=${targetLinear}\nAIOS_API_KEY=${targetAios}\n`
    );
    const plan = guiLaunchPlan({
      args: ["--repo", repo],
      root,
      ambient: {
        ...process.env,
        LINEAR_API_KEY: toolkitLinear,
        AIOS_API_KEY: toolkitAios,
        AIOS_GUI_TOKEN: guiControl,
        DOTENV_PRIVATE_KEY: "wrong-workspace-key",
        DOTENV_PRIVATE_KEY_PRODUCTION: "wrong-production-key",
      },
    });

    assert.equal(plan.options.env.LINEAR_API_KEY, undefined);
    assert.equal(plan.options.env.AIOS_API_KEY, undefined);
    assert.equal(plan.options.env.DOTENV_PRIVATE_KEY, undefined);
    assert.equal(plan.options.env.DOTENV_PRIVATE_KEY_PRODUCTION, undefined);
    assert.equal(plan.options.env.AIOS_GUI_TOKEN, guiControl);

    // Exercise the real dotenvx process. It emits no values; the child communicates only by exit.
    const expected = JSON.stringify({
      linear: targetLinear,
      aios: targetAios,
      control: guiControl,
    });
    execFileSync(
      plan.command,
      [
        ...plan.args.slice(0, plan.args.indexOf(process.execPath) + 1),
        "-e",
        `const e=${expected}; process.exit(process.env.LINEAR_API_KEY === e.linear && process.env.AIOS_API_KEY === e.aios && process.env.AIOS_GUI_TOKEN === e.control ? 0 : 1)`,
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

test("an ambient-key-only workspace keeps its own dotenv key but drops foreign ones", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "run-gui-ambient-key-"));
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const mine = dotenvKeypair();
  const foreign = dotenvKeypair();
  try {
    // Encrypted workspace .env: the public key is plaintext, the value is encrypted,
    // and the matching PRIVATE key lives ONLY in the ambient env (direnv) — there is
    // no local .env.keys. The launcher must not delete the one key that can decrypt.
    writeFileSync(
      path.join(repo, ".env"),
      `DOTENV_PUBLIC_KEY="${mine.pub}"\nAIOS_API_KEY="encrypted:BOGUS"\n`
    );
    const env = scrubGuiWorkspaceEnv({
      ambient: {
        DOTENV_PRIVATE_KEY: mine.priv, // the selected workspace's own key — must survive
        DOTENV_PRIVATE_KEY_PRODUCTION: foreign.priv, // a different workspace's key — must go
        AIOS_GUI_TOKEN: "keep-me",
      },
      root,
      repo,
    });
    assert.equal(env.DOTENV_PRIVATE_KEY, mine.priv, "matching workspace key preserved");
    assert.equal(env.DOTENV_PRIVATE_KEY_PRODUCTION, undefined, "foreign key scrubbed");
    assert.equal(env.AIOS_GUI_TOKEN, "keep-me");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The GUI Telegram lane (AIO-386) starts automatically and addresses ONE chat. Launching
// `npm run gui -- --repo <other-workspace>` from a shell/direnv still exporting a previous
// workspace's credentials would otherwise send THIS workspace's ask ids, count and repo label to
// the PREVIOUS workspace's chat, because dotenvx lets existing process.env values win.
test("ambient Telegram credentials never cross the selected-workspace boundary", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "run-gui-telegram-"));
  try {
    writeFileSync(path.join(repo, ".env"), "AIOS_MEMBER=target-member\n");
    const env = scrubGuiWorkspaceEnv({
      ambient: {
        AIOS_TELEGRAM_BOT_TOKEN: "other-workspace-bot",
        AIOS_TELEGRAM_CHAT_ID: "other-workspace-chat",
        AIOS_TELEGRAM_DISABLED: "1",
        TELEGRAM_BOT_TOKEN: "unscoped-bot",
        TELEGRAM_CHAT_ID: "unscoped-chat",
        AIOS_GUI_TOKEN: "preserved",
      },
      root: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
      repo,
    });
    for (const name of [
      "AIOS_TELEGRAM_BOT_TOKEN",
      "AIOS_TELEGRAM_CHAT_ID",
      "AIOS_TELEGRAM_DISABLED",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
    ]) {
      assert.equal(env[name], undefined, `${name} leaked across the workspace boundary`);
    }
    // GUI control variables still survive the boundary.
    assert.equal(env.AIOS_GUI_TOKEN, "preserved");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
