/** Acceptance-only loader: terminate the installed CLI after a durable journal write.
 * This preload is never part of the npm product and never changes installed bytes.
 */
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const target = process.env.AIOS_ACCEPTANCE_MIGRATION_MODULE;
const state = process.env.AIOS_ACCEPTANCE_INTERRUPT_STATE;
const marker = process.env.AIOS_ACCEPTANCE_INTERRUPT_MARKER;
if (!target || !state || !marker) throw new Error("Incomplete interruption fixture");
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== target) return loaded;
    const source = String(loaded.source);
    const needle = "  options.interrupt?.(journal.state, Object.freeze({ ...journal }));";
    if (source.split(needle).length !== 2) throw new Error("Migration fixture target changed");
    writeFileSync(marker, JSON.stringify({ loaded: url, interruptAt: state }));
    return {
      ...loaded,
      source: source.replace(
        needle,
        `  if (journal.state === ${JSON.stringify(state)}) process.exit(86);\n${needle}`
      ),
    };
  },
});
