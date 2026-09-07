import { mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";

export const MCP_SOURCE_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
// Explicit transitive dependency closure. New dependencies require a reviewed change here.
export const MCP_MODULES = Object.freeze([
  "scripts/mcp-runtime.mjs",
  "scripts/mcp-stdio.mjs",
  "scripts/mcp-config.mjs",
  "scripts/mcp-credentials.mjs",
  "scripts/brain-client.mjs",
  "scripts/flat-yaml.mjs",
  "packages/mcp-core/index.mjs",
  "packages/mcp-core/capabilities.mjs",
  "packages/foundation/src/brain-client.mjs",
  "packages/foundation/src/internal/brain-origin.mjs",
  "packages/foundation/src/internal/flat-yaml.mjs",
]);
export const MCP_PACK_INPUTS = Object.freeze([
  ...MCP_MODULES,
  "packages/mcp/package.json",
  "packages/mcp/bin/aios-brain-mcp.mjs",
  "packages/mcp/README.md",
  "LICENSE",
  "packages/mcp-build/build.mjs",
  "packages/mcp-build/pack.mjs",
]);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function assertMcpClosure(modules = MCP_MODULES, root = MCP_SOURCE_ROOT) {
  const allowed = new Set(modules);
  for (const file of modules) {
    const source = readFileSync(path.join(root, file), "utf8");
    const syntax = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const imports = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(syntax) === "require")
      ) {
        throw new Error(`Dynamic module loading is outside the MCP closure: ${file}`);
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier))
          throw new Error(`Nonliteral MCP import: ${file}`);
        imports.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);
    for (const specifier of imports) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith("."))
        throw new Error(`External MCP dependency: ${file} -> ${specifier}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!allowed.has(resolved))
        throw new Error(`Unlisted MCP dependency: ${file} -> ${resolved}`);
    }
  }
}

export function buildMcpPackage(out, root = MCP_SOURCE_ROOT) {
  const target = path.resolve(out);
  if (target === root || !path.basename(target))
    throw new Error("MCP build requires a new output directory");
  assertMcpClosure(MCP_MODULES, root);
  mkdirSync(target, { recursive: false });
  const inventory = {};
  for (const source of MCP_MODULES) {
    const bytes = readFileSync(path.join(root, source));
    const destination = path.join(target, "lib", source);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    inventory[source] = sha256(bytes);
  }
  for (const [source, destination] of [
    ["packages/mcp/package.json", "package.json"],
    ["packages/mcp/README.md", "README.md"],
    ["LICENSE", "LICENSE"],
    ["packages/mcp/bin/aios-brain-mcp.mjs", "bin/aios-brain-mcp.mjs"],
  ]) {
    mkdirSync(path.dirname(path.join(target, destination)), { recursive: true });
    copyFileSync(path.join(root, source), path.join(target, destination));
    inventory[source] = sha256(readFileSync(path.join(root, source)));
  }
  chmodSync(path.join(target, "bin/aios-brain-mcp.mjs"), 0o755);
  return inventory;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const i = process.argv.indexOf("--out");
  if (i < 0 || !process.argv[i + 1])
    throw new Error("Usage: node packages/mcp-build/build.mjs --out <new-directory>");
  console.log(JSON.stringify(buildMcpPackage(process.argv[i + 1]), null, 2));
}
