import { readFileSync } from "node:fs";

export function documentedComponents(docPath) {
  const doc = readFileSync(docPath, "utf8");
  const block = doc.match(
    /<!--\s*drift:operator-components\s*-->([\s\S]*?)<!--\s*\/drift:operator-components\s*-->/
  );
  if (!block) throw new Error("missing drift:operator-components block");
  const rows = [];
  for (const match of block[1].matchAll(/`([^`]+)`/g)) {
    const [component, identifier, status, spec] = match[1].split("|");
    if (!component || !identifier || !status || !spec) {
      throw new Error(`malformed component token: ${match[1]}`);
    }
    rows.push({ component, identifier, status, spec });
  }
  return rows;
}

export function normalizeStatus(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function blockedByIdentifiers(issue) {
  return (issue?.inverseRelations?.nodes || [])
    .filter((relation) => relation?.type === "blocks")
    .map((relation) => relation?.issue?.identifier)
    .filter(Boolean);
}

export async function fetchAllTeamIssues(request, teamKey) {
  const issues = [];
  let after = null;
  do {
    const data = await request(
      `query($key:String!,$after:String){
        issues(first:100, after:$after, filter:{ team:{ key:{ eq:$key } } }){
          pageInfo{ hasNextPage endCursor }
          nodes{
            identifier title state{ name } url
            inverseRelations{ nodes{ type issue{ identifier state{ name type } } } }
          }
        }
      }`,
      { key: teamKey, after }
    );
    const page = data?.issues;
    if (!page || !Array.isArray(page.nodes) || !page.pageInfo) {
      throw new Error("Linear query returned a malformed issues page");
    }
    issues.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && !after) {
      throw new Error("Linear pagination reported another page without an end cursor");
    }
  } while (after);
  return issues;
}
