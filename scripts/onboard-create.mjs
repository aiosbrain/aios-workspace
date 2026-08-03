import { spawnSync } from "node:child_process";

export const TEAM_BRAIN_DEPLOY_URL = "https://aiosbrain.dev/deploy/team-brain/";
export const TEAM_BRAIN_GUIDE_URL = "https://aiosbrain.dev/guides/team-brain/";
export const RAILWAY_PLANS_URL = "https://railway.com/workspace/plans";

export function openExternalUrl(url, { exec = spawnSync, platform = process.platform } = {}) {
  const command =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const result = exec(command[0], command[1], { stdio: "ignore" });
  return (result.status ?? 1) === 0;
}

/** Human-gated external deployment handoff. Local configuration remains untouched until Join. */
export async function runCreateFlow({ confirm, clack, openExternal = openExternalUrl }) {
  clack.log.info(
    `Prerequisite: the Railway workspace you select must have an active plan. Plans: ${RAILWAY_PLANS_URL}`
  );
  clack.log.info(
    "Create deploys an AIOS Team Brain and Postgres in your Railway account. Railway will show the services, variables, and cost before deployment."
  );
  clack.log.info(`Deploy page: ${TEAM_BRAIN_DEPLOY_URL}`);
  if (
    !(await confirm(
      `Active Railway plan confirmed. Open the deploy page: ${TEAM_BRAIN_DEPLOY_URL}?`
    ))
  ) {
    clack.log.warn("Deployment skipped; this workspace was not changed.");
    return { resumeJoin: false, status: "declined" };
  }

  const opened = openExternal(TEAM_BRAIN_DEPLOY_URL);
  if (opened) clack.log.success("Opened the Railway deploy page in your browser.");
  else clack.log.warn(`Could not open a browser automatically. Copy: ${TEAM_BRAIN_DEPLOY_URL}`);

  const ready = await confirm(
    "Has Railway finished deploying, and have you signed in and generated your API key?"
  );
  if (!ready) {
    clack.log.info(
      `Finish deployment, then rerun \`aios onboard\` and choose Join. Self-host fallback: ${TEAM_BRAIN_GUIDE_URL}`
    );
    return { resumeJoin: false, status: "awaiting-deployment" };
  }
  return { resumeJoin: true, status: "ready" };
}
