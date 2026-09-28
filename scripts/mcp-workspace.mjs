// The former cwd-based collector is unavailable until profile-bounded collection is installed.
import { ProfileError } from "./cli/connection-profiles.mjs";
export async function workspaceHandler() {
  throw new ProfileError(
    "CAPABILITY_DENIED",
    "Local collection requires explicit profile-bound path enforcement; this operation is not available in this version."
  );
}
