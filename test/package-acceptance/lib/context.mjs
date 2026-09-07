/**
 * AIO-1071 package-acceptance cell context: the one place that constructs child
 * environments (explicit allowlist, empty HOME, engine-strict), records every command
 * as redacted evidence, scans raw output for seeded secret sentinels, and verifies the
 * candidate artifact digest before anything installs it.
 *
 * Design rules (CLI-RESET-5):
 *  - No cell packs its own tarball — the manifest + digest produced by pack.mjs is the
 *    only acceptable input, and the SHA-256 is re-verified here before install.
 *  - Semantic assertions only: a bare exit code is never accepted as proof of success,
 *    and unknown non-zero exits fail the run (fail closed).
 *  - Raw stdout/stderr is scanned for sentinels BEFORE redaction; the evidence file
 *    only ever stores redacted text.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { redact, registerSecretSentinel } from "../../helpers/scrubbed-env.mjs";

/** Synthetic secret sentinels seeded into harness env/config. NEVER real credentials. */
export const SENTINELS = Object.freeze({
  linearKey: "lin_api_sentinel_aio1071_never_print_4f217c",
  slackToken: "xoxp-sentinel-aio1071-never-print-88d1e2",
  aiosKey: "aios_k_sentinel_aio1071_never_print_b3309a",
});

/** Environment names allowed to pass from the runner into any child process. */
export const ALLOWED_ENV_KEYS = Object.freeze([
  "PATH",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

/** Runtime helpers a cell's PATH may contain; anything else on PATH is not consulted. */
export const FORBIDDEN_PATH_TOOLS = Object.freeze(["python3", "python", "jq", "dotenvx", "direnv"]);

export const sha256Hex = (buffer) => createHash("sha256").update(buffer).digest("hex");

export function scanTextForSentinels(text, sentinels = SENTINELS) {
  const hits = [];
  for (const [name, value] of Object.entries(sentinels)) {
    if (String(text).includes(value)) hits.push(name);
  }
  return hits;
}

/** Fail if any binary named in FORBIDDEN_PATH_TOOLS is reachable from `pathValue`. */
export function probeForbiddenPathTools(pathValue) {
  const found = [];
  for (const dir of String(pathValue).split(path.delimiter).filter(Boolean)) {
    for (const tool of FORBIDDEN_PATH_TOOLS) {
      if (existsSync(path.join(dir, tool))) found.push(path.join(dir, tool));
    }
  }
  return found;
}

/** Symlinks under `nodeModulesDir` whose target escapes `containRoot` (npm-link probe). */
export function findEscapingLinks(nodeModulesDir, containRoot) {
  const escapes = [];
  const rootReal = realpathSync(containRoot);
  const visit = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      let stat;
      try {
        stat = lstatSync(p);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        try {
          const real = realpathSync(p);
          if (!real.startsWith(`${rootReal}${path.sep}`) && real !== rootReal) escapes.push(p);
        } catch {
          escapes.push(p);
        }
      } else if (stat.isDirectory() && (entry.name.startsWith("@") || depth < 2)) {
        visit(p, depth + 1);
      }
    }
  };
  visit(nodeModulesDir, 0);
  return escapes;
}

export class CellContext {
  constructor({ artifactDir, evidenceDir, checkoutRoot, base }) {
    this.artifactDir = artifactDir;
    this.evidenceDir = evidenceDir;
    this.checkoutRoot = checkoutRoot;
    this.base = base;
    this.home = path.join(base, "home");
    mkdirSync(this.home, { recursive: true });
    mkdirSync(evidenceDir, { recursive: true });
    this.nodeOnlyPath = path.dirname(process.execPath);
    this.commands = [];
    this.sections = {};
    this.sentinelHits = [];
    for (const value of Object.values(SENTINELS)) registerSecretSentinel(value);
    this.manifest = JSON.parse(readFileSync(path.join(artifactDir, "manifest.json"), "utf8"));
    this.tarball = path.join(artifactDir, this.manifest.tarball);
  }

  /** Re-verify the pack job's digest; the install input is the digest, not the filename. */
  verifyArtifactDigest() {
    const actual = sha256Hex(readFileSync(this.tarball));
    if (actual !== this.manifest.sha256) {
      throw new Error(
        `artifact digest mismatch: manifest ${this.manifest.sha256} != tarball ${actual}`
      );
    }
    return actual;
  }

  /** Explicit allowlisted child environment (empty HOME, engine-strict, no ambient creds). */
  env(extra = {}) {
    const env = { CI: "1", NO_COLOR: "1", npm_config_engine_strict: "true" };
    for (const key of ALLOWED_ENV_KEYS) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.HOME = this.home;
    env.USERPROFILE = this.home;
    return { ...env, ...extra };
  }

  /** Node-only PATH environment for driving the installed CLI. */
  cliEnv(extra = {}) {
    return this.env({ PATH: this.nodeOnlyPath, ...extra });
  }

  /**
   * Run a command, record it as evidence (redacted), and scan RAW output for sentinels.
   * Non-zero exits throw unless `expectFailure` is set — unknown errors fail closed.
   *
   * DEFAULT environment is the ISOLATED node-only-PATH cliEnv(): a caller that omits
   * `env` gets the environment the isolation probes actually verified, so the installed
   * CLI can never quietly reach ambient python/jq/dotenvx/checkout tooling. Steps that
   * genuinely need the runner's toolchain (npm, bash, git) must say so by calling
   * runWithAmbientEnv().
   */
  run(cmd, args, opts = {}) {
    const { expectFailure = false, label = null, ...execOpts } = opts;
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let status = 0;
    let spawnError = null;
    try {
      stdout = execFileSync(cmd, args, {
        encoding: "utf8",
        ...execOpts,
        env: execOpts.env ?? this.cliEnv(),
      });
    } catch (error) {
      status = error.status ?? 1;
      stdout = error.stdout ?? "";
      stderr = error.stderr ?? "";
      spawnError = error.code ?? null;
      if (!expectFailure) {
        this.recordCommand({ cmd, args, status, stdout, stderr, label, started, spawnError });
        throw new Error(
          `command failed (exit ${status}${spawnError ? `, ${spawnError}` : ""}): ` +
            `${cmd} ${args.join(" ")}\n${redact(`${stdout}${stderr}`)}`
        );
      }
    }
    this.recordCommand({ cmd, args, status, stdout, stderr, label, started, spawnError });
    return { stdout, stderr, status, spawnError };
  }

  /**
   * Explicit opt-in for harness plumbing that needs the runner's full (allowlisted)
   * toolchain PATH — npm installs, bash scaffold/validators. Never for the installed
   * CLI itself. `envExtra` merges on top of the allowlisted ambient environment.
   */
  runWithAmbientEnv(cmd, args, opts = {}) {
    const { envExtra = {}, ...rest } = opts;
    return this.run(cmd, args, { ...rest, env: this.env(envExtra) });
  }

  recordCommand({ cmd, args, status, stdout, stderr, label, started, spawnError }) {
    for (const hit of scanTextForSentinels(`${stdout}\n${stderr}`)) {
      this.sentinelHits.push({ sentinel: hit, command: redact(`${cmd} ${args.join(" ")}`) });
    }
    this.commands.push({
      label,
      argv: [cmd, ...args].map((a) => redact(a)),
      status,
      spawnError,
      durationMs: Date.now() - started,
      stdout: redact(String(stdout)).slice(0, 4000),
      stderr: redact(String(stderr)).slice(0, 4000),
    });
  }

  record(section, data) {
    this.sections[section] = data;
  }

  writeEvidence(extra = {}) {
    const evidence = {
      schemaVersion: 1,
      issue: "AIO-1071",
      candidateSha: this.manifest.candidateSha,
      tarballSha256: this.manifest.sha256,
      packageName: this.manifest.packageName,
      packageVersion: this.manifest.packageVersion,
      dependencies: this.manifest.dependencies,
      cell: { node: process.version, platform: process.platform, arch: process.arch },
      sections: this.sections,
      sentinelHits: this.sentinelHits,
      commands: this.commands,
      ...extra,
    };
    const file = path.join(this.evidenceDir, "evidence.json");
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
    return file;
  }
}
