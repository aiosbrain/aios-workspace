/**
 * asks.mjs — pure helpers for the Today console's asks routes.
 *
 * Side-effect-free (no http, no self-booting server) so they can be unit-tested directly,
 * mirroring the loop.mjs / tasks.mjs / maturity.mjs convention. `index.mjs` wires them into
 * `POST /api/asks/resolve` and `GET /api/asks/show` and does nothing else — the parsing,
 * validation and exit-code policy all live here.
 *
 * Both routes shell out to the SAME `aios asks` CLI the terminal uses (see runAsksCli in
 * loop.mjs), so the append-only store, its writer lock and the audit trail are identical
 * whichever surface acted.
 */

import { validateAskId } from "./loop.mjs";

/**
 * Parse + validate the `POST /api/asks/resolve` body into a list of ask ids.
 *
 * Accepts `{ id }` or `{ ids: [...] }`. Every id is validated by `validateAskId` because the
 * values are spliced into argv — a flag-shaped id must never reach the CLI. Throws a tagged
 * 400 (never coerces, never silently drops an invalid entry).
 * @param {string} raw request body
 * @returns {string[]} validated ids (at least one)
 */
export function parseAskIds(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { statusCode: 400 });
  }
  const candidates = Array.isArray(parsed.ids) ? parsed.ids : [parsed.id];
  const present = candidates.filter((v) => v != null);
  if (!present.length) {
    throw Object.assign(new Error("id is required"), { statusCode: 400 });
  }
  return present.map(validateAskId);
}

/**
 * Shape the response for `POST /api/asks/resolve`.
 *
 * A non-zero CLI exit is a genuine failure here (unlike the loop's lenient business exit codes):
 * the ask was NOT closed, so reporting success would leave the operator believing a blocker was
 * cleared when it is still open. stderr is surfaced because this route's failures are actionable
 * ("no such ask"), but falls back to a generic message so an empty stderr never yields a blank.
 * @param {{exitCode:number, stdout:string, stderr:string}} cli
 * @param {string[]} ids
 */
export function resolveAsksResponse(cli, ids) {
  if (cli.exitCode !== 0) {
    return {
      status: 500,
      json: { ok: false, error: cli.stderr.trim() || "asks resolve failed" },
    };
  }
  return { status: 200, json: { ok: true, resolved: ids } };
}

/**
 * Shape the response for `GET /api/asks/show`.
 *
 * A well-formed id that does not resolve is a 404 — never a 200 carrying an empty shell, which
 * would render as a detail pane that silently says nothing. Unparseable stdout is a 500: the
 * CLI is the contract, and a broken contract is not a missing ask.
 * @param {{exitCode:number, stdout:string, stderr:string}} cli
 */
export function askDetailResponse(cli) {
  if (cli.exitCode !== 0) {
    return { status: 404, json: { error: cli.stderr.trim() || "ask not found" } };
  }
  try {
    return { status: 200, json: JSON.parse(cli.stdout) };
  } catch {
    return { status: 500, json: { error: "could not parse ask detail" } };
  }
}
