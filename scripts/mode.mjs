/**
 * mode.mjs — `aios mode` (AIO-168): deep-work / orchestration attention toggle.
 *
 * Flips Claude Code's `preferredNotifChannel` in ~/.claude/settings.json: deep-work
 * silences the local iTerm2 ping; orchestration restores exactly the prior value
 * (including absence, via a sidecar memory). Mobile push (`agentPushNotifEnabled`)
 * is never touched. Extracted from scripts/aios.mjs (AIO-315); behaviour-preserving.
 */

import path from "node:path";
import { c, die } from "./cli-common.mjs";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";

export async function cmdMode(repo, cfg, args) {
  // A leading flag means no subcommand: `aios mode --json` = `aios mode status --json`.
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "status";
  const asJson = args.includes("--json");
  const loop = await loadOperatorLoop();
  const settingsArg = (() => {
    const i = args.indexOf("--settings");
    return i >= 0 ? args[i + 1] : null;
  })();
  // Sidecar is always the sibling `aios-mode.json` of the settings file — the SAME derivation as
  // defaultModePaths(), so `--settings ~/.claude/settings.json` and the default share one memory.
  const paths = settingsArg
    ? {
        settingsPath: settingsArg,
        statePath: path.join(path.dirname(path.resolve(settingsArg)), "aios-mode.json"),
      }
    : loop.defaultModePaths();

  let out;
  try {
    if (sub === "status") out = { ...loop.modeStatus(paths), changed: false };
    else if (sub === "deep-work") out = loop.enterDeepWork(paths);
    else if (sub === "orchestration") out = loop.enterOrchestration(paths);
    else die("usage: aios mode [status|deep-work|orchestration] [--settings <path>] [--json]");
  } catch (e) {
    die(String(e?.message ?? e));
  }
  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const ping = out.mode === "deep-work" ? "silenced" : (out.channel ?? "default");
  // "(no change)" only makes sense on a toggle that was already in that mode — not on status.
  const note = sub !== "status" && !out.changed ? "  (no change)" : "";
  console.log(c.blue("aios mode") + `  ${out.mode}` + c.dim(`  · local ping: ${ping}${note}`));
}
