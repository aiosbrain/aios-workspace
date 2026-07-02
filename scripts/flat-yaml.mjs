// Restricted flat-YAML reader shared by scripts/aios.mjs (aios.yaml) and the GUI
// runtime-adapter config reader. aios.yaml is constrained to this subset (OGR04
// enforces it): flat `key: value`, `key:` list headers, `  - item` entries,
// comments, blank lines. Nested structures are NOT supported — by design.

export function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// `strict` (opt-in) turns a line the subset can't parse into a thrown Error instead of a
// silent skip. Lenient (default) stays permissive for callers that feed it frontmatter or
// `key: |` block-scalar bodies (whose indented continuation lines legitimately fall through);
// strict is for config surfaces like .aios/loop-models.yaml where a mistyped line
// (e.g. `build_model claude-sonnet-5`, no colon) must fail loudly, never resolve to defaults.
export function parseFlatYaml(text, { strict = false } = {}) {
  const out = {};
  let currentList = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem) {
      if (currentList) {
        out[currentList].push(stripQuotes(listItem[1].trim()));
        continue;
      }
      if (strict) throw new Error(`list item with no preceding key header: '${line.trim()}'`);
      continue; // lenient: a stray '- item' is dropped
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      if (value === "" || value.startsWith("#")) {
        out[key] = [];
        currentList = key;
      } else {
        out[key] = stripQuotes(value.replace(/\s+#.*$/, "").trim());
        currentList = null;
      }
      continue;
    }
    // Unrecognized shape: lenient callers skip it (block-scalar bodies, odd frontmatter);
    // strict callers reject so a malformed line can't silently vanish into defaults.
    if (strict) throw new Error(`unparseable line (expected 'key: value'): '${line.trim()}'`);
  }
  return out;
}
