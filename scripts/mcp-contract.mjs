import assert from "node:assert/strict";
import { TOOLS, SURFACES } from "../packages/mcp-core/index.mjs";

// Deliberately independent expectations: a moved, missing or extra tool is a contract change.
export const EXPECTED_MCP_SURFACES = {
  standalone: [
    "brain_status",
    "brain_query",
    "brain_pull_items",
    "brain_get_item",
    "brain_list_projects",
    "brain_list_tasks",
    "brain_list_decisions",
    "brain_stakeholders",
  ],
  toolkit: [
    "brain_status",
    "brain_query",
    "brain_pull_items",
    "brain_get_item",
    "brain_list_projects",
    "brain_list_tasks",
    "brain_list_decisions",
    "brain_stakeholders",
    "aios_loop_collect",
  ],
  remoteSpecification: ["brain_query", "brain_pull_items"],
};
const sorted = (values) => [...values].sort();
export function assertMcpContract(fixture, { tools = TOOLS, surfaces = SURFACES } = {}) {
  assert.equal(fixture.status, "specification-only");
  assert.deepEqual(
    sorted(tools.map((t) => t.name)),
    sorted(EXPECTED_MCP_SURFACES.toolkit),
    "canonical toolkit membership drift"
  );
  for (const surface of ["standalone", "toolkit"]) {
    assert.deepEqual(
      sorted(surfaces[surface]),
      sorted(EXPECTED_MCP_SURFACES[surface]),
      `${surface} membership drift`
    );
  }
  assert.deepEqual(
    sorted(fixture.tools.map((t) => t.name)),
    sorted(EXPECTED_MCP_SURFACES.remoteSpecification),
    "remote specification membership drift"
  );
  for (const expected of fixture.tools) {
    const { name, description, inputSchema } = tools.find((t) => t.name === expected.name);
    assert.deepEqual(
      { name, description, inputSchema },
      expected,
      `${name} specification descriptor drift`
    );
  }
  return {
    standalone: new Set(surfaces.standalone),
    toolkit: new Set(surfaces.toolkit),
    remoteSpecification: new Set(fixture.tools.map((t) => t.name)),
  };
}
