import { ApiError } from "../../lib/api";

export const MAX_CONFIRMED_SEND_ATTEMPTS = 3;

export function canRetryConfirmed(attempts: number): boolean {
  return attempts < MAX_CONFIRMED_SEND_ATTEMPTS;
}

export function retryDelayMs(retryAfter: string | null | undefined, now = Date.now()): number {
  const parsed = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (!Number.isFinite(parsed)) return 15_000;
  return Math.max(0, parsed - now);
}

/** Structured 429 bodies carry the server's next safe reconciliation time. */
export function deferredRetryAfter(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  const body = error.body as { retry_after?: unknown } | null;
  return typeof body?.retry_after === "string" ? body.retry_after : null;
}
