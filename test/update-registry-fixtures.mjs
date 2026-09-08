import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const BUILD_SHA = "b".repeat(40);

export function fakeRegistryRoot({ version = "2.0.0", sha = BUILD_SHA, rules = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "regroot-"));
  mkdirSync(path.join(dir, "scaffold", "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "scaffold", ".claude", "rules"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "toolkit-manifest.mjs"), "// marker\n");
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@aiosbrain/aios", version })
  );
  writeFileSync(path.join(dir, "build.json"), JSON.stringify({ sha, version }));
  writeFileSync(path.join(dir, "scaffold", "scripts", "aios.mjs"), "// shim v2\n");
  const allRules = { "one.md": "rule one v1\nshared tail\n", ...rules };
  for (const [name, content] of Object.entries(allRules)) {
    writeFileSync(path.join(dir, "scaffold", ".claude", "rules", name), content);
  }
  // docs/brain-api.md so toolkitMeta can read a brain-api version.
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "brain-api.md"), "**Version: 1.24**\n");
  return { dir, root: { dir, kind: "registry", version, sha } };
}

export function fakeWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "regws-"));
  writeFileSync(path.join(dir, "aios.yaml"), "owner: t\npm_tool: none\n");
  return dir;
}
