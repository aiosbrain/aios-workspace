// The installer verifies a launch against the PINNED artifact's frozen tool membership,
// never the moving source tree. These cases attack that boundary one field at a time.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MCP_PACKAGE_MEMBERSHIPS,
  MCP_PACKAGE_TOOLSETS as TOOLSETS,
  MCP_PACKAGE_VERSION,
} from "../scripts/mcp-hosts.mjs";
import { MCP_PACKAGE_INTEGRITY } from "../scripts/mcp-host-artifact.mjs";
import { verifyServerCommand } from "../scripts/mcp-host-install.mjs";
import { fixture, serverScript } from "./lib/mcp-host-fixture.mjs";

const BRAIN = [
  "brain_status",
  "brain_search_evidence",
  "brain_query",
  "brain_pull_items",
  "brain_get_item",
];
const BOARD = [
  "brain_list_projects",
  "brain_list_tasks",
  "brain_list_decisions",
  "brain_stakeholders",
];
const verify = (f, script) =>
  verifyServerCommand(
    { command: process.execPath, args: ["-e", serverScript(script)], env: {} },
    { ...f, timeoutMs: 5000 }
  );

test("the pin is 0.2.1 with its registry integrity and a literal frozen membership", () => {
  assert.equal(MCP_PACKAGE_VERSION, "0.2.1");
  assert.equal(
    MCP_PACKAGE_INTEGRITY,
    "sha512-+YNY05QMYyNwC56U3V5oFS7uKToSr9mTNGZeha1waq8grhB32WyHnluRnKS6mO4LKi8ueiEpI4H3xDknR5Pb1Q=="
  );
  // Literal lists, deliberately not imported from packages/mcp-core: adding a tool to the
  // source tree must not change what the installer accepts from the pinned artifact.
  assert.deepEqual([...TOOLSETS.brain], BRAIN);
  assert.deepEqual([...TOOLSETS.board], BOARD);
  assert.deepEqual(Object.keys(TOOLSETS), ["brain", "board"]);
  assert.deepEqual(
    MCP_PACKAGE_MEMBERSHIPS.map((names) => names.length),
    [5, 9]
  );
  for (const frozen of [TOOLSETS, TOOLSETS.brain, TOOLSETS.board, MCP_PACKAGE_MEMBERSHIPS])
    assert.ok(Object.isFrozen(frozen));
});

test("exact brain-only (tier-limited) and brain+board memberships verify, in any order", async (t) => {
  const f = fixture(t);
  const limited = await verify(f, { names: BRAIN });
  assert.equal(limited.verified, true);
  assert.equal(limited.version, "0.2.1");
  assert.deepEqual(limited.tools, BRAIN);
  const team = await verify(f, { names: [...BOARD, ...BRAIN].reverse() });
  assert.equal(team.tools.length, 9);
  assert.ok(team.tools.includes("brain_search_evidence"));
});

test("missing, extra, renamed, duplicated and superseded memberships are rejected", async (t) => {
  const f = fixture(t);
  const withoutEvidence = BRAIN.filter((name) => name !== "brain_search_evidence");
  for (const [label, names] of [
    ["the superseded 0.1.1 brain set (4)", withoutEvidence],
    ["the superseded 0.1.1 brain+board set (8)", [...withoutEvidence, ...BOARD]],
    ["one board tool missing", [...BRAIN, ...BOARD.slice(1)]],
    ["board without brain", BOARD],
    ["a partial board on top of brain", [...BRAIN, BOARD[0]]],
    ["an extra unknown tool", [...BRAIN, ...BOARD, "brain_write_item"]],
    ["the toolkit-only workspace tool", [...BRAIN, ...BOARD, "aios_loop_collect"]],
    ["a same-count rename", ["wrong", ...BRAIN.slice(1)]],
    ["a same-count duplicate", [BRAIN[0], ...BRAIN.slice(0, 4)]],
    ["no tools (unauthenticated launch)", []],
  ])
    await assert.rejects(verify(f, { names }), /did not pass .*\(membership\)/, label);
});

test("wrong version, wrong protocol and a non-read-only tool are rejected", async (t) => {
  const f = fixture(t);
  for (const [label, script] of [
    ["the superseded server version", { names: BRAIN, version: "0.1.1" }],
    ["a newer unpinned server version", { names: BRAIN, version: "0.2.2" }],
    ["a missing server version", { names: BRAIN, version: null }],
    ["another protocol revision", { names: BRAIN, protocolVersion: "2025-06-18" }],
    [
      "a writable tool in an otherwise exact membership",
      {
        tools: BRAIN.map((name, index) => ({
          name,
          annotations: { readOnlyHint: index !== 1 },
        })),
      },
    ],
    ["a tool without annotations", { tools: BRAIN.map((name) => ({ name })) }],
    ["a null tool", { tools: [...BRAIN.map((name) => ({ name })), null] }],
    ["a non-array tool list", { tools: { length: 5 } }],
  ])
    await assert.rejects(verify(f, script), /did not pass .*\(protocol\)/, label);
});
