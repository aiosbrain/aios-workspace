import { dispatch } from "./dispatch.mjs";
import { createOutput } from "./output.mjs";

async function loadLegacyContext() {
  const { legacyContext } = await import("../aios-runtime.mjs");
  return legacyContext();
}

/** Canonical CLI bootstrap. Keep this module dependency-light and configuration-free. */
export async function run(argv) {
  try {
    await dispatch({ argv, contextLoader: loadLegacyContext });
  } catch (error) {
    const output = createOutput({ json: argv.includes("--json") });
    process.exitCode = output.failure(error);
  }
}
