// Module-resolution hooks used by test/cli-registry.test.mjs to prove lazy loading.
// Runs on the loader thread; the trace path arrives through register()'s `data` channel
// (process.env is NOT reliably shared with the hooks thread).
import { appendFileSync } from "node:fs";

let out = null;

export function initialize(data) {
  out = data?.out ?? null;
}

export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (out && result.url?.startsWith("file:")) {
    try {
      appendFileSync(out, `${result.url}\n`);
    } catch {
      /* tracing must never break the traced process */
    }
  }
  return result;
}
