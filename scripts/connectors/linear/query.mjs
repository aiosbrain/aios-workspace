// `aios linear query` — raw GraphQL passthrough to the Linear API (AIO-1072).
//
// Ports the retired linear-direct descriptor client (linear-query.mjs +
// linear-query-client.mjs) into the built-in adapter. Credential resolution is the
// adapter preflight's job (index.mjs ensureLinearCredential); this module reads the
// resolved key only through core.mjs `gql`, exactly like every other verb — it never
// carries its own env/dotenvx/token logic.
//
//   aios linear query                          # default: every open issue assigned to
//                                              # the authenticated viewer (paginated)
//   aios linear query '<graphql>' [--vars <json>]
//                                              # any GraphQL query or mutation
//
// The GraphQL `data` payload is printed as JSON on stdout (machine surface);
// diagnostics go to stderr with a non-zero exit, matching the adapter's verbs.
import { fail, gql } from "./core.mjs";

export const ASSIGNED_OPEN_QUERY = `query AssignedOpen($first: Int!, $after: String) {
  viewer {
    name
    assignedIssues(
      first: $first
      after: $after
      filter: { state: { type: { nin: ["completed", "canceled"] } } }
    ) {
      nodes {
        id
        identifier
        title
        updatedAt
        state { name type }
        priorityLabel
        url
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/**
 * Paginate every open issue assigned to the authenticated viewer. `request` is a test
 * seam; the default routes through core.mjs `gql` (resolved credential, 30s timeout).
 */
export async function queryAssignedOpenIssues({
  request = (query, variables) => gql(query, variables, { throwOnError: true }),
  pageSize = 50,
  maxIssues = 500,
} = {}) {
  const nodes = [];
  let after = null;
  let viewerName = "";

  for (;;) {
    const data = await request(ASSIGNED_OPEN_QUERY, { first: pageSize, after });
    const assigned = data?.viewer?.assignedIssues;
    if (!Array.isArray(assigned?.nodes)) {
      throw new Error("Linear response missing assigned issues");
    }
    viewerName ||= data.viewer.name || "";
    nodes.push(...assigned.nodes);
    if (nodes.length > maxIssues) {
      throw new Error(`Linear assigned issue query exceeded the ${maxIssues}-issue safety cap`);
    }
    if (!assigned.pageInfo?.hasNextPage) break;
    after = assigned.pageInfo.endCursor;
    if (typeof after !== "string" || !after) {
      throw new Error("Linear pagination response missing end cursor");
    }
  }

  return { viewer: { name: viewerName, assignedIssues: { nodes } } };
}

function parseVars(argv) {
  const index = argv.indexOf("--vars");
  if (index < 0) return {};
  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith("--")) fail("--vars requires a JSON value");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("--vars must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("--vars must be a JSON object");
  }
  return parsed;
}

/** `aios linear query [<graphql>] [--vars <json>]` — argv is everything after `query`. */
export async function cmdQuery(argv) {
  let query = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vars") {
      i++; // skip the JSON value
      continue;
    }
    if (argv[i].startsWith("--"))
      fail(`unknown option ${argv[i]} — usage: aios linear query '<graphql>' [--vars <json>]`);
    if (query !== null) fail("query accepts one GraphQL document — quote the whole query");
    query = argv[i];
  }
  const variables = parseVars(argv);
  let data;
  if (query) {
    data = await gql(query, variables, { throwOnError: true }).catch((error) => {
      fail(`linear query failed: ${error.message}`);
    });
  } else {
    data = await queryAssignedOpenIssues().catch((error) => {
      fail(`linear query failed: ${error.message}`);
    });
  }
  console.log(JSON.stringify(data, null, 2));
  return 0;
}
