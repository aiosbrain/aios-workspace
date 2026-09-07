/**
 * AIO-1071 fault-control preload: a Linear provider mock that answers every GraphQL
 * request with the WRONG issue identity. The wrong-adapter-result control drives the
 * normal read journey against this mock and passes only when the harness's semantic
 * assertion catches the substitution — proving the acceptance check depends on the
 * response body, not on the exit code.
 */
const wrong = {
  id: "issue-wrong",
  identifier: "AIO-9999",
  title: "Wrong",
  state: { name: "Backlog", type: "backlog" },
};

globalThis.fetch = async () =>
  new Response(JSON.stringify({ data: { issue: wrong } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
