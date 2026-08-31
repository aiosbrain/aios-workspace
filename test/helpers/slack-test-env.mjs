/**
 * Shared spawn plumbing for the AIO-1068 Slack adapter suites: a scrubbed environment
 * (no ambient AIOS/Slack/Linear credentials, no agent-context.json via HOME, no workspace
 * vault) plus a synthetic token and the in-process mock provider. Kept local to the Slack
 * suites on purpose — AIO-1028 owns the general test-env scrubbing rework.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const AIOS = path.join(ROOT, "scripts", "aios.mjs");
export const SLACK_BIN = path.join(ROOT, "scripts", "slack.mjs");
export const MOCK = path.join(ROOT, "test", "helpers", "mock-slack-provider.mjs");

export const SYNTHETIC_TOKEN = "xoxp-synthetic-parity-token-not-real";

/** Copy process.env minus every ambient credential/config source the adapter reads. */
export function scrubbedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AIOS_|SLACK_|LINEAR_)/.test(key)) delete env[key];
  }
  delete env.AGENT_CONTEXT;
  delete env.HERMES_HOME;
  env.HOME = mkdtempSync(path.join(tmpdir(), "aio-1068-home-"));
  env.AIOS_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aio-1068-cfg-"));
  env.AIOS_DISABLE_WORKSPACE_CREDENTIALS = "1";
  return { ...env, ...overrides };
}

/** Run a Slack CLI route under the mock provider with a capture log; returns the result + log. */
export function runSlack(bin, args, { env = scrubbedEnv(), input, cwd = ROOT, mock = true } = {}) {
  const logFile = path.join(mkdtempSync(path.join(tmpdir(), "aio-1068-log-")), "requests.jsonl");
  const argv = mock ? ["--import", MOCK, bin, ...args] : [bin, ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd,
    encoding: "utf8",
    input,
    env: { ...env, AIOS_SLACK_MOCK_LOG: logFile },
  });
  let requests = [];
  try {
    requests = readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    requests = [];
  }
  return { ...result, requests };
}
