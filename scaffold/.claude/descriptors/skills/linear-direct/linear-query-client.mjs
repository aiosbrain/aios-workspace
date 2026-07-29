export const LINEAR_API = "https://api.linear.app/graphql";

const ASSIGNED_OPEN_QUERY = `query AssignedOpen($first: Int!, $after: String) {
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

export async function requestLinear({
  query,
  variables = {},
  apiKey,
  fetchImpl = fetch,
  apiUrl = LINEAR_API,
}) {
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.errors) {
    const detail = Array.isArray(json?.errors)
      ? ` — ${json.errors.map((error) => error.message).join("; ")}`
      : ` (HTTP ${response.status})`;
    throw new Error(`Linear query failed${detail}`);
  }
  return json?.data;
}

export async function queryAssignedOpenIssues({
  apiKey,
  fetchImpl = fetch,
  pageSize = 50,
  maxIssues = 500,
}) {
  const nodes = [];
  let after = null;
  let viewerName = "";

  for (;;) {
    const data = await requestLinear({
      query: ASSIGNED_OPEN_QUERY,
      variables: { first: pageSize, after },
      apiKey,
      fetchImpl,
    });
    const assigned = data?.viewer?.assignedIssues;
    if (!Array.isArray(assigned?.nodes)) throw new Error("Linear response missing assigned issues");
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
