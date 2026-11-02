import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { buildMcpPackage } from "../../packages/mcp-build/build.mjs";

/** A tar of the real builtin-only package closure, without registry access. */
export function profileArtifactFixture(root) {
  const directory = path.join(root, "package-build");
  buildMcpPackage(directory);
  const blocks = [];
  function visit(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relative + "/");
      else {
        const bytes = fs.readFileSync(path.join(dir, entry.name));
        const header = Buffer.alloc(512);
        header.write("package/" + relative, 0, 100);
        header.write("0000600\0", 100);
        header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
        header.write("0", 156);
        header.fill(32, 148, 156);
        const sum = header.reduce((a, b) => a + b, 0);
        header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
        blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
      }
    }
  }
  visit(directory);
  const tarball = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json")));
  return {
    profileVersion: "1.0.0",
    packageName: manifest.name,
    packageVersion: manifest.version,
    tarball,
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  };
}
