// Writer stays in the CLI; the builtin-only reader is shared with standalone MCP.
export * from "../user-config-reader.mjs";
import { readUserConfig, parseUserConfig } from "../user-config-reader.mjs";
import { atomicWrite } from "./atomic-file.mjs";
export async function writeUserConfig(configPath, nextKnown, options = {}) {
  const current = await readUserConfig(configPath, options);
  const document = {
    ...(current.unknown ?? {}),
    ...(current.known ?? {}),
    ...nextKnown,
    schemaVersion: 2,
  };
  parseUserConfig(JSON.stringify(document));
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  await atomicWrite(configPath, serialized, options);
  return { path: configPath, document, serialized };
}
