/** Minimal rubric object for runShip tests — avoids seeding `.claude/rubrics/` in every temp repo. */
export function stubSpecRubric() {
  return {
    frontmatter: { kind: "rubric", budget: 2 },
    rows: [{ id: "SR1", criterion: "stub", method: "stub", must: "blocker" }],
    raw: "---\nkind: rubric\nbudget: 2\n---\n",
    path: "stub",
  };
}
