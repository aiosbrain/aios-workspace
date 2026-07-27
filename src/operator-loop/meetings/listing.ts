import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { TranscriptReviewError } from "./errors.js";
import type {
  TranscriptReviewCounts,
  TranscriptStageList,
  TranscriptStageSummary,
} from "./models.js";
import { jsonValue } from "./parse.js";
import {
  parseLegacyTranscriptStageV1,
  parseTranscriptReviewStage,
  stageVersion,
} from "./stage-schema.js";
import { canonicalRoot, STAGING_RELATIVE } from "./workspace.js";

type StageDirectoryReader = (directory: string) => readonly Dirent[];

function readStageDirectory(directory: string): readonly Dirent[] {
  return readdirSync(directory, { withFileTypes: true });
}

function summary(root: string, pathname: string): TranscriptStageSummary {
  const raw = jsonValue(readFileSync(pathname, "utf8"));
  const version = stageVersion(raw);
  if (version === 2) {
    const stage = parseTranscriptReviewStage(raw);
    return {
      path: path.relative(root, pathname),
      version,
      status: stage.status,
      createdAt: stage.createdAt,
      decisions: stage.decisions.length,
      tasks: stage.tasks.length,
      pushState: stage.push.state,
    };
  }
  if (version === 1) {
    const stage = parseLegacyTranscriptStageV1(raw);
    return {
      path: path.relative(root, pathname),
      version,
      status: stage.status,
      createdAt: stage.createdAt,
      decisions: stage.decisions.length,
      tasks: stage.tasks.length,
    };
  }
  throw new TranscriptReviewError("invalid_input", 2, "unknown transcript stage version");
}

export function listTranscriptReviewStages(
  root: string,
  readDirectory: StageDirectoryReader = readStageDirectory
): TranscriptStageList {
  const canonical = canonicalRoot(root);
  const directory = path.join(canonical, STAGING_RELATIVE);
  if (!existsSync(directory)) return { stages: [], diagnostics: [] };
  let entries: readonly Dirent[];
  try {
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return {
        stages: [],
        diagnostics: [
          { path: STAGING_RELATIVE, message: "staging directory is not a regular directory" },
        ],
      };
    }
    if (!realpathSync(directory).startsWith(`${canonical}${path.sep}`)) {
      return {
        stages: [],
        diagnostics: [{ path: STAGING_RELATIVE, message: "staging directory escapes workspace" }],
      };
    }
    entries = readDirectory(directory)
      .filter((entry) => entry.name.endsWith(".json"))
      .sort((first, second) => first.name.localeCompare(second.name));
  } catch (error) {
    return {
      stages: [],
      diagnostics: [
        {
          path: STAGING_RELATIVE,
          message:
            error instanceof Error
              ? "staging directory is unreadable"
              : "untyped staging directory read failure",
        },
      ],
    };
  }
  const stages: TranscriptStageSummary[] = [];
  const diagnostics: { readonly path: string; readonly message: string }[] = [];
  for (const entry of entries) {
    const pathname = path.join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      diagnostics.push({ path: entry.name, message: "stage is not a regular file" });
      continue;
    }
    try {
      stages.push(summary(canonical, pathname));
    } catch (error) {
      if (error instanceof Error) {
        diagnostics.push({ path: entry.name, message: error.message });
      } else {
        diagnostics.push({ path: entry.name, message: "untyped stage read failure" });
      }
    }
  }
  return { stages, diagnostics };
}

export function summarizeTranscriptReview(
  root: string,
  readDirectory: StageDirectoryReader = readStageDirectory
): TranscriptReviewCounts {
  const listing = listTranscriptReviewStages(root, readDirectory);
  const pending = listing.stages.filter(
    (stage) => stage.version === 2 && stage.status === "pending_review"
  );
  return {
    pendingStages: pending.length,
    decisions: pending.reduce((total, stage) => total + stage.decisions, 0),
    tasks: pending.reduce((total, stage) => total + stage.tasks, 0),
    failedRubric: listing.stages.filter(
      (stage) => stage.version === 2 && stage.status === "failed_rubric"
    ).length,
    gradingErrors: listing.stages.filter(
      (stage) => stage.version === 2 && stage.status === "grading_error"
    ).length,
    unreadableStages: listing.diagnostics.length,
  };
}
