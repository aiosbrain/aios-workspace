import assert from "node:assert/strict";
import test from "node:test";

import { buildGuiClient } from "../scripts/run-gui.mjs";

test("builds the GUI client on every launch instead of trusting a stale dist", () => {
  const calls = [];
  const root = "/tmp/aios-workspace";

  buildGuiClient({
    root,
    run(command, args, options) {
      calls.push({ command, args, options });
    },
  });

  assert.deepEqual(calls, [
    {
      command: "npm",
      args: ["run", "build", "--workspace", "gui/client"],
      options: { cwd: root, stdio: "inherit" },
    },
  ]);
});
