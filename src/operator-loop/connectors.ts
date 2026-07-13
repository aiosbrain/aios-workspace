// AIO-366 — bounded, fail-open connector preamble for a recording owner daily run.
//
// This is loop-core (the composition point), not a workflow domain: it invokes the three shipped
// connector adapters concurrently, waits until each has exited or hit ITS OWN deadline, and returns
// non-secret status values. Connector stdout/stderr is never inherited, so `loop daily --json`
// remains a clean machine surface and a failing connector cannot leak response/credential text.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type DailyConnectorName = "granola" | "gog" | "slack";
export type DailyConnectorStatus = "ok" | "failed" | "timed_out" | "skipped";

export interface DailyConnectorResult {
  name: DailyConnectorName;
  status: DailyConnectorStatus;
  durationMs: number;
  /** Fixed, non-secret diagnostic only. Child output and thrown error messages are never copied. */
  detail?: string;
}

export interface DailyConnectorPullResult {
  connectors: DailyConnectorResult[];
}

export interface DailyConnectorTimeouts {
  granola: number;
  gog: number;
  slack: number;
}

export interface DailyConnectorCredentials {
  brainUrl?: string;
  apiKey?: string;
  teamId?: string;
}

export interface ConnectorCommand {
  name: DailyConnectorName;
  file: string;
  command: string;
  args: string[];
}

export type ConnectorSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface PullDailyConnectorsOptions {
  root: string;
  now?: Date;
  timeouts?: Partial<DailyConnectorTimeouts>;
  credentials?: DailyConnectorCredentials;
  env?: NodeJS.ProcessEnv;
  spawn?: ConnectorSpawn;
}

export const DEFAULT_DAILY_CONNECTOR_TIMEOUTS: Readonly<DailyConnectorTimeouts> = Object.freeze({
  granola: 30_000,
  gog: 20_000,
  slack: 20_000,
});

const CONNECTOR_TIMEOUT_OVERRIDE_ENV = "AIOS_LOOP_CONNECTOR_TIMEOUT_MS";

function positiveMs(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The three shipped manual adapters, expressed as the automatic daily command set. */
export function dailyConnectorCommands(root: string, now = new Date()): ConnectorCommand[] {
  const skillRoot = path.join(root, ".claude", "descriptors", "skills");
  const granola = path.join(skillRoot, "granola-direct", "granola-pull.mjs");
  const gog = path.join(skillRoot, "gog-activity", "gog-activity-pull.mjs");
  const slack = path.join(skillRoot, "slack-personal", "slack-activity-pull.mjs");
  return [
    {
      name: "granola",
      file: granola,
      command: process.execPath,
      args: [granola, "--repo", root, "--since", now.toISOString().slice(0, 10)],
    },
    {
      name: "gog",
      file: gog,
      command: process.execPath,
      args: [gog, "--repo", root],
    },
    {
      name: "slack",
      file: slack,
      command: process.execPath,
      args: [slack, "--repo", root],
    },
  ];
}

function childEnv(
  base: NodeJS.ProcessEnv,
  credentials: DailyConnectorCredentials | undefined
): NodeJS.ProcessEnv {
  const env = { ...base };
  // Credentials stay in the inherited environment (never argv or result details). Do not replace an
  // explicitly supplied connector environment value with an empty CLI config field.
  if (credentials?.brainUrl) env.AIOS_BRAIN_URL = credentials.brainUrl;
  if (credentials?.apiKey) env.AIOS_API_KEY = credentials.apiKey;
  if (credentials?.teamId) env.AIOS_TEAM = credentials.teamId;
  return env;
}

function runConnector(
  spec: ConnectorCommand,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  spawnConnector: ConnectorSpawn
): Promise<DailyConnectorResult> {
  const started = Date.now();
  if (!existsSync(spec.file)) {
    return Promise.resolve({
      name: spec.name,
      status: "skipped",
      durationMs: Date.now() - started,
      detail: "adapter not installed",
    });
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (status: DailyConnectorStatus, detail?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ name: spec.name, status, durationMs: Date.now() - started, detail });
    };

    try {
      child = spawnConnector(spec.command, spec.args, {
        cwd: path.dirname(spec.file),
        env,
        stdio: "ignore",
      });
    } catch {
      finish("failed", "adapter could not start");
      return;
    }

    child.once("error", () => finish("failed", "adapter could not start"));
    child.once("close", (code, signal) => {
      if (code === 0) finish("ok");
      else
        finish(
          "failed",
          code === null ? `adapter stopped (${signal ?? "unknown"})` : `exit ${code}`
        );
    });

    timer = setTimeout(() => {
      // Resolve immediately after requesting termination: even a wedged/unkillable child must never
      // hold the daily renderer. A short, unref'd SIGKILL backstop cleans up ordinary stragglers.
      try {
        child.kill("SIGTERM");
        // If the OS refuses both signals, the dead adapter still must not keep the CLI event loop
        // alive after the daily has rendered.
        child.unref?.();
        const killTimer = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          } catch {
            // Best-effort cleanup only; the fail-open result has already settled.
          }
        }, 250);
        killTimer.unref();
      } catch {
        // The process may already be gone; timeout status remains the honest bounded result.
      }
      finish("timed_out", `timed out after ${timeoutMs}ms`);
    }, timeoutMs);
  });
}

/** Run every installed daily connector with an independent deadline. Never rejects. */
export async function pullDailyConnectors(
  opts: PullDailyConnectorsOptions
): Promise<DailyConnectorPullResult> {
  const root = path.resolve(opts.root);
  const baseEnv = opts.env ?? process.env;
  const override = positiveMs(baseEnv[CONNECTOR_TIMEOUT_OVERRIDE_ENV]);
  const timeouts: DailyConnectorTimeouts = {
    granola: opts.timeouts?.granola ?? override ?? DEFAULT_DAILY_CONNECTOR_TIMEOUTS.granola,
    gog: opts.timeouts?.gog ?? override ?? DEFAULT_DAILY_CONNECTOR_TIMEOUTS.gog,
    slack: opts.timeouts?.slack ?? override ?? DEFAULT_DAILY_CONNECTOR_TIMEOUTS.slack,
  };
  const run = opts.spawn ?? ((command, args, options) => spawn(command, args, options));
  const env = childEnv(baseEnv, opts.credentials);
  const commands = dailyConnectorCommands(root, opts.now);

  const connectors = await Promise.all(
    commands.map((spec) => runConnector(spec, timeouts[spec.name], env, run))
  );
  return { connectors };
}
