// Communication-domain config (AIO-140) — the settings the comms source (inbound signal
// emission) and the notification sender (outbound, tier-gated) both read.
//
// Two default-deny surfaces live here:
//  1. `channels`: a channel name → audience Tier map. A channel that is NOT listed is
//     UNRESOLVABLE — the sender refuses to send to it (never guesses a broad audience).
//  2. `lookbackHours`: a fixed, max-bounded lookback the source fetches (the collector's
//     per-cadence window then trims it further). It is a MAX bound, never a widener.
//
// Config is optional: a missing file yields safe defaults (no destination channel, empty
// channel-tier map, default lookback). A malformed file throws loudly rather than silently
// up-scoping an audience.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Tier } from "../signal.js";

export const COMMS_CONFIG_REL = ".aios/comms-config.json";

/** Fixed max lookback the source fetches (7 days). The collector's per-cadence `occurredAt`
 *  window (daily 1d / weekly 7d) trims this down — the source never derives a cadence window
 *  itself. Documented default; overridable via `lookbackHours` in the config file. */
export const DEFAULT_LOOKBACK_HOURS = 168;

/** Where connectors drop normalized activity, relative to the inbox spine folder. */
export const COMMS_ACTIVITY_BASENAME = "comms/activity.jsonl";

export interface SenderConfig {
  /** Explicit destination channel; when null the sender falls back to slack.defaultChannel. */
  channel: string | null;
  /** Trigger gate: the event name(s) the sender is configured to dispatch on. When null the
   *  gate is inactive (any authorized event may send); when set, an event whose name/kind is
   *  not listed is a no-op (never sent). This is the FIRST gate in `dispatchOnEvent`. */
  on: string[] | null;
}

export interface SlackConfig {
  defaultChannel: string | null;
}

export interface CommsConfig {
  /** Max lookback (hours) the source fetches. The collector trims per cadence. */
  lookbackHours: number;
  /** Override for the activity store; when null it is derived from the inbox spine folder. */
  activityPath: string | null;
  sender: SenderConfig;
  slack: SlackConfig;
  /** channel name → audience Tier. Default-deny: an unlisted channel is unresolvable. */
  channels: Map<string, Tier>;
}

const TIERS: ReadonlySet<string> = new Set<Tier>(["admin", "team", "external"]);

export function defaultCommsConfig(): CommsConfig {
  return {
    lookbackHours: DEFAULT_LOOKBACK_HOURS,
    activityPath: null,
    sender: { channel: null, on: null },
    slack: { defaultChannel: null },
    channels: new Map(),
  };
}

/** Load `.aios/comms-config.json` (or an explicit override path). Missing → safe defaults.
 *  Malformed → throws a clear error (never a silent up-scope). */
export function loadCommsConfig(root: string, overridePath?: string): CommsConfig {
  const file = overridePath ?? path.join(root, COMMS_CONFIG_REL);
  if (!existsSync(file)) return defaultCommsConfig();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`comms-config: cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`comms-config: invalid JSON in ${file}: ${(e as Error).message}`);
  }
  return parseCommsConfig(parsed, file);
}

/** Normalize `sender.on` to a non-empty list of event names, or null (gate inactive). Only an
 *  explicit `null` disables the gate; an EMPTY array is rejected loudly (it would otherwise
 *  silently broaden dispatch to every authorized event). Accepts a single string or an array of
 *  non-empty strings; rejects anything else. */
function parseSenderOn(raw: unknown): string[] | null {
  if (raw === null) return null;
  if (Array.isArray(raw) && raw.length === 0) {
    throw new Error(
      `comms-config: sender.on must not be an empty array (use null to disable the trigger gate)`
    );
  }
  const list = Array.isArray(raw) ? raw : [raw];
  const names: string[] = [];
  for (const v of list) {
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(`comms-config: sender.on must be a non-empty string or array of strings`);
    }
    names.push(v.trim());
  }
  return names;
}

/** Validate + normalize a parsed config object. Exposed for tests. */
export function parseCommsConfig(parsed: unknown, file = "<config>"): CommsConfig {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`comms-config: ${file} must be a JSON object`);
  }
  const o = parsed as Record<string, unknown>;
  const cfg = defaultCommsConfig();

  if (o.lookbackHours !== undefined) {
    if (
      typeof o.lookbackHours !== "number" ||
      !Number.isFinite(o.lookbackHours) ||
      o.lookbackHours <= 0
    ) {
      throw new Error(`comms-config: lookbackHours must be a positive number`);
    }
    cfg.lookbackHours = o.lookbackHours;
  }

  if (o.activityPath !== undefined) {
    if (typeof o.activityPath !== "string" || !o.activityPath.trim()) {
      throw new Error(`comms-config: activityPath must be a non-empty string`);
    }
    cfg.activityPath = o.activityPath;
  }

  if (o.sender !== undefined) {
    if (!o.sender || typeof o.sender !== "object" || Array.isArray(o.sender)) {
      throw new Error(`comms-config: sender must be an object`);
    }
    const s = o.sender as Record<string, unknown>;
    if (s.channel !== undefined) {
      if (s.channel !== null && (typeof s.channel !== "string" || !s.channel.trim())) {
        throw new Error(`comms-config: sender.channel must be a non-empty string or null`);
      }
      cfg.sender.channel = s.channel as string | null;
    }
    if (s.on !== undefined) {
      cfg.sender.on = parseSenderOn(s.on);
    }
  }

  if (o.slack !== undefined) {
    if (!o.slack || typeof o.slack !== "object" || Array.isArray(o.slack)) {
      throw new Error(`comms-config: slack must be an object`);
    }
    const sl = o.slack as Record<string, unknown>;
    if (sl.defaultChannel !== undefined) {
      if (
        sl.defaultChannel !== null &&
        (typeof sl.defaultChannel !== "string" || !sl.defaultChannel.trim())
      ) {
        throw new Error(`comms-config: slack.defaultChannel must be a non-empty string or null`);
      }
      cfg.slack.defaultChannel = sl.defaultChannel as string | null;
    }
  }

  if (o.channels !== undefined) {
    if (!o.channels || typeof o.channels !== "object" || Array.isArray(o.channels)) {
      throw new Error(`comms-config: channels must be an object (channel → tier)`);
    }
    for (const [name, tier] of Object.entries(o.channels as Record<string, unknown>)) {
      if (typeof tier !== "string" || !TIERS.has(tier)) {
        throw new Error(
          `comms-config: channels["${name}"] must be one of admin|team|external (got ${JSON.stringify(tier)})`
        );
      }
      cfg.channels.set(name, tier as Tier);
    }
  }

  return cfg;
}

/**
 * Resolve a destination channel's audience Tier. DEFAULT-DENY: a channel absent from the
 * `channels` map is unresolvable (returns null), so the sender refuses to send rather than
 * assuming a broad audience. Reused by the outbound gate.
 */
export function resolveChannelTier(config: CommsConfig, channel: string): Tier | null {
  return config.channels.get(channel) ?? null;
}
