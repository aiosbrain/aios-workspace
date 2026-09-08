/**
 * linear-verb-help.test.mjs — AIO-1116: `aios linear <verb> --help` answers with usage
 * BEFORE credential resolution, so an unconfigured machine can read help. Exercised
 * in-process under a scrubbed env so no ambient LINEAR_API_KEY can mask the regression.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { scrubAmbientProcessEnv } from "./helpers/scrubbed-env.mjs";

test("aios linear <verb> --help prints usage without resolving credentials", async () => {
  const restore = scrubAmbientProcessEnv();
  const lines = [];
  const origLog = console.log;
  console.log = (m) => lines.push(String(m));
  try {
    const { cmdLinear } = await import("../scripts/connectors/linear/index.mjs");
    for (const argv of [
      ["list", "--help"],
      ["get", "-h"],
      ["create", "--help"],
    ]) {
      lines.length = 0;
      const code = await cmdLinear(null, argv);
      assert.equal(code, 0, `${argv.join(" ")} must exit 0`);
      assert.match(lines.join("\n"), /aios linear/i, "usage text, not a credential error");
    }
  } finally {
    console.log = origLog;
    restore();
  }
});
