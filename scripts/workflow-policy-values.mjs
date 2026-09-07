/** Bounded expression recognizer. No calls, operators or computed indexing are evaluated. */
const SAFE_PATHS = new Set([
  "github.event.pull_request.base.sha",
  "github.event.pull_request.base.ref",
  "github.event.repository.default_branch",
  "github.event_name",
]);
const IDENT = /^[a-z_][\w-]*/i;
const STRING = /^(?:'(?:[^']|'')*'|"[^"\\]*")/;
const rank = { safe: 0, unknown: 1, tainted: 2 };
export const strongest = (a, b) => (rank[a] >= rank[b] ? a : b);

/** Consume exactly one dot/literal-bracket path, retaining the unconsumed suffix. */
function readPath(text) {
  const root = text.match(IDENT)?.[0];
  if (!root) return null;
  const parts = [root.toLowerCase()];
  let rest = text.slice(root.length);
  for (;;) {
    const dot = rest.match(/^\s*\.\s*([a-z_][\w-]*)/i);
    const bracket = rest.match(/^\s*\[\s*('(?:[^']|'')*'|"[^"\\]*")\s*\]/);
    if (!dot && !bracket) break;
    parts.push((dot ? dot[1] : bracket[1].slice(1, -1).replaceAll("''", "'")).toLowerCase());
    rest = rest.slice((dot ?? bracket)[0].length);
  }
  return { parts, rest };
}

function pathValue(parts, resolveEnv) {
  const key = parts.join(".");
  if (SAFE_PATHS.has(key)) return "safe";
  if ([...SAFE_PATHS].some((safe) => key.startsWith(`${safe}.`))) return "unknown";
  if (parts[0] === "secrets") return "tainted";
  if (parts[0] === "github" && (parts.length === 1 || ["event", "head_ref"].includes(parts[1])))
    return "tainted";
  if (parts[0] === "env" && parts.length === 2) return resolveEnv(parts[1]);
  return "unknown";
}

/** Preserve known references even inside unsupported expressions; strings are opaque literals. */
function knownReferences(text, resolveEnv) {
  let result = "unknown";
  while (text.length) {
    const literal = text.match(STRING)?.[0];
    if (literal) {
      text = text.slice(literal.length);
      continue;
    }
    const path = readPath(text);
    if (path) {
      if (!(path.parts.length === 1 && path.parts[0] === "github"))
        result = strongest(result, pathValue(path.parts, resolveEnv));
      text = path.rest;
    } else text = text.slice(1);
  }
  return result;
}

export function classifyExpression(raw, resolveEnv = () => "unknown") {
  const text = raw.trim();
  // Literal scalars are the only non-path expressions accepted. A fully consuming match
  // prevents a safe prefix (base.sha + unsupported suffix) from conferring trust.
  if (/^(?:true|false|null|-?(?:0x[\da-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?))$/i.test(text))
    return "safe";
  const literal = text.match(STRING)?.[0];
  if (literal === text && literal !== undefined) return "safe";
  const path = readPath(text);
  if (path && path.rest.trim() === "") return pathValue(path.parts, resolveEnv);
  return knownReferences(text, resolveEnv);
}

export function classifyValue(value, resolveEnv = () => "unknown") {
  if (value === null || ["boolean", "number"].includes(typeof value)) return "safe";
  if (typeof value !== "string") return "unknown";
  let status = "safe";
  let rest = value;
  for (;;) {
    const start = rest.indexOf("${{");
    if (start < 0) return status;
    const end = rest.indexOf("}}", start + 3);
    if (end < 0) return strongest(status, "unknown");
    status = strongest(status, classifyExpression(rest.slice(start + 3, end), resolveEnv));
    rest = rest.slice(end + 2);
  }
}

/** Scope snapshots preserve shadowing; DFS makes missing definitions and cycles unknown. */
export function environmentValues(env, inherited = new Map()) {
  const definitions = new Map(
    env && typeof env === "object" && !Array.isArray(env)
      ? Object.entries(env).map(([key, value]) => [key.toLowerCase(), value])
      : []
  );
  const values = new Map(inherited);
  for (const key of definitions.keys()) values.delete(key);
  const visiting = new Set();
  const resolve = (key) => {
    if (values.has(key)) return values.get(key);
    if (!definitions.has(key) || visiting.has(key)) return "unknown";
    visiting.add(key);
    const status = classifyValue(definitions.get(key), resolve);
    visiting.delete(key);
    values.set(key, status);
    return status;
  };
  for (const key of definitions.keys()) resolve(key);
  return values;
}
