// GUI-owned minimal flat-YAML scalar reader (AIO-600).
//
// The GUI reads exactly one config file — the workspace's `aios.yaml` — and only its
// flat scalar `key: value` lines (agent_runtime, agent_model, agent_base_url,
// agent_personality, memory_review). That subset is frozen repo-wide by OGR04, so a
// tiny local parser is the honest surface here: the alternative was promoting the
// toolkit's generic parseFlatYaml (@aiosbrain/foundation/internal/flat-yaml, a
// documented-PRIVATE subpath) onto the package's frozen public API just to keep one
// import alive. See docs/gui-toolkit-contract.md.
//
// Semantics mirror the canonical parser for scalar keys: tabs→spaces, blank/comment
// lines skipped, inline `  # comment` stripped, single/double quotes stripped. List
// headers (`key:` with no value) and `  - item` entries are skipped — the GUI consumes
// no list-valued keys, so they simply resolve to "unset" and the caller's default.

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Parse the flat scalar `key: value` lines of an aios.yaml-subset document. */
export function parseFlatScalars(text) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s+-\s+/.test(line)) continue; // list entry — not a scalar
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue; // lenient, like the canonical parser's default mode
    const [, key, value] = kv;
    if (value === "" || value.startsWith("#")) continue; // list header / empty — no scalar
    out[key] = stripQuotes(value.replace(/\s+#.*$/, "").trim());
  }
  return out;
}
