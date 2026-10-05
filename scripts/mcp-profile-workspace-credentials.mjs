// Toolkit-only adapter. Never include the optional dotenvx dependency in standalone MCP.
import { decryptDotenvKey, loadDotEnv } from "../packages/foundation/src/brain-config.mjs";
import { rootIdentity } from "./mcp-profile-binding.mjs";
export function workspaceProfileCredential(root, key) {
  rootIdentity(root);
  return loadDotEnv(root)[key] || decryptDotenvKey(root, key);
}
