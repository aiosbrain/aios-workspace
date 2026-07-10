/**
 * loop.mjs — server helpers for the cockpit Operator Loop panel (AIO-318).
 *
 * Wires the GUI to the terminal-only Operator Loop by shelling out to `aios loop <sub> --json`
 * (the SAME CLI the terminal + MCP use, so identity resolution and on-disk artifacts are
 * byte-identical). It lives in its own module — not in index.mjs, which self-boots an http
 * server on import — so the validation + reshaping logic is unit-testable without side effects,
 * mirroring the maturity.mjs / sessions-search.mjs convention.
 *
 * Two shapes of route:
 *   • pass-through (daily / collect / telemetry): return the CLI's --json object verbatim.
 *   • reshaped (weekly): the CLI emits the owner brief by PATH only (audience-safe); the server
 *     reads brief.md + next-week-actions.json off disk into the GUI contract.
 *
 * Lenient by design: loop subcommands print valid JSON to stdout BEFORE setting a business exit
 * code (weekly=1 on a non-shippable audience, telemetry=2 on a shipped tier leak). Those must
 * surface as `cliExitCode` on a 200, NOT as a 500 that hides usable panel data. A 500 is reserved
 * for a spawn failure, empty stdout, or unparseable JSON.
 *
 * Zero runtime dependencies beyond Node built-ins.
 */

import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AIOS_CLI = path.join(HERE, "..", "..", "scripts", "aios.mjs");

export const LOOP_CADENCES = ["daily", "weekly"];

/**
 * Validate the `cadence` query param. Returns "daily" | "weekly".
 * Throws a tagged 400 for anything else — it NEVER defaults, because the value is spliced into
 * a CLI flag (`--<cadence>`) and a crafted value would otherwise become an arbitrary flag token.
 * @param {unknown} raw
 * @returns {"daily"|"weekly"}
 */
export function validateCadence(raw) {
  if (raw === "daily" || raw === "weekly") return raw;
  const e = new Error("invalid cadence: expected 'daily' or 'weekly'");
  e.statusCode = 400;
  throw e;
}

/**
 * Validate the `window` query param (telemetry). Absent (null/undefined/"") → null, meaning
 * "omit --window" so the CLI applies its own 14-day default. Otherwise must be an integer >= 1.
 * Throws a tagged 400 (blocks e.g. `?window=--all` flag injection; the CLI also fails closed,
 * but we don't rely on it).
 * @param {unknown} raw
 * @returns {number|null}
 */
export function validateWindow(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    const e = new Error("invalid window: expected a positive integer (days)");
    e.statusCode = 400;
    throw e;
  }
  return n;
}

/**
 * Run `aios loop <args> --repo <repo>` and resolve { exitCode, stdout, stderr, err } WITHOUT
 * rejecting on a non-zero exit (see the module header). `execFile` reports a numeric `err.code`
 * for a process exit code and a string code (e.g. "ENOENT") for a spawn failure — that
 * distinction is how the caller tells a business exit from a real failure.
 * @param {string} repo absolute workspace path
 * @param {string[]} args e.g. ["daily", "--json", "--no-record"]
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, err:Error|null}>}
 */
export function runLoopCli(repo, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [AIOS_CLI, "loop", ...args, "--repo", repo],
      { cwd: repo, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const exitCode = err && typeof err.code === "number" ? err.code : 0;
        resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "", err: err ?? null });
      }
    );
  });
}

/**
 * Reshape `aios loop weekly --json` into the GUI contract. The CLI payload is deliberately
 * audience-safe: `{ runStamp, cadence, briefPath, audiences[] }` with the owner brief written to
 * `.aios/loop/closeouts/<stamp>/brief.md` and actions to `next-week-actions.json` — never inline.
 * Surfacing the brief in the GUI is correct: the server binds 127.0.0.1 and is token-gated to the
 * single owner (the same trust boundary as the CLI owner terminal).
 *
 * Fails closed: throws when the brief path is absent (e.g. a --dry-run wrote nothing) or missing
 * on disk — the panel must never render a half-populated closeout.
 * @param {string} stdout raw stdout of `aios loop weekly --json`
 * @param {string} repoDir absolute workspace path (to resolve the workspace-relative briefPath)
 * @returns {object} WeeklyCloseoutResponse (minus cliExitCode, attached by the route)
 */
export function buildWeeklyCloseoutPayload(stdout, repoDir) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error("loop weekly: --json produced unparseable output");
  }
  if (!data || typeof data !== "object") {
    throw new Error("loop weekly: unexpected --json payload");
  }
  const { runStamp, briefPath, audiences } = data;
  if (!briefPath) {
    throw new Error("loop weekly: no brief written (dry-run or failed run) — nothing to show");
  }
  const briefAbs = path.resolve(repoDir, briefPath);
  if (!existsSync(briefAbs)) {
    throw new Error(`loop weekly: brief not found at ${briefPath}`);
  }
  const briefMarkdown = readFileSync(briefAbs, "utf8");

  // next-week-actions.json sits beside brief.md; best-effort (the brief is the primary artifact).
  let ownerNextWeekActions = [];
  try {
    const actionsAbs = path.join(path.dirname(briefAbs), "next-week-actions.json");
    if (existsSync(actionsAbs)) {
      const parsed = JSON.parse(readFileSync(actionsAbs, "utf8"));
      if (Array.isArray(parsed)) ownerNextWeekActions = parsed;
    }
  } catch {
    ownerNextWeekActions = [];
  }

  return {
    runStamp: runStamp ?? null,
    cadence: "weekly",
    briefMarkdown,
    ownerNextWeekActions,
    audiences: Array.isArray(audiences)
      ? audiences.map((a) => ({
          audience: a?.audience ?? "",
          status: a?.status ?? "",
          shippable: !!a?.shippable,
          digestPath: a?.digestPath ?? null,
          unshippablePath: a?.unshippablePath ?? null,
        }))
      : [],
  };
}

/**
 * Turn a runLoopCli result into a pure { status, json } HTTP pair (no `res` coupling, so it is
 * unit-testable). `reshape(stdout)` maps stdout → payload; omit it for pass-through routes
 * (defaults to JSON.parse). A non-zero business exit is attached as `cliExitCode` on a 200.
 * @param {{exitCode:number, stdout:string, stderr:string, err:Error|null}} cli
 * @param {(stdout:string)=>object} [reshape]
 * @returns {{status:number, json:object}}
 */
export function loopResponse(cli, reshape) {
  // A spawn failure has a NON-numeric err.code (e.g. "ENOENT"); a maxBuffer overflow has no
  // usable stdout. Either way there is nothing to parse → hard 500.
  if (cli.err && typeof cli.err.code !== "number") {
    return { status: 500, json: { error: cli.err.message || "loop CLI failed to start" } };
  }
  const out = (cli.stdout || "").trim();
  if (!out) {
    return {
      status: 500,
      json: {
        error: (cli.stderr || "").trim() || `loop CLI exited ${cli.exitCode} with no output`,
      },
    };
  }
  let payload;
  try {
    payload = reshape ? reshape(cli.stdout) : JSON.parse(cli.stdout);
  } catch (e) {
    return { status: 500, json: { error: e.message } };
  }
  if (cli.exitCode) payload = { ...payload, cliExitCode: cli.exitCode };
  return { status: 200, json: payload };
}
