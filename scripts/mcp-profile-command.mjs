import {
  registerProfile,
  revokeProfile,
  recoverProfiles,
  migrateProfiles,
} from "./mcp-profile-setup.mjs";
import { inspectProfile } from "./mcp-profile-binding.mjs";
import { GRANTS, ProfileError, emptyGrants } from "./cli/connection-profiles.mjs";
import { AiosError } from "./cli/errors.mjs";
import { workspaceProfileCredential } from "./mcp-profile-workspace-credentials.mjs";
export async function cmdMcpProfile(args, options = {}) {
  const [action, ...rest] = args;
  const input = { grants: emptyGrants(), readRoots: [], draftRoots: [] };
  const opts = { workspaceCredential: workspaceProfileCredential, ...options };
  const flags = {
    "--profile": "id",
    "--mode": "mode",
    "--brain-origin": "brainOrigin",
    "--team": "teamId",
    "--project-id": "projectId",
    "--credential-source": "credentialSource",
    "--reference": "reference",
    "--root": "root",
  };
  let revokeGrants = GRANTS;
  try {
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === "--json") continue;
      if (flag === "--dry-run") {
        opts.dryRun = true;
        continue;
      }
      if (flag === "--read-only") {
        opts.readOnly = true;
        continue;
      }
      const value = rest[++i];
      if (!value || value.startsWith("--")) throw new Error();
      if (flags[flag]) input[flags[flag]] = value;
      else if (flag === "--grant") {
        const selected = value.split(",");
        if (selected.some((key) => !GRANTS.includes(key))) throw new Error();
        for (const key of selected) input.grants[key] = true;
      } else if (flag === "--revoke") {
        revokeGrants = value.split(",");
      } else if (flag === "--read-root") input.readRoots.push(value);
      else if (flag === "--draft-root") input.draftRoots.push(value);
      else throw new Error();
    }
    let result;
    if (action === "register") result = await registerProfile(input, opts);
    else if (action === "revoke" && input.id)
      result = await revokeProfile(input.id, revokeGrants, opts);
    else if (action === "status" && input.id) result = await inspectProfile(input.id, opts);
    else if (action === "migrate") result = await migrateProfiles(opts);
    else if (action === "recover" && !opts.dryRun) result = await recoverProfiles(opts);
    else throw new Error();
    (options.output || console.log)(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof ProfileError)
      throw new AiosError(
        "AIOS_E_CONFIG_INVALID",
        `${error.code}: ${error.message}`,
        "Run aios mcp profile status --profile <id>; repeat explicit setup or recovery."
      );
    throw new AiosError(
      "AIOS_E_USAGE",
      "Invalid or unavailable profile operation.",
      "Use aios mcp profile register|status|revoke|migrate|recover with explicit profile, destination, credential reference and optional grants."
    );
  }
}

/** Guided setup is explicit; no field or grant is selected from the current directory. */
export async function chooseProfileSetup(options = {}) {
  const { clack: ui } = await import("./onboard-ui.mjs");
  const mode = await ui.select({
    message: "Choose the connection",
    options: [
      { value: "brain-only", label: "Team Brain" },
      { value: "workspace", label: "Team Brain + workspace" },
    ],
  });
  if (ui.isCancel(mode)) return null;
  const input = { mode, grants: emptyGrants(), readRoots: [], draftRoots: [] };
  for (const [key, message] of [
    ["id", "Profile name"],
    ["brainOrigin", "Brain HTTPS origin"],
    ["teamId", "Team ID"],
    ["projectId", "Project ID"],
    ["credentialSource", "Credential source name"],
    ["reference", "Credential reference (env:VARIABLE or keychain:service)"],
    ...(mode === "workspace"
      ? [
          ["root", "Absolute workspace folder"],
          ["readRoots", "Allowed reading folders, comma-separated (relative to workspace)"],
          ["draftRoots", "Allowed drafting folders, comma-separated (relative to workspace)"],
        ]
      : []),
  ]) {
    const answer = await ui.text({ message });
    if (ui.isCancel(answer)) return null;
    input[key] = key.endsWith("Roots")
      ? String(answer)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : String(answer);
  }
  const grants = await ui.multiselect({
    message: "Enable permissions explicitly",
    required: false,
    initialValues: [],
    options: (mode === "workspace" ? GRANTS : ["brainActions"]).map((value) => ({
      value,
      label: value,
    })),
  });
  if (ui.isCancel(grants)) return null;
  for (const key of grants) input.grants[key] = true;
  const setupOptions = { workspaceCredential: workspaceProfileCredential, ...options };
  const preview = await registerProfile(input, { ...setupOptions, dryRun: true });
  const confirmed = await ui.confirm({
    message: `Save ${preview.profile.id}: ${preview.profile.brainOrigin} / ${preview.profile.teamId} / ${preview.profile.projectId}${preview.profile.root ? ` / ${preview.profile.root}` : ""}; permissions: ${grants.join(", ") || "read-only Brain access"}?`,
    initialValue: false,
  });
  if (ui.isCancel(confirmed) || !confirmed) return null;
  if (!options.dryRun) await registerProfile(input, setupOptions);
  return { profileId: input.id, preview };
}
