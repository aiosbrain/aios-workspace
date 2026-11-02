/** Toolkit-only rendering for the local, read-only projection of an accepted note. */
export function renderPulledNote(item, pulledAt) {
  if (item?.kind !== "note" || item.access !== "team") {
    throw new TypeError("Expected a team note");
  }
  const title = item.frontmatter?.title;
  for (const value of [item.id, item.project, item.path, item.actor, title, item.body, pulledAt]) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      !value.isWellFormed() ||
      value.includes("\0")
    ) {
      throw new TypeError("Note projection requires well-formed text and origin metadata");
    }
  }
  // JSON string literals are YAML double-quoted scalars. Quoting every supplied
  // value prevents title/newline/delimiter content from becoming metadata.
  const metadata = {
    origin_project: item.project,
    origin_path: item.path,
    origin_actor: item.actor,
    origin_item_id: item.id,
    kind: "note",
    title,
    access: "team",
    pulled_at: pulledAt,
  };
  return (
    [
      "---",
      "from_brain: true",
      ...Object.entries(metadata).map(
        ([key, value]) =>
          `${key}: ${JSON.stringify(value).replace(/[\u0085\u2028\u2029]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)}`
      ),
      "---",
      "",
    ].join("\n") + item.body
  );
}
