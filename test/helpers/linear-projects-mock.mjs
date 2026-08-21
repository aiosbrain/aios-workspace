// Schema-derived mock Linear server for the project commands (AIO-1012).
//
// The mock VALIDATES before it fabricates. A real GraphQL server rejects an unknown field
// or an undeclared variable at validation time; a substring-matching mock does not, which
// lets a broken production query pass a green test. The previous version validated against
// a HAND-MAINTAINED field allowlist — self-referential, because the list was copied from
// the very query it validated, so it kept accepting `Project.state` after Linear deprecated
// it. This version derives the allowlist from `linear-project-schema.json`, a checked-in
// introspection snapshot of the real API, and additionally rejects DEPRECATED fields — the
// same way a schema removal would surface, but before it happens.
//
// Regenerating the snapshot (read-only, needs LINEAR_API_KEY):
//   query { __type(name: "Project") { fields(includeDeprecated: true) {
//     name isDeprecated deprecationReason type { kind name ofType { ... } } } } }
//   (repeat for ProjectStatus and PageInfo; unwrap NON_NULL/LIST to the named type and
//    record it as `type` only for composite kinds that need a nested selection).
//
// Used two ways:
//   - imported by the test file for direct `validateProjectsQuery` assertions;
//   - loaded as a `node --import` preload by the CLI subprocess, where it installs the
//     fetch mock when MOCK_PAGES is set (pages JSON, one array of projects per Relay page).
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const SCHEMA = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "linear-project-schema.json"), "utf8")
);

function fieldMap(typeName) {
  const type = SCHEMA[typeName];
  if (!type) {
    throw new Error(
      `type "${typeName}" is not in the schema snapshot — extend test/helpers/linear-project-schema.json`
    );
  }
  return new Map(type.fields.map((field) => [field.name, field]));
}

// Validate one selection set (tokenized) against a named type, the way the server would:
// unknown fields, deprecated fields, scalar sub-selections, and missing object selections
// all throw.
function validateSelection(tokens, typeName) {
  const fields = fieldMap(typeName);
  let index = 0;
  while (index < tokens.length) {
    const name = tokens[index++];
    if (name === "{" || name === "}") throw new Error(`malformed selection set on "${typeName}"`);
    const field = fields.get(name);
    if (!field) throw new Error(`Cannot query field "${name}" on type "${typeName}"`);
    if (field.deprecated) {
      throw new Error(`Field "${typeName}.${name}" is deprecated: ${field.deprecated}`);
    }
    if (tokens[index] === "{") {
      const start = index;
      let depth = 0;
      do {
        if (index >= tokens.length) {
          throw new Error(`unbalanced selection set under "${typeName}.${name}"`);
        }
        if (tokens[index] === "{") depth++;
        else if (tokens[index] === "}") depth--;
        index++;
      } while (depth > 0);
      if (!field.type) {
        throw new Error(`Field "${typeName}.${name}" is a scalar — it cannot have a sub-selection`);
      }
      validateSelection(tokens.slice(start + 1, index - 1), field.type);
    } else if (field.type) {
      throw new Error(
        `Field "${typeName}.${name}" of type "${field.type}" must have a selection of subfields`
      );
    }
  }
}

const selectionTokens = (block) => block.match(/[A-Za-z_][A-Za-z0-9_]*|\{|\}/g) ?? [];

// Extract the (possibly nested) selection block following `<name>{ ... }`, brace-balanced.
function extractBlock(query, name) {
  const match = new RegExp(`${name}\\s*\\{`).exec(query);
  if (!match) return null;
  let depth = 0;
  for (let i = match.index + match[0].length - 1; i < query.length; i++) {
    if (query[i] === "{") depth++;
    else if (query[i] === "}" && --depth === 0) {
      return query.slice(match.index + match[0].length, i);
    }
  }
  throw new Error(`unbalanced braces after "${name}"`);
}

export function validateProjectsQuery(query) {
  for (const [, variable] of query.matchAll(/\$(\w+)\s*:/g)) {
    if (!["f", "after"].includes(variable)) throw new Error("undeclared variable: $" + variable);
  }
  const nodes = extractBlock(query, "nodes");
  if (nodes === null) throw new Error("projects query selects no nodes");
  validateSelection(selectionTokens(nodes), "Project");
  const pageInfo = extractBlock(query, "pageInfo");
  if (pageInfo === null) throw new Error("projects query selects no pageInfo — it cannot paginate");
  validateSelection(selectionTokens(pageInfo), "PageInfo");
  if (!/projects\([^)]*after:\s*\$after/.test(query)) {
    throw new Error("projects query does not pass $after — it cannot paginate");
  }
}

export function installProjectsMockFetch({ pages, logPath, cycle }) {
  globalThis.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    let data;
    if (query.includes("projects(")) {
      validateProjectsQuery(query);
      const index = variables.after ? Number(variables.after.replace("cursor-", "")) : 0;
      const needle = (variables.f?.name?.containsIgnoreCase ?? "").toLowerCase();
      const nodes = (pages[index] ?? []).filter((p) => p.name.toLowerCase().includes(needle));
      const hasNextPage = index + 1 < pages.length || cycle;
      const endCursor = !hasNextPage
        ? null
        : index + 1 < pages.length
          ? "cursor-" + (index + 1)
          : "cursor-0";
      data = { projects: { nodes, pageInfo: { hasNextPage, endCursor } } };
    } else if (query.includes("team(id:$key){ id }")) {
      data = { team: { id: "team-1" } };
    } else if (query.includes("states")) {
      data = { team: { states: { nodes: [{ id: "state-1", name: "Backlog" }] } } };
    } else if (query.includes("projectCreate")) {
      appendFileSync(logPath, JSON.stringify(variables) + "\n");
      data = {
        projectCreate: {
          success: true,
          project: {
            id: "p-new",
            name: variables.input.name,
            url: "https://linear.app/x/project/new",
          },
        },
      };
    } else if (query.includes("issueCreate")) {
      appendFileSync(logPath, JSON.stringify(variables) + "\n");
      data = {
        issueCreate: {
          success: true,
          issue: { identifier: "AIO-1", title: "t", url: "u", branchName: "b" },
        },
      };
    } else {
      throw new Error("unexpected query: " + query);
    }
    return { ok: true, json: async () => ({ data }) };
  };
}

// Preload mode: the CLI subprocess passes its fixtures through the environment.
if (process.env.MOCK_PAGES) {
  installProjectsMockFetch({
    pages: JSON.parse(process.env.MOCK_PAGES),
    logPath: process.env.MOCK_LOG,
    cycle: process.env.MOCK_CYCLE === "1",
  });
}
