import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import * as pins from "./mcp-hosts.mjs";
import { deny } from "./mcp-profile-schema.mjs";
import { resolveDistributionRoot } from "./distribution-root.mjs";
import { verifyProfileArtifactReceipt } from "./mcp-artifact-receipt.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const STANDALONE_FILES = [
  "LICENSE",
  "package.json",
  "README.md",
  "bin/aios-brain-mcp.mjs",
  ...[
    "scripts/mcp-runtime.mjs",
    "scripts/mcp-stdio.mjs",
    "scripts/mcp-config.mjs",
    "scripts/mcp-credentials.mjs",
    "scripts/brain-client.mjs",
    "scripts/flat-yaml.mjs",
    "scripts/mcp-profile-binding.mjs",
    "scripts/mcp-artifact-receipt.mjs",
    "scripts/mcp-profile-schema.mjs",
    "scripts/mcp-profile-reference.mjs",
    "scripts/user-config-reader.mjs",
    "scripts/command-errors.mjs",
    "packages/mcp-core/index.mjs",
    "packages/mcp-core/capabilities.mjs",
    "packages/foundation/src/brain-client.mjs",
    "packages/foundation/src/internal/brain-origin.mjs",
    "packages/foundation/src/internal/flat-yaml.mjs",
  ].map((file) => `lib/${file}`),
];
const LIMIT = 128 * 1024 * 1024;
function archiveFiles(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: LIMIT }),
    files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((v) => v === 0)) break;
    const field = (a, b) => header.subarray(a, b).toString("utf8").split("\0")[0];
    const prefix = field(345, 500),
      name = [prefix, field(0, 100)].filter(Boolean).join("/");
    const size = Number.parseInt(field(124, 136).trim(), 8),
      relative = name.startsWith("package/") ? name.slice(8) : "";
    if (
      !relative ||
      relative.includes("\\") ||
      relative.split("/").some((p) => !p || p === "." || p === "..") ||
      !["", "0"].includes(field(156, 157)) ||
      files.has(relative) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length
    )
      deny("UNAVAILABLE", "Package archive contains an unsupported entry.");
    files.set(relative, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
async function readArtifact(mode, input, fetchImpl) {
  // Release pins remain unavailable until publication; tests supply a digest-verified pack tuple.
  const descriptor = input || pins.MCP_PROFILE_RELEASES?.[mode];
  if (!descriptor || descriptor.profileVersion !== "1.0.0")
    deny(
      "UNAVAILABLE",
      "A published profile-capable artifact is not configured yet. Existing read-only installations are unchanged."
    );
  const packageName = mode === "workspace" ? "@aiosbrain/aios" : "@aiosbrain/mcp";
  if (
    descriptor.packageName !== packageName ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(descriptor.packageVersion)
  )
    deny("UNAVAILABLE");
  let bytes = descriptor.tarball;
  if (!bytes) {
    const short = packageName.split("/")[1];
    const response = await fetchImpl(
      `https://registry.npmjs.org/${packageName}/-/${short}-${descriptor.packageVersion}.tgz`,
      { redirect: "error", signal: AbortSignal.timeout(30000) }
    );
    if (!response.ok || !response.body) deny("UNAVAILABLE");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMIT) deny("UNAVAILABLE");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT || integrity(bytes) !== descriptor.integrity)
    deny("UNAVAILABLE", "Package artifact integrity verification failed.");
  const files = archiveFiles(bytes),
    manifest = JSON.parse(files.get("package.json")?.toString() || "null");
  if (manifest?.name !== packageName || manifest.version !== descriptor.packageVersion)
    deny("UNAVAILABLE");
  if (
    mode === "brain-only" &&
    (files.size !== STANDALONE_FILES.length || STANDALONE_FILES.some((file) => !files.has(file)))
  )
    deny("UNAVAILABLE", "Standalone package closure differs from the accepted profile reader.");
  if (
    mode === "brain-only" &&
    (Object.keys(manifest.dependencies || {}).length || manifest.scripts)
  )
    deny("UNAVAILABLE");
  if (
    !files.has(
      mode === "workspace"
        ? "scripts/mcp-profile-binding.mjs"
        : "lib/scripts/mcp-profile-binding.mjs"
    )
  )
    deny("UNAVAILABLE", "The selected package cannot resolve connection profiles.");
  return { descriptor, bytes, files, manifest };
}
function npmCli() {
  const bin = path.dirname(process.execPath);
  const candidates = [
    path.join(bin, "node_modules/npm/bin/npm-cli.js"),
    path.join(bin, "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  for (const file of candidates) if (fs.existsSync(file)) return fs.realpathSync(file);
  deny(
    "UNAVAILABLE",
    "The installed Node runtime has no trusted npm entrypoint. Install Node with npm before explicit toolkit setup."
  );
}
export async function prepareProfileArtifact({
  mode,
  profileId,
  home,
  policy,
  dryRun = false,
  artifactInput,
  configDir,
  fetchImpl = fetch,
}) {
  const { descriptor, bytes, files, manifest } = await readArtifact(mode, artifactInput, fetchImpl);
  const directory = path.join(home, ".aios", "mcp", mode, descriptor.packageVersion, hash(bytes));
  const packageRoot =
    mode === "workspace"
      ? path.join(directory, "node_modules", "@aiosbrain", "aios")
      : path.join(directory, "package");
  const entrypoint = mode === "workspace" ? "scripts/brain-mcp.mjs" : "bin/aios-brain-mcp.mjs";
  const receiptPath = path.join(directory, "receipt.json");
  const receipt = {
    version: 1,
    packageName: manifest.name,
    packageVersion: manifest.version,
    integrity: descriptor.integrity,
    packageRoot,
    entrypoint,
    hashes: {
      "package.json": hash(files.get("package.json")),
      [entrypoint]: hash(files.get(entrypoint)),
    },
  };
  const command = {
    command: process.execPath,
    args: [
      path.join(packageRoot, entrypoint),
      "--profile",
      profileId,
      ...(configDir ? ["--config-dir", configDir] : []),
      "--artifact-receipt",
      receiptPath,
      "--toolsets",
      "brain,board",
    ],
  };
  const existing = policy.snapshot(receiptPath, { privateFile: true });
  if (existing.bytes) {
    verifyProfileArtifactReceipt(receiptPath);
    return {
      command,
      artifactReceipt: receipt,
      expectedServer: { version: manifest.version },
      stagedChanges: [],
    };
  }
  if (fs.existsSync(directory))
    deny("UNAVAILABLE", "An incomplete profile artifact exists; inspect it before retrying setup.");
  if (dryRun)
    return {
      command,
      artifactReceipt: receipt,
      expectedServer: { version: manifest.version },
      stagedChanges: [],
    };
  const parent = path.dirname(directory);
  policy.snapshot(path.join(parent, "preflight"), { privateFile: true });
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = path.join(parent, `.prepare-${randomUUID()}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  if (policy.platform === "win32") policy.secure(stage);
  const stageIdentity = fs.lstatSync(stage);
  try {
    if (mode === "brain-only") {
      for (const [relative, content] of files) {
        const file = path.join(stage, "package", relative);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, content, { mode: 0o600 });
      }
    } else {
      const tarball = path.join(stage, "candidate.tgz");
      fs.writeFileSync(tarball, bytes, { mode: 0o600 });
      const config = path.join(stage, "npmrc");
      fs.writeFileSync(config, "", { mode: 0o600 });
      const env = {
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
        HOME: stage,
        USERPROFILE: stage,
        npm_config_engine_strict: "true",
        npm_config_registry: "https://registry.npmjs.org",
        npm_config_userconfig: config,
        npm_config_globalconfig: path.join(stage, "global-npmrc"),
        npm_config_cache: path.join(stage, "cache"),
      };
      if (process.platform === "win32") {
        env.APPDATA = path.join(stage, "AppData", "Roaming");
        env.LOCALAPPDATA = path.join(stage, "AppData", "Local");
        fs.mkdirSync(env.APPDATA, { recursive: true });
        fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
      }
      for (const key of [
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "NODE_EXTRA_CA_CERTS",
      ])
        if (process.env[key]) env[key] = process.env[key];
      try {
        execFileSync(
          process.execPath,
          [npmCli(), "install", tarball, "--omit=optional", "--no-audit", "--no-fund"],
          { cwd: stage, env, timeout: 300000, stdio: ["ignore", "pipe", "pipe"] }
        );
      } catch {
        deny(
          "UNAVAILABLE",
          "The verified toolkit dependency installation failed; no host entry was changed."
        );
      }
      const installed = path.join(stage, "node_modules", "@aiosbrain", "aios");
      if (resolveDistributionRoot(installed)?.kind !== "registry") deny("UNAVAILABLE");
      for (const dependency of Object.keys(manifest.dependencies || {})) {
        let found;
        for (let at = installed; at.startsWith(stage); at = path.dirname(at)) {
          const candidate = path.join(at, "node_modules", dependency, "package.json");
          if (fs.existsSync(candidate)) {
            found = fs.realpathSync(candidate);
            break;
          }
          if (at === stage) break;
        }
        if (!found || !found.startsWith(`${stage}${path.sep}`))
          deny("UNAVAILABLE", "An installed toolkit dependency escapes its prefix.");
      }
    }
    // Hash the actually installed entrypoint and manifest before activating this prefix.
    const stagedRoot =
      mode === "workspace"
        ? path.join(stage, "node_modules", "@aiosbrain", "aios")
        : path.join(stage, "package");
    for (const [relative, digest] of Object.entries(receipt.hashes))
      if (hash(fs.readFileSync(path.join(stagedRoot, relative))) !== digest) deny("UNAVAILABLE");
    if (policy.platform === "win32") {
      const secured = new Set();
      for (const relative of Object.keys(receipt.hashes)) {
        for (let at = path.join(stagedRoot, relative); ; at = path.dirname(at)) {
          if (secured.has(at)) break;
          policy.secure(at);
          secured.add(at);
          if (at === stage) break;
        }
      }
    }
    fs.writeFileSync(path.join(stage, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
    });
    policy.secure(path.join(stage, "receipt.json"));
    if (fs.existsSync(directory)) deny("UNAVAILABLE");
    fs.renameSync(stage, directory);
    verifyProfileArtifactReceipt(receiptPath);
  } finally {
    if (fs.existsSync(stage)) {
      const current = fs.lstatSync(stage);
      if (current.ino === stageIdentity.ino && current.dev === stageIdentity.dev)
        fs.rmSync(stage, { recursive: true });
    }
  }
  return {
    command,
    artifactReceipt: receipt,
    expectedServer: { version: manifest.version },
    stagedChanges: [],
  };
}
