/**
 * --import preload: a stateful in-process mock of the Linear GraphQL provider, broad enough
 * to serve EVERY canonical verb (test/linear-command-parity.test.mjs). No network I/O ever
 * happens: globalThis.fetch is replaced before the CLI entry module loads.
 *
 * State is per-process (descriptions written by a mutation are served back to the readback
 * query), so the canonical and delegate processes see identical sequences.
 */
const issue = (id, identifier, extra = {}) => ({
  id,
  identifier,
  title: identifier === "AIO-73" ? "Alpha" : "Beta",
  state: { name: "Backlog", type: "backlog" },
  ...extra,
});
const a = issue("issue-a", "AIO-73");
const b = issue("issue-b", "AIO-75");
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

let storedDescription = "body";

globalThis.fetch = async (_url, init) => {
  // Optional assertion seam: prove WHICH credential the adapter resolved (e.g. the
  // workspace vault key from a subdirectory invocation) without ever printing it.
  const expectAuth = process.env.MOCK_EXPECT_AUTH;
  if (expectAuth && init.headers?.Authorization !== expectAuth) {
    throw new Error("mock-linear-provider: unexpected Authorization credential");
  }
  const { query, variables } = JSON.parse(init.body);
  let data;
  if (query.includes("issue(id:$id){ id identifier")) {
    data = { issue: variables.id === "AIO-75" ? b : a };
  } else if (query.includes("priorityLabel url description")) {
    data = {
      issue: {
        ...a,
        priorityLabel: "High",
        url: "https://linear.example/AIO-73",
        description: storedDescription,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        completedAt: null,
        canceledAt: null,
        project: { id: "p1", name: "Proj" },
        labels: { nodes: [{ name: "bug" }] },
        assignee: null,
        parent: null,
        children: { nodes: [] },
        comments: { nodes: [] },
      },
    };
  } else if (query.includes("issue(id:$id){ description }")) {
    data = { issue: { description: storedDescription } };
  } else if (query.includes("issues(first:250")) {
    data = { issues: page([issue("issue-1", "AIO-1"), a]) };
  } else if (query.includes("workflowStates(first:250")) {
    data = {
      workflowStates: page([
        { id: "st-backlog", name: "Backlog" },
        { id: "st-progress", name: "In Progress" },
      ]),
    };
  } else if (query.includes("members(first:250")) {
    data = {
      team: {
        members: page([
          {
            id: "u1",
            name: "Alice Smith",
            displayName: "Alice",
            email: "alice@example.test",
            active: true,
          },
        ]),
      },
    };
  } else if (query.includes("states(first:250")) {
    data = { team: { states: page([{ id: "st-backlog", name: "Backlog" }]) } };
  } else if (query.includes("labels(first:250, after:$after){ nodes{ id name }")) {
    data = { team: { labels: page([{ id: "label-bug", name: "bug" }]) } };
  } else if (query.includes("issue(id:$id){\n          labels(first:250")) {
    data = { issue: { labels: page([]) } };
  } else if (query.includes("labels(first:250")) {
    // issue-side label page (id-only selection)
    data = { issue: { labels: page([]) } };
  } else if (query.includes("comments(first:250")) {
    data = {
      issue: {
        comments: page([
          {
            id: "comment-1",
            body: "first",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            user: { name: "Alice Smith" },
          },
        ]),
      },
    };
  } else if (query.includes("inverseRelations(first:250")) {
    data = { issue: { identifier: "AIO-73", inverseRelations: page([]) } };
  } else if (query.includes("relations(first:250")) {
    data = {
      issue: {
        identifier: "AIO-73",
        relations: page([{ id: "relation-1", type: "blocks", issue: a, relatedIssue: b }]),
      },
    };
  } else if (query.includes("projects(first:100")) {
    data = {
      projects: page([
        {
          id: "p1",
          name: "Proj",
          url: "https://linear.example/proj",
          status: { name: "Backlog", type: "backlog" },
        },
      ]),
    };
  } else if (query.includes("team(id:$key){ id }") || query.includes("team(id:$key){ id }")) {
    data = { team: { id: "team-1" } };
  } else if (query.includes("issueCreate")) {
    storedDescription = variables.input.description ?? "";
    data = {
      issueCreate: {
        success: true,
        issue: {
          id: "issue-new",
          identifier: "AIO-999",
          title: variables.input.title,
          url: "https://linear.example/AIO-999",
          branchName: "aios/aio-999",
        },
      },
    };
  } else if (query.includes("projectCreate")) {
    data = {
      projectCreate: {
        success: true,
        project: { id: "p2", name: variables.input.name, url: "https://linear.example/p2" },
      },
    };
  } else if (query.includes("issueRelationCreate")) {
    data = { issueRelationCreate: { success: true, issueRelation: { id: "relation-2" } } };
  } else if (query.includes("issueRelationDelete")) {
    data = { issueRelationDelete: { success: true } };
  } else if (query.includes("commentCreate")) {
    data = { commentCreate: { success: true } };
  } else if (query.includes("issueUpdate")) {
    if (variables.d !== undefined) storedDescription = variables.d;
    data = { issueUpdate: { success: true, issue: { priorityLabel: "High" } } };
  } else {
    throw new Error("mock-linear-provider: unexpected query: " + query);
  }
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
