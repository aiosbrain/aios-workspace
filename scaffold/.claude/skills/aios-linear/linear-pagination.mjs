import { gql, paginate } from "./linear-core.mjs";

export async function findWorkflowState(teamKey, name) {
  const states = await paginate(async (after) => {
    const data = await gql(
      `query($key:String!,$after:String){
        workflowStates(first:250, after:$after, filter:{ team:{ key:{ eq:$key } } }){
          nodes{ id name }
          pageInfo{ hasNextPage endCursor }
        }
      }`,
      { key: teamKey, after }
    );
    return data.workflowStates;
  }, `Linear workflow state pagination stalled for team ${teamKey}`);
  const want = String(name).toLowerCase();
  const state =
    states.find((item) => item.name.toLowerCase() === want) ||
    states.find((item) => item.name.toLowerCase().includes(want));
  return { state, states };
}

export async function listIssueComments(issueId, identifier) {
  return paginate(async (after) => {
    const data = await gql(
      `query($id:String!,$after:String){
        issue(id:$id){
          comments(first:250, after:$after){
            nodes{ id body createdAt updatedAt user{ name } }
            pageInfo{ hasNextPage endCursor }
          }
        }
      }`,
      { id: issueId, after }
    );
    return data.issue.comments;
  }, `Linear comment pagination stalled for ${identifier}`);
}

export async function listIssueLabels(issueId, identifier) {
  return paginate(async (after) => {
    const data = await gql(
      `query($id:String!,$after:String){
        issue(id:$id){
          labels(first:250, after:$after){
            nodes{ id }
            pageInfo{ hasNextPage endCursor }
          }
        }
      }`,
      { id: issueId, after }
    );
    return data.issue.labels;
  }, `Linear issue label pagination stalled for ${identifier}`);
}
