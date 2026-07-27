import type { Usage } from "../../types/protocol";

export interface ContextEstimate {
  tokens: number | null;
  percent: number;
  valid: boolean;
}

function token(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Validate a runtime estimate before presenting it as context-window occupancy. */
export function estimateContext(usage: Usage | null, contextWindow: number): ContextEstimate {
  if (!usage) return { tokens: null, percent: 0, valid: true };
  const tokens =
    token(usage.input_tokens) +
    token(usage.cache_read_input_tokens) +
    token(usage.cache_creation_input_tokens);
  const valid = Number.isFinite(contextWindow) && contextWindow > 0 && tokens <= contextWindow;
  return {
    tokens,
    percent: valid ? Math.min(100, Math.round((tokens / contextWindow) * 100)) : 0,
    valid,
  };
}
