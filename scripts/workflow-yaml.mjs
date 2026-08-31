/**
 * workflow-yaml.mjs — a strict, zero-dependency, FAIL-CLOSED YAML reader for GitHub Actions
 * workflow files (leak-gate-remediation-plan.md §5.1 item 3).
 *
 * Why a bespoke reader rather than `yaml`/`js-yaml`: every guard under scripts/ runs on a bare
 * checkout with NO `npm ci` (see the `constitution` / `docs-drift` jobs in .github/workflows/ci.yml,
 * and the AIO-601 note at the top of scripts/flat-yaml.mjs). Both `yaml` and `js-yaml` are present
 * in this repo's node_modules only as TRANSITIVE dependencies of style-dictionary/eslint — importing
 * either would make a security gate depend on a package no manifest pins, that npm may dedupe away,
 * and that is absent in the CI job that has to run it. scripts/flat-yaml.mjs cannot be reused: it
 * parses a deliberately FLAT subset (aios.yaml) and silently drops everything nested, which for a
 * workflow file means silently dropping every job, step, and permission — exactly the failure mode a
 * security checker must not have.
 *
 * THE ONE INVARIANT: this reader never guesses. Any construct it does not fully model — an anchor,
 * an alias, a merge key, an explicit tag, a second document, a duplicate key, a tab in the
 * indentation, an unterminated quote or flow collection — throws `YamlError`. Callers treat a throw
 * as a policy VIOLATION, not as "skip this file". A parser that silently returns `{}` for a file it
 * did not understand is a checker that passes every workflow an attacker bothers to obfuscate.
 *
 * It reads YAML as DATA. It never evaluates, resolves, or executes anything in the document.
 *
 * Line provenance: maps and sequences carry non-enumerable `$line` (where the node starts) and maps
 * carry `$keyLines` (key → 1-based line of that key), so a finding can name file:line without a
 * second text scan. Non-enumerable so Object.keys/JSON.stringify stay clean.
 */

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "YamlError";
    this.line = line ?? null;
  }
}

const IGNORABLE = /^\s*(#.*)?$/;

function indentOf(raw, lineNo) {
  const m = /^[ \t]*/.exec(raw)[0];
  if (m.includes("\t")) throw new YamlError("tab in indentation (YAML forbids it)", lineNo);
  return m.length;
}

/** Attach line provenance without polluting enumeration. */
function stamp(node, line, keyLines) {
  Object.defineProperty(node, "$line", { value: line, enumerable: false });
  if (keyLines) Object.defineProperty(node, "$keyLines", { value: keyLines, enumerable: false });
  return node;
}

function skipIgnorable(p) {
  while (p.i < p.lines.length) {
    const { raw, no } = p.lines[p.i];
    if (IGNORABLE.test(raw)) {
      p.i++;
      continue;
    }
    if (raw.trim() === "---") {
      if (p.sawDocStart) throw new YamlError("multi-document YAML is not supported", no);
      p.sawDocStart = true;
      p.i++;
      continue;
    }
    if (raw.trim() === "...") throw new YamlError("document end marker is not supported", no);
    return;
  }
}

/** Next meaningful (non-blank, non-comment) line without consuming it. */
function peek(p) {
  for (let j = p.i; j < p.lines.length; j++) {
    if (!IGNORABLE.test(p.lines[j].raw)) return p.lines[j];
  }
  return null;
}

/**
 * Split `key: rest` on the first `:` that is followed by whitespace or end-of-line, honouring
 * quoted keys. Returns null when the line is not a mapping entry (so callers can tell a compact
 * sequence scalar `- npm ci` from a compact sequence map `- run: npm ci`).
 */
export function splitKey(content, lineNo) {
  let key = null;
  let after = null;
  const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')\s*:(\s|$)/.exec(content);
  if (quoted) {
    key =
      quoted[1] !== undefined ? unescapeDouble(quoted[1], lineNo) : quoted[2].replace(/''/g, "'");
    after = content.slice(quoted[0].length - quoted[3].length);
  } else {
    for (let j = 0; j < content.length; j++) {
      if (content[j] !== ":") continue;
      if (j + 1 !== content.length && content[j + 1] !== " ") continue;
      key = content.slice(0, j).trim();
      after = content.slice(j + 1);
      break;
    }
    if (key === null) return null;
    if (key === "" || /^[[{>|]/.test(key)) return null;
  }
  if (key === "<<") throw new YamlError("merge keys (`<<`) are not supported", lineNo);
  if (/^[&*!]/.test(key)) throw new YamlError("anchors/aliases/tags are not supported", lineNo);
  return { key, rest: after };
}

function unescapeDouble(body, lineNo) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc) => {
    if (esc[0] === "u" || esc[0] === "x") return String.fromCodePoint(parseInt(esc.slice(1), 16));
    const simple = { n: "\n", t: "\t", r: "\r", 0: "\0", '"': '"', "\\": "\\", "/": "/" };
    if (esc in simple) return simple[esc];
    throw new YamlError(`unsupported escape \\${esc} in double-quoted scalar`, lineNo);
  });
}

/** Strip a trailing ` # comment` from a plain scalar (a `#` not preceded by space is content). */
function stripComment(s) {
  return s.replace(/(?:^|\s)#.*$/, "").trimEnd();
}

function plainScalar(text, lineNo) {
  const s = stripComment(text).trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^[&*]/.test(s)) throw new YamlError("anchors/aliases are not supported", lineNo);
  if (/^!/.test(s)) throw new YamlError("explicit tags are not supported", lineNo);
  return s;
}

/** Parse one scalar or a single-line flow collection. Multi-line flow is rejected. */
export function parseInline(text, lineNo) {
  const s = text.trim();
  if (s.startsWith("[") || s.startsWith("{")) {
    const { value, end } = parseFlow(s, 0, lineNo);
    const tail = stripComment(s.slice(end)).trim();
    if (tail !== "") throw new YamlError(`trailing content after flow collection: ${tail}`, lineNo);
    return value;
  }
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
    if (!m) throw new YamlError("unterminated double-quoted scalar", lineNo);
    const tail = stripComment(s.slice(m[0].length)).trim();
    if (tail !== "") throw new YamlError(`trailing content after quoted scalar: ${tail}`, lineNo);
    return unescapeDouble(m[1], lineNo);
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(s);
    if (!m) throw new YamlError("unterminated single-quoted scalar", lineNo);
    const tail = stripComment(s.slice(m[0].length)).trim();
    if (tail !== "") throw new YamlError(`trailing content after quoted scalar: ${tail}`, lineNo);
    return m[1].replace(/''/g, "'");
  }
  return plainScalar(s, lineNo);
}

/** Recursive single-line flow parser. Returns the value and the index just past it. */
function parseFlow(s, start, lineNo) {
  const open = s[start];
  const close = open === "[" ? "]" : "}";
  const isSeq = open === "[";
  const out = isSeq ? [] : {};
  let i = start + 1;
  const readToken = () => {
    let depth = 0;
    let quote = null;
    const from = i;
    while (i < s.length) {
      const c = s[i];
      if (quote) {
        if (c === "\\" && quote === '"') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
      i++;
    }
    if (quote) throw new YamlError("unterminated quote inside flow collection", lineNo);
    return s.slice(from, i);
  };
  for (;;) {
    while (s[i] === " ") i++;
    if (i >= s.length)
      throw new YamlError(`unterminated flow collection (expected ${close})`, lineNo);
    if (s[i] === close) return { value: stamp(out, lineNo), end: i + 1 };
    const token = readToken();
    if (isSeq) out.push(parseInline(token, lineNo));
    else {
      const kv = splitKey(token.trim(), lineNo);
      if (!kv)
        throw new YamlError(`flow mapping entry is not \`key: value\`: ${token.trim()}`, lineNo);
      if (Object.hasOwn(out, kv.key)) throw new YamlError(`duplicate key \`${kv.key}\``, lineNo);
      out[kv.key] = parseInline(kv.rest, lineNo);
    }
    while (s[i] === " ") i++;
    if (s[i] === ",") i++;
    else if (s[i] !== close)
      throw new YamlError(`expected , or ${close} in flow collection`, lineNo);
  }
}

/** Block scalar (`|`, `>`, with any of `+`/`-`/an explicit indent digit). */
function parseBlockScalar(p, parentIndent, header, lineNo) {
  const m = /^([|>])([+-]?)([1-9]?)([+-]?)\s*(#.*)?$/.exec(header.trim());
  if (!m) throw new YamlError(`unsupported block scalar header: ${header.trim()}`, lineNo);
  const [, style, chompA, digit, chompB] = m;
  const chomp = chompA || chompB || "";
  let contentIndent = digit ? parentIndent + Number(digit) : null;
  const raws = [];
  while (p.i < p.lines.length) {
    const { raw } = p.lines[p.i];
    if (raw.trim() === "") {
      raws.push("");
      p.i++;
      continue;
    }
    const ind = indentOf(raw, p.lines[p.i].no);
    if (ind <= parentIndent) break;
    if (contentIndent === null) contentIndent = ind;
    if (ind < contentIndent) break;
    raws.push(raw.slice(contentIndent));
    p.i++;
  }
  while (raws.length && raws.at(-1) === "") raws.pop();
  let body;
  if (style === "|") body = raws.join("\n");
  else {
    // Folded: newlines between non-empty, non-more-indented lines become spaces.
    body = raws.reduce((acc, line, idx) => {
      if (idx === 0) return line;
      const prev = raws[idx - 1];
      const foldable = prev !== "" && line !== "" && !/^\s/.test(line) && !/^\s/.test(prev);
      return acc + (foldable ? " " : "\n") + line;
    }, "");
  }
  if (chomp === "-") return body;
  return body === "" ? "" : body + "\n";
}

function parseValue(p, parentIndent, rest, lineNo) {
  const head = rest.trim();
  if (head === "" || head.startsWith("#")) {
    const next = peek(p);
    if (!next) return null;
    const ind = indentOf(next.raw, next.no);
    if (ind > parentIndent) return parseBlock(p, ind);
    // A block sequence may sit at the SAME column as its key — `steps:\n- uses: …` is legal.
    if (ind === parentIndent && /^-(\s|$)/.test(next.raw.slice(ind))) return parseSeq(p, ind);
    return null;
  }
  if (/^[|>]/.test(head)) return parseBlockScalar(p, parentIndent, head, lineNo);
  const value = parseInline(head, lineNo);
  if (typeof value !== "string") return value;
  // Fold a multi-line plain scalar. A deeper-indented line that is itself `key: value` would be
  // ambiguous, so it is rejected rather than silently swallowed into the scalar.
  let folded = value;
  for (;;) {
    const next = peek(p);
    if (!next || indentOf(next.raw, next.no) <= parentIndent) break;
    if (/^-(\s|$)/.test(next.raw.trim())) break;
    if (splitKey(next.raw.trim(), next.no))
      throw new YamlError(`unexpected \`key: value\` inside a plain scalar`, next.no);
    while (p.lines[p.i] !== next) p.i++;
    folded += " " + stripComment(next.raw.trim());
    p.i++;
  }
  return folded;
}

function parseMap(p, indent) {
  const out = {};
  const keyLines = {};
  const startLine = peek(p)?.no ?? 0;
  for (;;) {
    skipIgnorable(p);
    if (p.i >= p.lines.length) break;
    const line = p.lines[p.i];
    const ind = indentOf(line.raw, line.no);
    if (ind < indent) break;
    if (ind > indent) throw new YamlError("unexpected indentation in mapping", line.no);
    const content = line.raw.slice(ind);
    if (/^-(\s|$)/.test(content))
      throw new YamlError("sequence item where a mapping key was expected", line.no);
    const kv = splitKey(content, line.no);
    if (!kv) throw new YamlError(`expected \`key: value\`, got: ${content.trim()}`, line.no);
    if (Object.hasOwn(out, kv.key)) throw new YamlError(`duplicate key \`${kv.key}\``, line.no);
    p.i++;
    keyLines[kv.key] = line.no;
    out[kv.key] = parseValue(p, indent, kv.rest, line.no);
  }
  return stamp(out, startLine, keyLines);
}

function parseSeq(p, indent) {
  const out = [];
  const startLine = peek(p)?.no ?? 0;
  for (;;) {
    skipIgnorable(p);
    if (p.i >= p.lines.length) break;
    const line = p.lines[p.i];
    const ind = indentOf(line.raw, line.no);
    if (ind < indent) break;
    if (ind > indent) throw new YamlError("unexpected indentation in sequence", line.no);
    const content = line.raw.slice(ind);
    if (!/^-(\s|$)/.test(content)) break;
    const after = content.slice(1);
    const trimmed = after.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      p.i++;
      const next = peek(p);
      const nextInd = next ? indentOf(next.raw, next.no) : -1;
      out.push(next && nextInd > indent ? parseBlock(p, nextInd) : null);
      continue;
    }
    const lead = after.length - after.trimStart().length;
    const itemIndent = indent + 1 + lead;
    if (splitKey(trimmed, line.no)) {
      // Compact map: re-present this line as if the map started at the item column, then let
      // parseMap consume it plus every sibling key at that same column.
      p.lines[p.i] = { raw: " ".repeat(itemIndent) + trimmed, no: line.no };
      out.push(parseMap(p, itemIndent));
    } else if (/^[|>]/.test(trimmed)) {
      p.i++;
      out.push(parseBlockScalar(p, indent, trimmed, line.no));
    } else {
      p.i++;
      out.push(parseInline(trimmed, line.no));
    }
  }
  return stamp(out, startLine);
}

function parseBlock(p, indent) {
  skipIgnorable(p);
  if (p.i >= p.lines.length) return null;
  const line = p.lines[p.i];
  if (indentOf(line.raw, line.no) < indent) return null;
  return /^-(\s|$)/.test(line.raw.slice(indent)) ? parseSeq(p, indent) : parseMap(p, indent);
}

/**
 * Parse a whole workflow document. Throws `YamlError` on anything unmodelled — callers MUST treat
 * that as a policy failure, never as a skip.
 * @param {string} text
 * @returns {object} the top-level mapping (with `$line`/`$keyLines` provenance)
 */
export function parseWorkflowYaml(text) {
  const lines = text.split(/\r?\n/).map((raw, idx) => ({ raw, no: idx + 1 }));
  const p = { lines, i: 0, sawDocStart: false };
  skipIgnorable(p);
  if (p.i >= lines.length) return stamp({}, 1, {});
  const node = parseBlock(p, indentOf(lines[p.i].raw, lines[p.i].no));
  skipIgnorable(p);
  if (p.i < lines.length)
    throw new YamlError(`unconsumed content: ${lines[p.i].raw.trim()}`, lines[p.i].no);
  if (node === null || Array.isArray(node) || typeof node !== "object")
    throw new YamlError("a workflow file must be a top-level mapping", 1);
  return node;
}

/**
 * Depth-first walk of every string scalar in a parsed document, carrying the nearest known line and
 * a dotted path. This is how every rule gets its `file:line` evidence.
 * @returns {Generator<{ value: string, line: number, path: string }>}
 */
export function* walkScalars(node, path = "", line = 0) {
  if (typeof node === "string") {
    yield { value: node, line, path };
    return;
  }
  if (Array.isArray(node)) {
    for (const [idx, item] of node.entries()) {
      yield* walkScalars(item, `${path}[${idx}]`, item?.$line ?? line);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const keyLine = node.$keyLines?.[key] ?? node.$line ?? line;
      yield* walkScalars(value, path ? `${path}.${key}` : key, keyLine);
    }
  }
}
