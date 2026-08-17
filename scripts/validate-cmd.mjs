/**
 * validate-cmd.mjs — `aios validate` (AIO-864 follow-up).
 *
 * Runs the toolkit's OGR validators against a workspace. It exists because
 * `validation/validate-all.sh` is a TOOLKIT path, not a workspace one: a scaffolded
 * workspace's `validation/` holds only `secret-patterns.txt`, so the documented
 * `cd ~/Projects/my-ws && validation/validate-all.sh .` cannot work, and on a global
 * npm install the working invocation is
 * `/usr/local/lib/node_modules/@aiosbrain/aios/validation/validate-all.sh <workspace>`
 * — a path no user should have to know. This command resolves it from the module that
 * ships beside it, so the toolkit half of the invocation is never the user's problem.
 *
 * The workspace half stays explicit: the target is the resolved workspace root (or an
 * argument), and it is printed, because pointing the validators at the toolkit checkout
 * instead of a workspace is the exact confusion this command is fixing.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The toolkit checkout that owns this file: scripts/validate-cmd.mjs → <toolkit>. */
const TOOLKIT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage: aios validate [path] [--critical|--quick]

Runs the toolkit's OGR validators against a workspace.

  path          workspace to validate (default: the resolved workspace root)
  --critical    OGR03 secrets scan only
  --quick       OGR01 folder structure only

Exit 0 when every validator passes, 1 when any fails.`;

/**
 * @param {string} repo  the resolved workspace root (dispatch: resolution "offline")
 * @param {string[]} rest
 * @returns {number} process exit code
 */
export function cmdValidate(repo, rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    console.log(USAGE);
    return 0;
  }

  const modes = rest.filter((a) => a === "--critical" || a === "--quick");
  if (modes.length > 1) {
    console.error("aios validate: --critical and --quick are mutually exclusive");
    return 2;
  }
  const unknown = rest.filter((a) => a.startsWith("-") && !modes.includes(a));
  if (unknown.length) {
    console.error(`aios validate: unknown option ${unknown[0]}\n\n${USAGE}`);
    return 2;
  }

  const positional = rest.filter((a) => !a.startsWith("-"));
  if (positional.length > 1) {
    console.error(`aios validate: expected at most one path, got ${positional.length}`);
    return 2;
  }
  const target = positional[0] ? path.resolve(positional[0]) : repo;

  if (!target || !existsSync(target)) {
    console.error(`aios validate: no such workspace: ${target}`);
    return 2;
  }

  const script = path.join(TOOLKIT, "validation", "validate-all.sh");
  if (!existsSync(script)) {
    // A broken/partial install, not user error — say which install is broken.
    console.error(
      `aios validate: the toolkit at ${TOOLKIT} has no validation/validate-all.sh.\n` +
        `  Reinstall the toolkit (npm i -g @aiosbrain/aios) or point AIOS_TOOLKIT_DIR at a complete checkout.`
    );
    return 2;
  }

  console.log(`aios validate — validators from ${TOOLKIT}`);
  // Run the validator through its own shebang rather than resolving the interpreter name
  // `bash` on PATH — a writable PATH entry would otherwise get to choose the shell that
  // runs the security validators. npm preserves the executable bit, so the direct exec is
  // the normal path; the absolute-path fallback covers a checkout on a noexec mount or one
  // whose mode bits were lost (e.g. copied through a zip).
  let r = spawnSync(script, [target, ...modes], { stdio: "inherit" });
  if (r.error && (r.error.code === "EACCES" || r.error.code === "ENOEXEC")) {
    r = spawnSync("/bin/bash", [script, target, ...modes], { stdio: "inherit" });
  }
  if (r.error) {
    console.error(`aios validate: could not run the validators: ${r.error.message}`);
    return 2;
  }
  // A validator killed by a signal is a failure, not a pass — spawnSync reports status null.
  return r.status ?? 1;
}
