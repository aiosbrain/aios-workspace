/**
 * Upgrade from a profile the 0.1.1 installer left behind (AIO-1112). The legacy state is
 * synthesized to that installer's record schema for a JSON host (Cursor): its ownership
 * record, its recorded entry and its artifact directory. The upgrade itself is the real
 * installed CLI: download, native writes, server verification.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as S from "./mcp-support.mjs";

const json = (stdout) => JSON.parse(stdout.slice(stdout.indexOf("{")));
const read = (file) => readFileSync(file, "utf8");

/** A profile as the 0.1.1 installer left it: its record schema, its entry, its artifact dir. */
export async function legacyUpgrade(ctx, state, brain, { VERSION, TEAM }) {
  const cases = {};
  for (const variant of ["owned", "edited"]) {
    const home = S.makeDir(path.join(state.root, `legacy-${variant}`, "home"), state.root);
    const project = S.makeDir(path.join(home, "project"), state.root);
    const cursor = state.targets(home, project).find((host) => host.id === "cursor");
    const legacyServer = path.join(home, ".aios", "mcp", "0.1.1", "bin", "aios-brain-mcp.mjs");
    const entry = {
      type: "stdio",
      command: process.execPath,
      args: [legacyServer, "--toolsets", "brain,board"],
      env: { AIOS_MCP_INSTALLER: "aios-mcp-v1:0f8b6d1e-acce-4a11-9b2f-legacy0000001" },
    };
    S.put(legacyServer, "// 0.1.1 server placeholder: never executed by this journey\n", home);
    S.put(
      path.join(home, ".aios", "mcp-installations.json"),
      `${JSON.stringify({ version: 1, installations: [{ host: "cursor", file: cursor.file, entry, block: null }] }, null, 2)}\n`,
      home
    );
    const live = structuredClone(entry);
    if (variant === "edited") live.args.push("--edited-by-user");
    S.put(
      cursor.file,
      `${JSON.stringify({ mcpServers: { "aios-brain": live } }, null, 2)}\n`,
      home
    );
    const before = S.tree(home);
    const result = S.cli(ctx, state, ["mcp", "install", "--host", "cursor"], {
      ...{
        home,
        cwd: project,
        processes: S.UNRELATED_PROCESSES,
        label: `mcp-upgrade-legacy-${variant}`,
      },
      env: { AIOS_BRAIN_URL: brain.origin, AIOS_API_KEY: S.KEYS.team },
      expectFailure: variant === "edited",
    });
    if (variant === "edited") {
      assert.equal(result.status, 5);
      assert.match(result.stderr, /refusing to overwrite an edited or unowned aios-brain entry/);
      assert.deepEqual(S.tree(home), before, "an edited 0.1.1 entry is left exactly as found");
      cases.edited = "refused AIOS_E_CONFLICT, untouched";
      continue;
    }
    const upgraded = json(result.stdout);
    assert.equal(upgraded.changes[0].action, "install");
    assert.deepEqual([...upgraded.command_verification[0].tools].sort(), TEAM);
    const now = JSON.parse(read(cursor.file)).mcpServers["aios-brain"];
    assert.equal(
      now.args[0],
      path.join(home, ".aios", "mcp", VERSION, "bin", "aios-brain-mcp.mjs")
    );
    assert.equal(
      now.env.AIOS_MCP_INSTALLER,
      entry.env.AIOS_MCP_INSTALLER,
      "ownership marker carried over"
    );
    const records = JSON.parse(read(path.join(home, ".aios", "mcp-installations.json")));
    assert.deepEqual(records.installations, [
      { host: "cursor", file: cursor.file, entry: now, block: null },
    ]);
    const legacyKey = path.relative(home, legacyServer);
    assert.deepEqual(
      S.tree(home)[legacyKey],
      before[legacyKey],
      "the 0.1.1 artifact is left intact"
    );
    cases.owned = "upgraded to 0.2.1, record rewritten, 0.1.1 artifact intact";
  }
  return cases;
}
