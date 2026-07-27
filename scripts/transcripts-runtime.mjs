import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const STAGING_REL = ".aios/staging/transcript-decisions";

export class TranscriptCliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function replaceControls(value, replacement) {
  return [...String(value)]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? replacement : character;
    })
    .join("");
}

export function displayPath(value) {
  return replaceControls(value, "?");
}

function refuseSymlinkSegments(root, target) {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("symbolic links are not accepted for transcript pipeline inputs");
    }
  }
}

export function safeWorkspacePath(root, value, { mustExist = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error("path is required");
  const originalRoot = path.resolve(root);
  const canonicalRoot = realpathSync(originalRoot);
  const requested = path.resolve(originalRoot, value);
  const lexicalRoot = isContained(originalRoot, requested)
    ? originalRoot
    : isContained(canonicalRoot, requested)
      ? canonicalRoot
      : null;
  if (!lexicalRoot) throw new Error("path escapes workspace");
  refuseSymlinkSegments(lexicalRoot, requested);
  if (mustExist && !existsSync(requested)) throw new Error("file not found");
  if (!existsSync(requested)) return requested;
  const target = realpathSync(requested);
  if (!isContained(canonicalRoot, target)) throw new Error("path escapes workspace");
  return target;
}

export function safeStagePath(root, value, options = {}) {
  const target = safeWorkspacePath(root, value, options);
  const stagingRoot = path.join(realpathSync(path.resolve(root)), STAGING_REL);
  if (target === stagingRoot || !isContained(stagingRoot, target)) {
    throw new Error(`stage file must be inside ${STAGING_REL}`);
  }
  return target;
}

export function readJsonFile(root, value, label) {
  const file = safeWorkspacePath(root, value, { mustExist: true });
  let bytes;
  try {
    bytes = readFileSync(file, "utf8");
  } catch {
    throw new Error(`${label} is unreadable`);
  }
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`${label} contains malformed JSON`);
  }
}

export function readStageSource(root, value) {
  const stagePath = safeStagePath(root, value, { mustExist: true });
  let source;
  try {
    source = readFileSync(stagePath, "utf8");
  } catch {
    throw new Error("stage file is unreadable");
  }
  let valueObject;
  try {
    valueObject = JSON.parse(source);
  } catch {
    throw new Error("stage file contains malformed JSON");
  }
  return { stagePath, source, value: valueObject };
}

export function stageRelative(root, stagePath) {
  return displayPath(path.relative(realpathSync(path.resolve(root)), stagePath));
}

export function nowProvider(deps) {
  if (typeof deps.now === "function") return deps.now;
  if (typeof deps.now === "string") return () => deps.now;
  return () => new Date().toISOString();
}

export function createOutput(deps) {
  const stdout = deps.stdout ?? ((value) => console.log(value));
  const stderr = deps.stderr ?? ((value) => console.error(value));
  return {
    result(payload, text, json) {
      stdout(json ? JSON.stringify(payload) : text);
    },
    error(message, json, code) {
      const safeMessage = replaceControls(message, " ").slice(0, 500);
      const payload = { status: "error", code, error: safeMessage };
      if (json) stdout(JSON.stringify(payload));
      else stderr(`transcripts: ${safeMessage}`);
    },
  };
}

export function rubricBudget(args, fallback = 1) {
  const raw = argValue(args, "--rubric-budget");
  if (raw == null) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error("--rubric-budget must be a non-negative integer");
  return Number(raw);
}

export function invalidRequest(error) {
  return new TranscriptCliError(error instanceof Error ? error.message : String(error), 2);
}
