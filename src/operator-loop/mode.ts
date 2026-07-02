// Attention mode (AIO-168) — deep-work / orchestration toggle for the LOCAL notification ping.
//
// Deep-work sets Claude Code's `preferredNotifChannel` to "notifications_disabled" (silences the
// local iTerm2 ping); orchestration restores exactly what was there before — including absence
// (unset means Claude Code's default channel). The prior value is remembered in a sidecar state
// file so restore never guesses. `agentPushNotifEnabled` (mobile push) is NEVER touched.
//
// Settings writes are atomic (temp + rename) and re-serialize only the parsed JSON — a malformed
// settings file aborts loudly rather than being clobbered.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const NOTIF_CHANNEL_KEY = "preferredNotifChannel";
export const NOTIF_DISABLED_VALUE = "notifications_disabled";

export type AttentionMode = "deep-work" | "orchestration";

/** Where the toggle operates. Machine-global by default; injectable for tests. */
export interface ModePaths {
  /** Claude Code user settings (default: ~/.claude/settings.json). */
  settingsPath: string;
  /** Sidecar remembering the pre-deep-work channel (default: ~/.claude/aios-mode.json). */
  statePath: string;
}

export function defaultModePaths(): ModePaths {
  const dir = path.join(os.homedir(), ".claude");
  return {
    settingsPath: path.join(dir, "settings.json"),
    statePath: path.join(dir, "aios-mode.json"),
  };
}

/** Sidecar shape. `saved.present=false` means the key was absent before deep-work. */
interface ModeState {
  version: 1;
  mode: AttentionMode;
  saved: { present: boolean; value?: unknown };
  changedAt: string;
}

export interface ModeStatus {
  mode: AttentionMode;
  channel: string | null;
  settingsPath: string;
}

export interface ModeChange extends ModeStatus {
  changed: boolean;
}

function readSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) {
    throw new Error(`mode: settings file not found: ${settingsPath}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`mode: settings file is not a JSON object: ${settingsPath}`);
  }
  return parsed as Record<string, unknown>;
}

function writeSettingsAtomic(settingsPath: string, settings: Record<string, unknown>): void {
  const tmp = settingsPath + `.aios-mode-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, settingsPath);
}

function readState(statePath: string): ModeState | null {
  if (!existsSync(statePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const s = parsed as Record<string, unknown>;
    if (s.version !== 1 || (s.mode !== "deep-work" && s.mode !== "orchestration")) return null;
    if (typeof s.saved !== "object" || s.saved === null) return null;
    return parsed as ModeState;
  } catch {
    return null; // unreadable sidecar → treat as no memory (restore falls back to unset)
  }
}

function writeState(statePath: string, state: ModeState): void {
  const tmp = statePath + `.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, statePath);
}

function channelOf(settings: Record<string, unknown>): string | null {
  const v = settings[NOTIF_CHANNEL_KEY];
  return typeof v === "string" ? v : null;
}

/** Current mode is derived from the settings file itself, so drift (a hand-edit) is never hidden. */
export function modeStatus(paths: ModePaths = defaultModePaths()): ModeStatus {
  const settings = readSettings(paths.settingsPath);
  const channel = channelOf(settings);
  return {
    mode: channel === NOTIF_DISABLED_VALUE ? "deep-work" : "orchestration",
    channel,
    settingsPath: paths.settingsPath,
  };
}

/** Silence the local ping. Remembers the prior channel (or its absence) for restore. Idempotent. */
export function enterDeepWork(paths: ModePaths = defaultModePaths()): ModeChange {
  const settings = readSettings(paths.settingsPath);
  const current = settings[NOTIF_CHANNEL_KEY];
  if (current === NOTIF_DISABLED_VALUE) {
    return {
      mode: "deep-work",
      channel: NOTIF_DISABLED_VALUE,
      settingsPath: paths.settingsPath,
      changed: false,
    };
  }
  writeState(paths.statePath, {
    version: 1,
    mode: "deep-work",
    saved: NOTIF_CHANNEL_KEY in settings ? { present: true, value: current } : { present: false },
    changedAt: new Date().toISOString(),
  });
  settings[NOTIF_CHANNEL_KEY] = NOTIF_DISABLED_VALUE;
  writeSettingsAtomic(paths.settingsPath, settings);
  return {
    mode: "deep-work",
    channel: NOTIF_DISABLED_VALUE,
    settingsPath: paths.settingsPath,
    changed: true,
  };
}

/**
 * Restore the pre-deep-work channel: the exact saved value, deletion if it was absent, or (with
 * no sidecar memory) deletion back to Claude Code's default. Idempotent. Never touches push.
 */
export function enterOrchestration(paths: ModePaths = defaultModePaths()): ModeChange {
  const settings = readSettings(paths.settingsPath);
  const current = settings[NOTIF_CHANNEL_KEY];
  if (current !== NOTIF_DISABLED_VALUE) {
    return {
      mode: "orchestration",
      channel: channelOf(settings),
      settingsPath: paths.settingsPath,
      changed: false,
    };
  }
  const state = readState(paths.statePath);
  if (state?.saved.present) {
    settings[NOTIF_CHANNEL_KEY] = state.saved.value;
  } else {
    delete settings[NOTIF_CHANNEL_KEY];
  }
  writeSettingsAtomic(paths.settingsPath, settings);
  if (existsSync(paths.statePath)) {
    try {
      unlinkSync(paths.statePath); // memory consumed — a fresh deep-work re-saves
    } catch {
      /* stale sidecar is harmless; next deep-work overwrites it */
    }
  }
  return {
    mode: "orchestration",
    channel: channelOf(settings),
    settingsPath: paths.settingsPath,
    changed: true,
  };
}
