import test from "node:test";
import assert from "node:assert/strict";
import { renderPulledNote } from "../scripts/pull-notes.mjs";

const pulledAt = "2026-09-28T00:00:00.000Z";
const note = (overrides = {}) => ({
  id: "note-item-id",
  project: "destination",
  path: "governed/note/id.md",
  actor: "member-handle",
  kind: "note",
  access: "team",
  frontmatter: { title: "Note title" },
  body: "Note body",
  ...overrides,
});

function splitProjection(text) {
  const end = text.indexOf("\n---\n", 4);
  const fields = Object.fromEntries(
    text
      .slice(4, end)
      .split("\n")
      .map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), JSON.parse(line.slice(colon + 1).trim())];
      })
  );
  return { fields, body: text.slice(end + 5) };
}

test("preserves origin identity, authoritative tier, title and exact accepted body", () => {
  const item = note({
    body: " \r\n# Raw body\r\n---\n\n",
    frontmatter: { title: "  Raw title 🧠 e\u0301  " },
  });
  const { fields, body } = splitProjection(renderPulledNote(item, pulledAt));
  assert.deepEqual(fields, {
    from_brain: true,
    origin_project: item.project,
    origin_path: item.path,
    origin_actor: item.actor,
    origin_item_id: item.id,
    kind: "note",
    title: item.frontmatter.title,
    access: "team",
    pulled_at: pulledAt,
  });
  assert.equal(body, item.body);
});

test("untrusted title and origin strings cannot inject frontmatter", () => {
  const injection = 'line one\r\n---\naccess: external\nfrom_brain: false\n" : # comment';
  const item = note({
    frontmatter: { title: injection },
    actor: injection,
    project: injection,
    path: injection,
  });
  const { fields, body } = splitProjection(renderPulledNote(item, pulledAt));
  assert.equal(fields.title, injection);
  assert.equal(fields.origin_actor, injection);
  assert.equal(fields.origin_project, injection);
  assert.equal(fields.origin_path, injection);
  assert.equal(fields.access, "team");
  assert.equal(fields.from_brain, true);
  assert.equal(Object.keys(fields).length, 9);
  assert.equal(body, item.body);
});

test("maximum astral note content is retained without truncation or normalization", () => {
  const item = note({ frontmatter: { title: "🧠".repeat(200) }, body: "🧠".repeat(25000) });
  const parsed = splitProjection(renderPulledNote(item, pulledAt));
  assert.equal(parsed.fields.title, item.frontmatter.title);
  assert.equal(parsed.body, item.body);
});

for (const item of [
  note({ kind: "task" }),
  note({ access: "external" }),
  note({ frontmatter: {} }),
  note({ frontmatter: { title: "\ud800" } }),
  note({ body: "bad\0body" }),
  note({ actor: null }),
  note({ id: "" }),
  note({ body: null }),
]) {
  test(`rejects malformed note projection ${JSON.stringify(item)}`, () => {
    assert.throws(() => renderPulledNote(item, pulledAt), TypeError);
  });
}

test("escapes Unicode YAML line breaks while preserving accepted title codepoints", () => {
  const title = "NEL\u0085LS\u2028PS\u2029end";
  const output = renderPulledNote(note({ frontmatter: { title } }), pulledAt);
  assert.equal(splitProjection(output).fields.title, title);
  assert.equal(output.includes("\u0085"), false);
  assert.equal(output.includes("\u2028"), false);
  assert.equal(output.includes("\u2029"), false);
});
