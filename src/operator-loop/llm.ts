// C5 LLM seam — the ONLY module in the operator loop that imports `@anthropic-ai/sdk` or touches
// the network. Everything else takes an injected `CompletionFn`, so the drafter/seams are pure
// and fully unit-testable offline (tests pass a fake `complete`). The default implementation
// calls the Anthropic Messages API with a forced tool call for reliable structured output.
//
// Egress note: a `CompletionFn` is only ever handed the AUDIENCE PROJECTION (see project.ts) —
// admin-tier content never reaches this module. Constructing the client requires explicit
// operator consent at the CLI (`--remote` + ANTHROPIC_API_KEY); see c5-weekly.md.

import Anthropic from "@anthropic-ai/sdk";

/** Default drafter model: the latest Claude. Swap to a cheaper tier as volume/cost scales. */
export const DRAFTER_MODEL = "claude-opus-4-8";

export interface CompletionRequest {
  /** System prompt — the drafter's role + tier-safety instructions. */
  system: string;
  /** User content — the audience-projected manifest signals to draft from. */
  user: string;
  /** JSON Schema the structured output must satisfy (used as the forced tool's input_schema). */
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

/**
 * The injected completion seam. Returns the model's STRUCTURED output as a parsed object (the
 * forced tool call's `input`). The drafter validates the shape; a fake in tests just returns an
 * object. Kept provider-agnostic so the loop never imports an SDK except through this module.
 */
export type CompletionFn = (req: CompletionRequest) => Promise<unknown>;

/** Per-caller model/effort/timeout binding for a `CompletionFn`. `effort` is passed to the
 *  Messages API as `output_config.effort` (Opus 4.8 contract); `temperature`/`top_p`/`top_k`/
 *  `budget_tokens` are deliberately never sent (they 400 on 4.8). */
export interface CompletionOptions {
  model?: string;
  effort?: string;
  timeoutMs?: number;
}

/** True when a remote LLM call could be made (the egress key is present). */
export function hasAnthropicKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && String(env.ANTHROPIC_API_KEY).trim());
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!hasAnthropicKey()) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — remote drafting requires it. Run offline (no --remote) or set the key."
    );
  }
  if (!client) client = new Anthropic();
  return client;
}

/**
 * The single forced-tool Messages call. Exported so the model/effort threading is unit-testable
 * with a fake `client` (no network): the caller asserts the request carried the resolved `model`
 * and `output_config.effort` and none of the banned sampling params. Returns the `tool_use.input`
 * — the validated structured object (no fragile free-text JSON parsing).
 */
export async function runCompletion(
  client: Anthropic,
  req: CompletionRequest,
  opts: CompletionOptions = {}
): Promise<unknown> {
  const schema = req.schema ?? { type: "object" };
  const body: Record<string, unknown> = {
    model: opts.model ?? DRAFTER_MODEL,
    max_tokens: req.maxTokens ?? 8000,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    tools: [
      {
        name: "emit",
        description: "Emit the structured draft.",
        input_schema: schema,
      },
    ],
    tool_choice: { type: "tool", name: "emit" },
  };
  // Reasoning effort rides in output_config on Opus 4.8 — only sent when set.
  if (opts.effort) body.output_config = { effort: opts.effort };
  const reqOpts = opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined;
  const msg = await client.messages.create(
    body as unknown as Anthropic.MessageCreateParamsNonStreaming,
    reqOpts
  );
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("drafter: model returned no structured tool_use block");
  }
  return block.input;
}

/**
 * Build a `CompletionFn` bound to a resolved model / effort / timeout (e.g. `loop-models.mjs`'s
 * `decisions_distill` step). Constructing the client requires the egress key + explicit `--remote`
 * consent at the CLI; this stays the ONLY module that imports the SDK.
 */
export function makeAnthropicCompletion(opts: CompletionOptions = {}): CompletionFn {
  return (req) => runCompletion(getClient(), req, opts);
}

/**
 * Default `CompletionFn`: the forced-tool Messages call at the default drafter model. Used by the
 * weekly closeout drafter.
 */
export const anthropicCompletion: CompletionFn = (req) => runCompletion(getClient(), req);
