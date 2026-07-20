import path from "node:path";
import { existsSync } from "node:fs";
import { c } from "./cli-common.mjs";
import {
  backupConfig,
  ensureGitignore,
  getDescriptor,
  listConnectors,
  vaultSet,
} from "./connector.mjs";
import { createBrainClient } from "./brain-client.mjs";
import { normalizeBrainOrigin } from "./brain-origin.mjs";
import { persistBrainOrigin } from "./onboard-config.mjs";
import { formatInspection, inspectOnboarding } from "./onboard-inspect.mjs";
import { cmdUpdate } from "./update.mjs";

const TEAM_BRAIN_PSEUDO_ID = "__team_brain__";

/**
 * The toolkit-upgrade subsection of onboarding — extracted so its sequencing can be unit
 * tested with a stubbed `cmdUpdate` (via the `cmdUpdate` option), without shelling real
 * git per assertion. `cmdUpdate` never throws its own expected-failure type (`UpdateError`
 * — it's always caught internally and converted into a returned result), but code it calls
 * into can still throw something genuinely unexpected, so both read-only calls are guarded
 * regardless.
 *
 * `--check` and `--preview` are read-only: `--preview` implies `--no-pull`, so neither
 * mutates the toolkit checkout, spawns a child, or exits. Their structured results —
 * `.applyAllowed`/`.reasons`, not console text — decide whether to offer the apply
 * confirmation at all: a conflicted, dirty, uninspectable, or diverged toolkit is skipped
 * with one clear warning rather than offered and then having apply refuse it after the
 * user already confirmed.
 */
export async function runToolkitUpgrade(
  repo,
  cfg,
  inspection,
  { confirm, clack, cmdUpdate: cmdUpdateFn = cmdUpdate }
) {
  if (!inspection.toolkit) return;
  if (inspection.toolkit.git.dirty || inspection.toolkit.relation === "diverged") {
    clack.log.warn(
      `Toolkit checkout ${inspection.toolkit.path} is ${inspection.toolkit.git.dirty ? "dirty" : "not fast-forward compatible"}; it will not be modified or used to upgrade this workspace.`
    );
    return;
  }

  let checkResult, previewResult;
  try {
    checkResult = await cmdUpdateFn(repo, cfg, ["--check", "--from", inspection.toolkit.path]);
    previewResult = await cmdUpdateFn(repo, cfg, ["--preview", "--from", inspection.toolkit.path]);
  } catch (error) {
    clack.log.warn(
      `Toolkit upgrade check failed unexpectedly (${error.message}) — skipping for now, run \`aios update\` later.`
    );
    return;
  }

  const blocked = checkResult?.applyAllowed === false || previewResult?.applyAllowed === false;
  if (blocked) {
    const reasons = [
      ...new Set([...(checkResult?.reasons || []), ...(previewResult?.reasons || [])]),
    ];
    clack.log.warn(
      `Toolkit isn't safe to update right now${reasons.length ? ` (${reasons.join("; ")})` : ""} — skipping the upgrade offer. Resolve it, then run \`aios update\` later.`
    );
    return;
  }

  if (await confirm("Apply the previewed managed-file update through the three-way merge?")) {
    let applyResult;
    try {
      applyResult = await cmdUpdateFn(repo, cfg, ["--from", inspection.toolkit.path]);
    } catch (error) {
      clack.log.warn(
        `Managed-file update failed unexpectedly (${error.message}) — finish it with \`aios update\` after onboarding.`
      );
      return;
    }
    if (applyResult.exitStatus) {
      clack.log.warn(
        "Managed-file update did not complete cleanly — finish it with `aios update` after onboarding."
      );
    }
  }
}

/** Guided onboarding, isolated from the main CLI so basic command loading stays small and dependency-free. */
export async function cmdOnboard(repo, cfg, args = [], { connectFlow, nextAction }) {
  if (args.includes("--inspect")) {
    const report = inspectOnboarding({ startDir: process.cwd(), repo });
    console.log(
      args.includes("--json") ? JSON.stringify(report, null, 2) : formatInspection(report)
    );
    return;
  }
  if (args.includes("--print-next-only")) {
    console.log(nextAction(repo));
    return;
  }

  const inspection = inspectOnboarding({ startDir: process.cwd(), repo });
  const workspace = inspection.workspace_candidates.find(
    (candidate) => path.resolve(candidate.path) === path.resolve(repo)
  );
  if (!existsSync(path.join(repo, "aios.yaml"))) {
    console.log(formatInspection(inspection));
    console.log(
      "\nYour best next step: scaffold a Personal workspace, or open an existing workspace and rerun `aios onboard`."
    );
    return;
  }

  const connectors = listConnectors(repo);
  if (!process.stdin.isTTY) {
    console.log(c.blue("AIOS onboarding"));
    console.log("  Run these from an interactive terminal:");
    console.log(c.dim("    aios onboard              # guided setup (brain + tools)"));
    console.log(c.dim("    aios connect <id>         # any one tool"));
    console.log(
      c.dim(
        "  Brain: run interactively to confirm the exact origin, then provide AIOS_API_KEY. team_id is optional."
      )
    );
    return;
  }

  const {
    pickConnectors,
    pickOnboardingPath,
    askSecret,
    askText,
    askViaClack,
    confirm,
    reportValidation,
    clack,
  } = await import("./onboard-ui.mjs");

  clack.intro("AIOS onboarding");
  clack.log.info(
    workspace
      ? `Found ${workspace.scaffold.complete ? "an existing" : "a partial"} ${workspace.context || "personal"} workspace at ${workspace.path}.`
      : `Using workspace ${repo}.`
  );

  if (workspace && !workspace.scaffold.complete) {
    clack.log.warn(
      `This workspace is partial (missing: ${workspace.scaffold.missing.join(", ")}). Repair it before connecting or upgrading; no files were changed.`
    );
    clack.outro(
      "Your best next step: restore the missing scaffold files, then rerun `aios onboard --inspect --json`."
    );
    return;
  }
  if (workspace?.git.dirty) {
    clack.log.warn("This workspace has uncommitted changes. Onboarding will leave it untouched.");
    clack.outro("Your best next step: commit or stash your changes, then rerun `aios onboard`.");
    return;
  }

  const onboardingPath = await pickOnboardingPath(
    cfg.brain_url && cfg.api_key ? "join" : "personal"
  );
  if (onboardingPath === "create") {
    clack.log.info(
      "Create uses the existing guided self-host path; this release does not create setup bundles or new auth endpoints."
    );
    clack.outro(
      "Your best next step: open https://aiosbrain.dev/guides/team-brain/ and review the prerequisites."
    );
    return;
  }

  await runToolkitUpgrade(repo, cfg, inspection, { confirm, clack });

  const backedUp = backupConfig(repo);
  if (backedUp.length) clack.log.info(`Backed up existing config first: ${backedUp.join(", ")}`);

  let safeConfiguredOrigin = null;
  if (cfg.brain_url) {
    try {
      safeConfiguredOrigin = normalizeBrainOrigin(cfg.brain_url);
    } catch (error) {
      clack.log.warn(`Configured Brain URL is unsafe: ${error.message}`);
    }
  }
  const teamBrainOption = {
    id: TEAM_BRAIN_PSEUDO_ID,
    name: "AIOS Team Brain",
    summary: "Powers push/pull/status/query — get your key from your dashboard's profile page",
    status: cfg.api_key && safeConfiguredOrigin ? "wired" : "available",
  };
  const selection = await pickConnectors(connectors, {
    pinned: onboardingPath === "join" ? teamBrainOption : null,
  });

  let brainIdentity = null;
  if (selection.includes(TEAM_BRAIN_PSEUDO_ID)) {
    let origin = safeConfiguredOrigin;
    let enteredOrigin = false;
    if (!origin) {
      const entered = await askText(
        "Team Brain URL (an origin, /t/<team> page, or known /api/v1 endpoint)",
        "https://brain.example.com"
      );
      try {
        origin = normalizeBrainOrigin(entered);
        enteredOrigin = true;
      } catch (error) {
        clack.log.error(error.message);
      }
    }

    if (origin && enteredOrigin && origin.startsWith("https://")) {
      clack.log.warn(`Remote Brain origin to trust and save: ${origin}`);
      if (!(await confirm(`Save this exact Brain origin: ${origin}?`))) {
        clack.log.warn("Brain connection skipped; the origin was not saved.");
        origin = null;
      }
    }

    let key = cfg.api_key;
    let enteredKey = false;
    if (origin && !key) {
      key = await askSecret("AIOS_API_KEY", {
        instructions: "Sign in to your Team Brain dashboard → your profile → Generate my API key.",
      });
      enteredKey = !!key;
    }

    if (origin && key) {
      try {
        brainIdentity = await createBrainClient({
          brain_url: origin,
          api_key: key,
          team_id: cfg.team_id,
        }).fetchJson("GET", "/me");
        if (enteredOrigin) persistBrainOrigin(repo, origin);
        if (enteredKey) {
          vaultSet(repo, "AIOS_API_KEY", key);
          ensureGitignore(repo);
        }
        reportValidation([
          { name: "Brain origin", ok: true, detail: origin },
          {
            name: "Authenticated identity",
            ok: true,
            detail: `${brainIdentity.actor} · ${brainIdentity.role} · ${brainIdentity.tier}`,
          },
          ...(enteredKey
            ? [{ name: "AIOS_API_KEY", ok: true, detail: "encrypted into .env (dotenvx)" }]
            : []),
        ]);
      } catch (error) {
        reportValidation([{ name: "Team Brain", ok: false, detail: error.message }]);
      }
    } else if (!key && origin) {
      clack.log.warn("AIOS_API_KEY: no key entered — skipped.");
    }
  }

  for (const id of selection.filter((value) => value !== TEAM_BRAIN_PSEUDO_ID)) {
    const connector = connectors.find((candidate) => candidate.id === id);
    if (connector?.status === "wired") continue;
    try {
      await connectFlow(repo, getDescriptor(repo, id), { ask: askViaClack });
    } catch (error) {
      clack.log.error(`${connector?.name || id}: ${error.message}`);
    }
  }

  const wantsProfile = await clack.confirm({
    message: "Set up your profile now — name, role, working style?",
  });
  if (!clack.isCancel(wantsProfile) && wantsProfile) {
    clack.log.step('Say this once your GUI/CLI session starts: "set me up"');
    clack.log.message("(interviews you, or drafts from a link — always confirms before writing)");
  }

  clack.log.info(
    `What AIOS now understands: this ${workspace?.context || "personal"} workspace${brainIdentity ? ` and the identity ${brainIdentity.actor}` : " in standalone mode"}.`
  );
  clack.log.info("What stays private: admin/private and untagged files stay on this machine.");
  clack.log.info(
    "What can be shared: only explicitly tiered team/external content, after you preview and choose to push it."
  );
  clack.outro(`Your best next step: ${nextAction(repo)}`);
}
