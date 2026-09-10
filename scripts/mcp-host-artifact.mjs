import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { MCP_PACKAGE_VERSION } from "./mcp-hosts.mjs";

// Published and independently accepted AIO-1164 artifact. Updating the version
// requires updating this integrity and repeating package acceptance.
export const MCP_PACKAGE_INTEGRITY =
  "sha512-6IDfKK/Ml7eMrzhO1JLrkGh8XbeWqJXlxHaJ90o8TIN0yrI5ipFZTcBN14/yq9gxAht5LKO5fZ+q3rFamnoXBg==";
const files = [
  "LICENSE",
  "package.json",
  "README.md",
  "bin/aios-brain-mcp.mjs",
  "lib/packages/foundation/src/brain-client.mjs",
  "lib/scripts/brain-client.mjs",
  "lib/packages/foundation/src/internal/brain-origin.mjs",
  "lib/packages/mcp-core/capabilities.mjs",
  "lib/packages/foundation/src/internal/flat-yaml.mjs",
  "lib/scripts/flat-yaml.mjs",
  "lib/packages/mcp-core/index.mjs",
  "lib/scripts/mcp-config.mjs",
  "lib/scripts/mcp-credentials.mjs",
  "lib/scripts/mcp-runtime.mjs",
  "lib/scripts/mcp-stdio.mjs",
];

export function installedServerCommand({ node = process.execPath, home = os.homedir() } = {}) {
  return {
    command: node,
    args: [
      path.join(home, ".aios", "mcp", MCP_PACKAGE_VERSION, "bin/aios-brain-mcp.mjs"),
      "--toolsets",
      "brain,board",
    ],
  };
}

export function decodeServerArtifact(compressed) {
  const integrity = `sha512-${createHash("sha512").update(compressed).digest("base64")}`;
  if (integrity !== MCP_PACKAGE_INTEGRITY) throw new Error("MCP package integrity mismatch");
  const tar = gunzipSync(compressed, { maxOutputLength: 1024 * 1024 });
  const result = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) => {
      const bytes = header.subarray(start, end);
      const terminator = bytes.indexOf(0);
      return bytes.subarray(0, terminator < 0 ? bytes.length : terminator).toString("utf8");
    };
    const name = field(0, 100);
    const size = Number.parseInt(field(124, 136).trim(), 8);
    const relative = name.startsWith("package/") ? name.slice(8) : "";
    if (
      !files.includes(relative) ||
      result.has(relative) ||
      !["", "0"].includes(field(156, 157)) ||
      field(345, 500) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length
    )
      throw new Error("Unexpected MCP package archive entry");
    result.set(relative, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (result.size !== files.length) throw new Error("Incomplete MCP package closure");
  const manifest = JSON.parse(result.get("package.json").toString("utf8"));
  if (
    manifest.name !== "@aiosbrain/mcp" ||
    manifest.version !== MCP_PACKAGE_VERSION ||
    Object.keys(manifest.dependencies || {}).length ||
    manifest.scripts
  )
    throw new Error("Unexpected MCP package manifest");
  return result;
}

export async function prepareServerArtifact({ home, policy, fetchImpl = fetch }) {
  const root = path.join(home, ".aios", "mcp", MCP_PACKAGE_VERSION);
  // Preflight every destination before network access or any mutation.
  const sources = new Map(
    files.map((name) => [name, policy.snapshot(path.join(root, name), { privateFile: true })])
  );
  for (const source of sources.values()) policy.writable(source);
  const response = await fetchImpl(
    `https://registry.npmjs.org/@aiosbrain/mcp/-/mcp-${MCP_PACKAGE_VERSION}.tgz`,
    { redirect: "error", signal: AbortSignal.timeout(30000) }
  );
  if (!response.ok || !response.body) throw new Error("MCP package download failed");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("MCP package download exceeds its size limit");
    chunks.push(chunk);
  }
  const artifact = decodeServerArtifact(Buffer.concat(chunks));
  return [...artifact].map(([name, bytes]) => {
    const source = sources.get(name);
    if (source.bytes !== null && !source.bytes.equals(bytes))
      throw new Error(`MCP package file was edited: ${source.file}`);
    return { source, bytes };
  });
}
