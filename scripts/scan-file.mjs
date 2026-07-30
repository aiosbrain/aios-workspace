/**
 * scan-file.mjs — the shared promote/publish file scan (secret patterns + confidentiality
 * leak-gate), as a small core leaf module.
 *
 * `defaultScanFile` moved here (AIO-594, devtools-cut rehearsal finding F2) from
 * scripts/promote.mjs: the devtools-bound `scripts/spec-publish.mjs` (moving to the
 * aiosbrain/aios-devtools repo) imported it from promote.mjs, which stays core — pulling the
 * whole `aios promote` command module across the repo seam for one helper. Both promote.mjs
 * and spec-publish.mjs now import this leaf instead; promote.mjs re-exports it so its module
 * surface is unchanged. Deliberately depends only on Node builtins plus the core-staying
 * cli-common.mjs secret helpers (the documented single source for the secret-pattern list —
 * duplicating them here would let the scanners diverge), and shells out to the co-located
 * scripts/leak-gate.sh when present.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { loadSecretPatterns, findSecret } from "./cli-common.mjs";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);

/** Default scan: shared secret patterns (in-process) + the confidentiality leak-gate (shelled out). */
export function defaultScanFile(destAbs) {
  const findings = [];
  const content = readFileSync(destAbs, "utf8");
  const secretHit = findSecret(content, loadSecretPatterns());
  if (secretHit) findings.push(`secret pattern matched: ${secretHit}`);

  const leakGate = path.join(SCRIPT_DIR, "leak-gate.sh");
  if (existsSync(leakGate)) {
    try {
      execFileSync(leakGate, [destAbs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const out = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      findings.push(out || "leak-gate: FAILED");
    }
  }
  return { clean: findings.length === 0, findings };
}
