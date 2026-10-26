import { execFileSync } from "node:child_process";
import { validReference, deny } from "./mcp-profile-schema.mjs";

export function parseCredentialReference(reference) {
  if (!validReference(reference))
    deny(
      "PROFILE_NOT_FOUND",
      "The selected credential reference is missing or invalid. Repeat explicit profile setup."
    );
  const split = reference.indexOf(":");
  return { kind: reference.slice(0, split), locator: reference.slice(split + 1) };
}
export function resolveCredentialReference(
  reference,
  { env = process.env, platform = process.platform, keychain, workspaceCredential } = {}
) {
  const parsed = parseCredentialReference(reference);
  let value;
  if (parsed.kind === "env") {
    value = Object.hasOwn(env, parsed.locator)
      ? env[parsed.locator]
      : workspaceCredential?.(parsed.locator);
  } else if (keychain) value = keychain(parsed.locator);
  else if (platform === "darwin") {
    try {
      value = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", parsed.locator, "-w"],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }
      ).replace(/\n$/, "");
    } catch {
      /* Render a fixed diagnostic below. */
    }
  }
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\r\n]/.test(value) ||
    value.startsWith("encrypted:")
  )
    deny(
      "AUTH_REVOKED",
      "The selected credential reference is unavailable. Make it available to the host and retry."
    );
  return { value, sourceClass: parsed.kind };
}
