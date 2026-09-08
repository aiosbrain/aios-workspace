import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { isDeepStrictEqual } from "node:util";
import { MCP_SERVER_KEY } from "./mcp-hosts.mjs";

const BEGIN = "# BEGIN AIOS MCP INSTALLER\n";
const END = "# END AIOS MCP INSTALLER\n";
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function readHostDocument(text, host) {
  let document;
  try {
    document =
      text === null
        ? {}
        : host.formatAdapter === "toml"
          ? parseToml(text, { integersAsBigInt: true })
          : JSON.parse(text);
  } catch {
    throw new Error(`${host.label}: malformed ${host.formatAdapter.toUpperCase()} configuration`);
  }
  if (
    !object(document) ||
    (document[host.serverKeyPath] !== undefined && !object(document[host.serverKeyPath]))
  )
    throw new Error(`${host.label}: invalid server map`);
  return document;
}

// TOML is validated as a complete document; only our exact marked block is replaced.
// This preserves unrelated comments, numbers, dates, tables and credentials byte-for-byte.
export function editHostDocument(text, host, entry, previousBlock = null) {
  const document = readHostDocument(text, host);
  const expected = { ...document, [host.serverKeyPath]: { ...document[host.serverKeyPath] } };
  if (entry) expected[host.serverKeyPath][MCP_SERVER_KEY] = entry;
  else delete expected[host.serverKeyPath][MCP_SERVER_KEY];
  if (host.formatAdapter === "json")
    return { text: JSON.stringify(expected, null, 2) + "\n", block: null };
  let base = text || "";
  if (previousBlock !== null) {
    const index = base.indexOf(previousBlock);
    if (index < 0 || base.indexOf(previousBlock, index + 1) >= 0)
      throw new Error(`${host.label}: installer block was edited`);
    base = base.slice(0, index) + base.slice(index + previousBlock.length);
  } else if (base.includes(BEGIN.trim()) || base.includes(END.trim()))
    throw new Error(`${host.label}: unowned installer marker`);
  const block = entry
    ? BEGIN + stringifyToml({ [host.serverKeyPath]: { [MCP_SERVER_KEY]: entry } }) + END
    : null;
  const result = base + (base && !base.endsWith("\n") ? "\n" : "") + (block || "");
  const actual = readHostDocument(result, host);
  // An absent empty server table is equivalent after removing the last owned entry.
  if (!Object.keys(expected[host.serverKeyPath]).length && !actual[host.serverKeyPath])
    delete expected[host.serverKeyPath];
  if (!isDeepStrictEqual(actual, expected))
    throw new Error(
      `${host.label}: configuration cannot be changed without altering unrelated values`
    );
  return { text: result, block };
}
