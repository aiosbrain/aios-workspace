import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Walk up from `dir` for a workspace root (aios.yaml | project.yaml | engagement.yaml). */
function findWorkspaceRoot(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    if (
      existsSync(path.join(cur, "aios.yaml")) ||
      existsSync(path.join(cur, "project.yaml")) ||
      existsSync(path.join(cur, "engagement.yaml"))
    )
      return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** Dynamic-import the compiled operator-loop core (shared with the CLI). */
async function loadOperatorLoop() {
  const distPath = path.join(MCP_DIR, "..", "dist", "operator-loop", "index.js");
  if (!existsSync(distPath)) {
    throw new Error("operator-loop is not built — run: npm run build:loop");
  }
  return import(pathToFileURL(distPath).href);
}

export async function workspaceHandler(args, _client, ctx) {
  const cwd = (ctx && ctx.cwd) || process.cwd();
  const repo = findWorkspaceRoot(cwd);
  if (!repo) {
    throw new Error(
      "no AIOS workspace found at the server's working directory (need aios.yaml/project.yaml/" +
        "engagement.yaml). Start the MCP server with its cwd set to a workspace."
    );
  }
  // Same identity resolution as the CLI so manifests are byte-identical across entry points.
  const { resolveLoopIdentity } = await import("./loop-config.mjs");
  const { member, project } = resolveLoopIdentity(repo);
  const loop = await loadOperatorLoop();
  const manifest = loop.collect({
    root: repo,
    cadence: args.cadence === "daily" ? "daily" : "weekly",
    member,
    project,
  });
  // Return the FULL manifest JSON — do NOT pass through asContent's 25k char cap, which would
  // truncate mid-JSON and break the consumer's JSON.parse (and parity with `aios loop --json`).
  return { content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }] };
}
