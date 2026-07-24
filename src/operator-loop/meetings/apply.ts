import { readFileSync, statSync } from "node:fs";
import type { ApplyPendingTranscriptStageOptions, ApplyResult, LiveLogs } from "./contracts.js";
import { TranscriptReviewError } from "./errors.js";
import { withTranscriptApplyLock } from "./lock.js";
import { decisionKey, insertRows, renderDecisionRow, renderTaskRow, taskKey } from "./markdown.js";
import type { TranscriptReviewStageV2 } from "./models.js";
import { computeReviewDigest } from "./review-digest.js";
import { parseTranscriptReviewStage } from "./stage-schema.js";
import { atomicReplace, replaceStage } from "./stage-store.js";
import { readLiveLogs, resolveStageFile, timestamp } from "./workspace.js";

function pendingStage(
  pathname: string
): Extract<TranscriptReviewStageV2, { readonly status: "pending_review" }> {
  const stage = parseTranscriptReviewStage(readFileSync(pathname, "utf8"));
  if (stage.status !== "pending_review") {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `low-level apply accepts pending v2 stages only; received ${stage.status}`
    );
  }
  if (computeReviewDigest(stage) !== stage.reviewDigest) {
    throw new TranscriptReviewError("integrity", 2, "reviewDigest integrity check failed");
  }
  return stage;
}

type ApplyPlan = {
  readonly decisionContent: string;
  readonly taskContent: string;
  readonly decisionsAdded: number;
  readonly tasksAdded: number;
  readonly decisionChanged: boolean;
  readonly taskChanged: boolean;
};

function planApply(stage: TranscriptReviewStageV2, logs: LiveLogs): ApplyPlan {
  const decisionKeys = new Set(logs.decisions.keys);
  const taskKeys = new Set(logs.tasks.keys);
  let decisionNumber = logs.decisions.nextNumber;
  let taskNumber = logs.tasks.nextNumber;
  const decisionRows: string[] = [];
  const taskRows: string[] = [];
  for (const decision of stage.decisions) {
    const key = decisionKey(decision);
    if (key.length === 0 || decisionKeys.has(key)) continue;
    decisionKeys.add(key);
    decisionRows.push(renderDecisionRow(decision, decisionNumber));
    decisionNumber += 1;
  }
  for (const task of stage.tasks) {
    const key = taskKey(task);
    if (key.length === 1 || taskKeys.has(key)) continue;
    taskKeys.add(key);
    taskRows.push(renderTaskRow(task, taskNumber));
    taskNumber += 1;
  }
  return {
    decisionContent: insertRows({
      content: logs.decisions.content,
      kind: "decisions",
      filePath: logs.decisions.path,
      rows: decisionRows.join(""),
    }),
    taskContent: insertRows({
      content: logs.tasks.content,
      kind: "tasks",
      filePath: logs.tasks.path,
      rows: taskRows.join(""),
    }),
    decisionsAdded: decisionRows.length,
    tasksAdded: taskRows.length,
    decisionChanged: decisionRows.length > 0,
    taskChanged: taskRows.length > 0,
  };
}

function replaceLog(pathname: string, content: string): void {
  atomicReplace(pathname, content, statSync(pathname).mode & 0o777);
}

export function applyPendingTranscriptStage(
  options: ApplyPendingTranscriptStageOptions
): ApplyResult {
  const stagePath = resolveStageFile(options.root, options.stagePath);
  pendingStage(stagePath);
  readLiveLogs(options.root);
  return withTranscriptApplyLock(options.root, () => {
    const stage = pendingStage(stagePath);
    const logs = readLiveLogs(options.root);
    const plan = planApply(stage, logs);
    if (plan.decisionChanged) {
      options.beforeLogReplace?.("decisions");
      replaceLog(logs.decisions.path, plan.decisionContent);
    }
    if (plan.taskChanged) {
      options.beforeLogReplace?.("tasks");
      replaceLog(logs.tasks.path, plan.taskContent);
    }
    const approved = {
      ...stage,
      status: "approved" as const,
      apply: {
        approvedAt: timestamp(options.now),
        decisionsAdded: plan.decisionsAdded,
        tasksAdded: plan.tasksAdded,
        decisionLogChanged: plan.decisionChanged,
        taskLogChanged: plan.taskChanged,
      },
    };
    replaceStage(stagePath, approved);
    return {
      stagePath,
      stage: approved,
      decisionsAdded: plan.decisionsAdded,
      tasksAdded: plan.tasksAdded,
    };
  });
}
