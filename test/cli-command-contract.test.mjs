import test from "node:test";
import assert from "node:assert/strict";
import { validateCommandDescriptor } from "../scripts/cli/command-contract.mjs";
import { COMMANDS } from "../scripts/cli/registry.mjs";

test("every descriptor satisfies the resolution/startup-policy contract", () => {
  for (const descriptor of COMMANDS) {
    assert.doesNotThrow(
      () => validateCommandDescriptor(descriptor),
      `${descriptor.name} has contradictory startup metadata`
    );
  }
});

test("every resolution rejects a mismatched startup policy", () => {
  const alternatives = {
    diagnostic: "offline",
    "pre-config": "offline",
    offline: "pre-config",
    workspace: "offline",
    "update-root": "requires-workspace",
  };

  for (const resolution of Object.keys(alternatives)) {
    const descriptor = COMMANDS.find((candidate) => candidate.resolution === resolution);
    assert.ok(descriptor, `registry does not exercise '${resolution}' resolution`);
    const mismatched = {
      ...descriptor,
      metadata: { ...descriptor.metadata, startupPolicy: alternatives[resolution] },
    };
    assert.throws(
      () => validateCommandDescriptor(mismatched),
      new RegExp(`resolution '${resolution}'.*requires startupPolicy`),
      `${resolution} accepted contradictory startup metadata`
    );
  }
});
