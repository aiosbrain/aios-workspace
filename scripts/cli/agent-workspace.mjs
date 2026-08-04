import { existsSync } from "node:fs";
import path from "node:path";

// Product-repository agents may need their stamped personal workspace's account
// configuration. This is explicit only: never infer it from a nearby checkout.
export function findAgentWorkspace(die, env = process.env) {
  const configured = env.AIOS_AGENT_WORKSPACE?.trim();
  if (!configured) return null;
  const repo = path.resolve(configured);
  if (!existsSync(path.join(repo, "aios.yaml"))) {
    die(`AIOS_AGENT_WORKSPACE must point to a stamped workspace with aios.yaml; got ${repo}`);
  }
  return repo;
}
