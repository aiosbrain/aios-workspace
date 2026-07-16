// Canonical dependency-free reply-claim recovery policy, shared by the compiled store and hook.
// CommonJS keeps it synchronously callable inside the store lock and directly loadable by the hook.
"use strict";

const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      return fields[19] ? `linux-start:${fields[19]}` : null;
    }
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return started ? `${process.platform}-start:${started}` : null;
  } catch {
    return null;
  }
}

function pidLiveness(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return "unknown";
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code === "EPERM") return "alive";
    return "unknown";
  }
}

/** Returns `recover` only on dead/reused-owner evidence or after an uncertain bounded lease. */
function claimRecoveryDecision(claim, nowMs, deps = {}) {
  if (!claim || !Number.isFinite(nowMs)) return "busy";
  const identify = deps.processIdentity || processIdentity;
  const liveness = pidLiveness(claim.ownerPid, deps.kill || process.kill);
  if (liveness === "dead") return "recover";
  if (liveness === "alive" && claim.ownerPid && claim.ownerIdentity) {
    const currentIdentity = identify(claim.ownerPid);
    if (currentIdentity) return currentIdentity === claim.ownerIdentity ? "busy" : "recover";
    // EPERM/live but identity is unavailable: fail closed through the full lease, then bounded recovery.
  }
  const expiresMs = Date.parse(claim.expiresAt || "");
  return Number.isFinite(expiresMs) && nowMs >= expiresMs ? "recover" : "busy";
}

module.exports = { claimRecoveryDecision, pidLiveness, processIdentity };
