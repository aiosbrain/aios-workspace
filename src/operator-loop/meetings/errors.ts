export type TranscriptErrorKind = "invalid_input" | "integrity" | "busy" | "operation" | "phase";

export class TranscriptReviewError extends Error {
  override readonly name = "TranscriptReviewError";

  constructor(
    readonly kind: TranscriptErrorKind,
    readonly exitCode: 1 | 2,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export class PhaseExecutionError extends Error {
  override readonly name = "PhaseExecutionError";

  constructor(
    readonly phase: string,
    readonly diagnostic: string,
    options?: ErrorOptions
  ) {
    super(`${phase} phase failed: ${diagnostic}`, options);
  }
}

export function diagnosticMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, " ").trim().slice(0, 500) || error.name;
  }
  return "untyped phase failure";
}

export function assertNever(value: never): never {
  throw new TranscriptReviewError(
    "invalid_input",
    2,
    `unhandled transcript review variant: ${String(value)}`
  );
}
