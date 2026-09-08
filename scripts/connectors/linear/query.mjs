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
import { parseLinearQueryArgs } from "./query-args.mjs";
import { fail, gql, paginate } from "./core.mjs";

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
  let viewerName = "";
  let count = 0;
  const nodes = await paginate(
    async (after) => {
      const data = await request(ASSIGNED_OPEN_QUERY, { first: pageSize, after });
      const assigned = data?.viewer?.assignedIssues;
      if (!Array.isArray(assigned?.nodes)) {
        throw new Error("Linear response missing assigned issues");
      }
      viewerName ||= data.viewer.name || "";
      count += assigned.nodes.length;
      if (count > maxIssues) {
        throw new Error(`Linear assigned issue query exceeded the ${maxIssues}-issue safety cap`);
      }
      return assigned;
    },
    "Linear pagination stalled: missing or repeated end cursor",
    {
      onStall: (message) => {
        throw new Error(message);
      },
    }
  );

  return { viewer: { name: viewerName, assignedIssues: { nodes } } };
}

/** Execute only a validated query plan; direct callers receive the same pure parser. */
export async function cmdQuery(argv, plan) {
  const { query, variables } = plan ?? parseLinearQueryArgs(argv);
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
