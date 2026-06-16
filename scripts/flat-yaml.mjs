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

export function parseFlatYaml(text) {
  const out = {};
  let currentList = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentList) {
      out[currentList].push(stripQuotes(listItem[1].trim()));
      continue;
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
    }
  }
  return out;
}
