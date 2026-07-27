import { TranscriptReviewError } from "./errors.js";

export type UnknownRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new TranscriptReviewError("invalid_input", 2, `${label} must be an object`);
  }
  return value;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TranscriptReviewError("invalid_input", 2, `${label} must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, label);
}

export function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `${label} must be an integer >= ${minimum}`
    );
  }
  return value;
}

export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TranscriptReviewError("invalid_input", 2, `${label} must be a boolean`);
  }
  return value;
}

export function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TranscriptReviewError("invalid_input", 2, `${label} must be an array`);
  }
  return value;
}

export function stringArray(value: unknown, label: string): readonly string[] {
  return arrayValue(value, label).map((item, index) => stringValue(item, `${label}[${index}]`));
}

export function literal<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string") {
    throw new TranscriptReviewError("invalid_input", 2, `${label} must be a string`);
  }
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new TranscriptReviewError("invalid_input", 2, `${label} has unknown value: ${value}`);
  }
  return found;
}

export function jsonValue(input: string): unknown {
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TranscriptReviewError("invalid_input", 2, `malformed JSON: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}
