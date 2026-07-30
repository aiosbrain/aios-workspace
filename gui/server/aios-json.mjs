/**
 * aios-json.mjs — spawn an `aios` machine surface and parse its JSON result (AIO-600).
 *
 * The GUI's seam to the toolkit for the connector + catalog routes: instead of
 * deep-importing scripts/**, the server shells out to the hidden JSON commands
 * (`aios connector …`, `aios catalog --json`) and forwards their `{ status, body }`
 * result to the browser. The CLI owns the HTTP-shaped status mapping (422/502/503),
 * so every consumer agrees on it.
 *
 * Secrets never travel through argv (visible in `ps`): pass them via `stdin` and the
 * command's `--secrets-stdin` flag. Stdout may carry stray non-JSON lines from
 * transitive tooling, so only the LAST line is parsed (same convention as the
 * `aios whoami` route).
 */
import { execFile } from "node:child_process";

/**
 * @param {object} o
 * @param {string} o.cliPath absolute path to scripts/aios.mjs (index.mjs's AIOS_CLI)
 * @param {string} o.repo    workspace path, forwarded as `--repo`
 * @returns {(args: string[], opts?: { stdin?: string, raw?: boolean }) =>
 *   Promise<{status:number, body:object}>}
 */
export function createAiosJson({ cliPath, repo }) {
  /**
   * `raw: true` is for surfaces that print a bare JSON document instead of the
   * `{ status, body }` envelope (e.g. `aios catalog --json`): the parsed document
   * becomes `body` with status 200.
   */
  return function aiosJson(args, { stdin, raw = false } = {}) {
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [cliPath, ...args, "--repo", repo],
        { cwd: repo, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          try {
            const parsed = JSON.parse(
              String(stdout || "")
                .trim()
                .split("\n")
                .pop()
            );
            if (raw) {
              if (err || typeof parsed !== "object" || parsed === null) throw new Error("failed");
              return resolve({ status: 200, body: parsed });
            }
            if (typeof parsed?.status !== "number" || typeof parsed?.body !== "object") {
              throw new Error("malformed CLI result");
            }
            resolve(parsed);
          } catch {
            // Spawn failure or non-JSON output — never leak stdout (it could carry
            // anything); the CLI's own failures arrive as parsed 4xx/5xx results.
            resolve({
              status: 500,
              body: {
                ok: false,
                error: err?.code === "ENOENT" ? "aios CLI not found" : "aios CLI failed",
              },
            });
          }
        }
      );
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    });
  };
}
