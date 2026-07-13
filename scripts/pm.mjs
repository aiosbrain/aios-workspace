import { createBrainClient } from "./brain-client.mjs";

function ageLabel(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function projectionHealthLine(payload) {
  if (!payload) return "pm projection: unavailable (brain API predates v1.9)";
  const health = payload.health ?? {};
  if (health.status === "never_run" || !health.lastRun) return "pm projection: never run";
  const run = health.lastRun;
  return (
    `pm projection: ${health.status ?? "unknown"} · ${ageLabel(health.ageMs)} · ` +
    `${run.created ?? 0} synced · ${run.error_count ?? 0} errors`
  );
}

export async function readProjectionHealth(cfg, deps = {}) {
  const client = createBrainClient(cfg, deps);
  try {
    return await client.fetchJson("GET", "/pm-sync/health?limit=10");
  } catch (error) {
    if (/^404\b/.test(String(error?.message))) return null;
    throw error;
  }
}

export async function printProjectionHealth(cfg, { optional = false, json = false, ...deps } = {}) {
  if (!cfg.brain_url || !cfg.api_key) {
    if (!optional) throw new Error("PM status requires a configured brain URL and API key");
    return null;
  }
  try {
    const payload = await readProjectionHealth(cfg, deps);
    console.log(
      json ? JSON.stringify(payload ?? { available: false }) : projectionHealthLine(payload)
    );
    return payload;
  } catch (error) {
    if (!optional) throw error;
    console.log(`pm projection: unavailable (${error?.message ?? error})`);
    return null;
  }
}

export async function cmdPm(cfg, args = []) {
  const [subcommand = "status"] = args.filter((arg) => !arg.startsWith("--"));
  if (subcommand !== "status") throw new Error("usage: aios pm status [--json]");
  return printProjectionHealth(cfg, { json: args.includes("--json") });
}
