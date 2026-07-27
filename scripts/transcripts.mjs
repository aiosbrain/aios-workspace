/**
 * Thin adapter for `aios transcripts`.
 *
 * Review semantics, schemas, persistence, and apply safety live in the typed meetings engine.
 * This module only maps CLI arguments, model phases, output, push execution, and exit codes.
 */

import { runApproveCommand } from "./transcripts-approve.mjs";
import { enableTranscriptSync } from "./transcripts-config.mjs";
import { runDraftCommand } from "./transcripts-draft.mjs";
import { runListCommand } from "./transcripts-list.mjs";
import { TranscriptCliError, createOutput } from "./transcripts-runtime.mjs";

export { enableTranscriptSync } from "./transcripts-config.mjs";

const USAGE =
  "usage: aios transcripts enable-sync | draft --transcripts <path,...> [--model <id>] | list | approve <stage-file> [--no-push]";

async function dispatch(root, args, deps) {
  switch (args[0]) {
    case "enable-sync": {
      const changed = enableTranscriptSync(root);
      return {
        code: 0,
        payload: { command: "enable-sync", changed, path: "1-inbox/transcripts" },
        text: changed ? "enabled transcript sync" : "transcript sync already enabled",
      };
    }
    case "draft":
      return runDraftCommand(root, args, deps);
    case "list":
      return runListCommand(root, deps);
    case "approve":
      return runApproveCommand(root, args, deps);
    default:
      throw new TranscriptCliError(USAGE, 1);
  }
}

export async function cmdTranscripts(root, _config, args, injectedDeps) {
  const invokedByDispatcher = injectedDeps === undefined;
  const deps = injectedDeps ?? {};
  const json = args.includes("--json");
  const output = createOutput(deps);
  let code;
  try {
    const result = await dispatch(root, args, deps);
    code = result.code;
    output.result(result.payload, result.text, json);
  } catch (error) {
    code = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    output.error(error instanceof Error ? error.message : String(error), json, code);
  }
  if (invokedByDispatcher) process.exitCode = code;
  return code;
}
