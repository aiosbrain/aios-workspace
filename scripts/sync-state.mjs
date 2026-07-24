import { createHash } from "node:crypto";

import { DECISION_SYNC_VERSION } from "./workspace-parse.mjs";

export function isSyncStateCurrent(previous, kind, hash) {
  return (
    previous.sha === hash &&
    (kind !== "decision" || previous.decision_sync_version === DECISION_SYNC_VERSION)
  );
}

export function createSyncedItemState(item, response) {
  return {
    sha: item.hash,
    remote_id: response.id || null,
    pushed_at: new Date().toISOString(),
    ...(item.kind === "decision" ? { decision_sync_version: DECISION_SYNC_VERSION } : {}),
  };
}

export function contentShaForPush(item) {
  if (item.kind !== "decision") return item.hash;
  const sharedContent = JSON.stringify({
    decision_sync_version: DECISION_SYNC_VERSION,
    access: item.tier,
    frontmatter: item.frontmatter || {},
    body: item.body,
    rows: item.rows || [],
  });
  return createHash("sha256").update(sharedContent).digest("hex");
}
