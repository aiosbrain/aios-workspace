import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// AIO-668: prove the @aiosbrain/aios npm package is repo-clone-independent — `npm pack`
// the toolkit, install the tarball into a clean prefix, and drive the golden path
// (help → scaffold → validate → offline status) from the INSTALLED location only.
//
// This performs a REAL `npm install` of the tarball's dependency tree against the live
// registry (network-dependent, minutes not seconds), so it is opt-in exactly like the
// GUI production-install smoke: the unit/coverage shards discover the file but skip it;
// the dedicated CI lane (and `npm run test:pack-golden`) sets the env flag.
const PACK_GOLDEN = process.env.AIOS_PACK_GOLDEN_TESTS === "1";

// Optional override so a human can point the working dir somewhere inspectable
// (e.g. a scratchpad); an overridden dir is left in place after the run.
const DIR_OVERRIDE = process.env.AIOS_PACK_GOLDEN_DIR || null;

/** Paths that MUST ship — the CLI's traced runtime surface. */
const REQUIRED_TARBALL_PATHS = [
  "package/package.json",
  "package/scripts/aios.mjs",
  "package/scripts/aios-runtime.mjs",
  "package/scripts/cli.mjs",
  "package/scripts/cli/bootstrap.mjs",
  "package/scripts/cli/config-broker.mjs",
  "package/scripts/cli/credential-broker.mjs",
  "package/scripts/cli/destination-policy.mjs",
  "package/scripts/cli/migration.mjs",
  "package/scripts/cli/doctor.mjs",
  "package/scripts/cli/provenance.mjs",
  "package/scripts/cli/linear-commands.mjs",
  "package/scripts/connectors.mjs",
  "package/scripts/connectors/linear/index.mjs",
  "package/scripts/linear.mjs",
  "package/scripts/scaffold-project.sh",
  "package/scripts/leak-gate.sh",
  "package/scaffold/aios.yaml.tmpl",
  "package/.claude/rubrics/spec-readiness.md",
  "package/docs/agentic-ergonomics/aios-issue-template.md",
  "package/validation/validate-all.sh",
  "package/validation/check-structure.sh",
  "package/hooks/team-ops-guard.sh",
  "package/docs/brain-api.md",
  "package/docs/devtools-migration.md",
  "package/docs/devtools-toolkit-contract.md",
  "package/docs/ENGINEERING-CONSTITUTION.md",
  // The scripts/* foundation shims re-export by RELATIVE path (../packages/foundation/src),
  // so the foundation sources must ride along inside the tarball.
  "package/packages/foundation/src/workspace-parse/index.mjs",
  "package/packages/foundation/src/brain-config.mjs",
  // Operator-loop workflow layer: shipped prebuilt because consumers install without
  // typescript (ensure-loop-built deliberately skips when tsc is absent).
  "package/dist/operator-loop/index.js",
];

/** Trees that must NOT ship (dev-only: GUI, Tauri, tests, examples, CI, TS sources). */
const FORBIDDEN_TARBALL_PREFIXES = [
  "package/gui/",
  "package/src-tauri/",
  "package/test/",
  "package/examples/",
  "package/evals/",
  "package/.github/",
  "package/src/",
];

const ALLOWED_ENV_KEYS = [
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
];
let isolatedHome = null;

function allowlistedEnv(extra = {}) {
  const env = { CI: "1", NO_COLOR: "1", npm_config_engine_strict: "true" };
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = isolatedHome ?? tmpdir();
  env.USERPROFILE = env.HOME;
  return { ...env, ...extra };
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    ...opts,
    env: allowlistedEnv(opts.env),
  });
}

test(
  "npm pack golden path: the installed @aiosbrain/aios CLI works without a repo clone",
  {
    timeout: 600_000,
    skip: PACK_GOLDEN ? false : "live tarball install — use npm run test:pack-golden",
  },
  async (t) => {
    const base = DIR_OVERRIDE ?? mkdtempSync(path.join(tmpdir(), "aios-pack-golden-"));
    if (DIR_OVERRIDE) mkdirSync(base, { recursive: true });
    isolatedHome = path.join(base, "home");
    mkdirSync(isolatedHome, { recursive: true });
    try {
      // 1. Pack the toolkit. dist/ must exist first (it ships prebuilt); npm ci's
      //    postinstall normally builds it, but self-heal here so a partial local
      //    checkout fails with the build error, not a confusing tarball assert.
      run(process.execPath, [path.join(ROOT, "scripts/ensure-loop-built.mjs"), "--quiet"], {
        cwd: ROOT,
      });
      const packOut = run("npm", ["pack", "--pack-destination", base], { cwd: ROOT });
      const tarball = path.join(base, packOut.trim().split("\n").at(-1));
      assert.ok(existsSync(tarball), `npm pack produced ${tarball}`);

      // 2. Tarball surface: everything the CLI reads at runtime, nothing dev-only.
      const listing = run("tar", ["-tzf", tarball]).split("\n");
      for (const required of REQUIRED_TARBALL_PATHS) {
        assert.ok(listing.includes(required), `tarball must ship ${required}`);
      }
      for (const forbidden of FORBIDDEN_TARBALL_PREFIXES) {
        const hit = listing.find((p) => p.startsWith(forbidden));
        assert.equal(hit, undefined, `tarball must not ship ${forbidden} (found ${hit})`);
      }

      // 2b. EVERY declared bin must be executable IN THE TARBALL. This is asserted against the
      //     archive's own recorded modes, not against node_modules/.bin, because npm may chmod
      //     while linking and would then paper over a non-executable file inside the artifact.
      //     `slack` and `linear` shipped mode 0644 in 0.11.1 — the bare commands died with
      //     "permission denied" for every install — and no repo-only test could see it, because
      //     in a checkout nobody runs them by bare name.
      const longListing = run("tar", ["-tvzf", tarball]).split("\n");
      const declaredBins = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).bin;
      for (const [binName, relPath] of Object.entries(declaredBins)) {
        const row = longListing.find((l) => l.endsWith(`package/${relPath}`));
        assert.ok(row, `tarball must ship the '${binName}' bin target ${relPath}`);
        assert.match(
          row,
          /^-rwxr-xr-x/,
          `bin '${binName}' (${relPath}) must be 0755 in the tarball, got: ${row.split(/\s+/)[0]}`
        );
      }

      // 3. Install into a clean prefix. --omit=optional skips the Claude native GUI
      //    binaries the CLI does not need; postinstall must survive that (warn-only).
      const prefix = path.join(base, "npm-cli-golden");
      mkdirSync(prefix, { recursive: true });
      writeFileSync(
        path.join(prefix, "package.json"),
        `${JSON.stringify({ name: "aios-pack-golden-fixture", private: true }, null, 2)}\n`
      );
      run("npm", ["install", tarball, "--omit=optional", "--no-audit", "--no-fund"], {
        cwd: prefix,
      });
      const pkgDir = path.join(prefix, "node_modules", "@aiosbrain", "aios");
      const bin = path.join(prefix, "node_modules", ".bin", "aios");
      assert.ok(existsSync(bin), "npm exposed the aios bin");

      // 4. `aios --help` from the installed bin (no repo clone anywhere in sight).
      const help = run(bin, ["--help"], { cwd: prefix });
      assert.match(help, /aios/i);
      assert.match(help, /status/);

      // 4a. The diagnostic/config foundation must run from the packed installation with an
      //     explicit environment allowlist. PATH contains Node only: no Python, jq, global
      //     dotenvx, source-checkout helpers, or ambient provider credentials can participate.
      const diagnosticConfig = path.join(base, "diagnostic-config");
      mkdirSync(diagnosticConfig, { recursive: true });
      writeFileSync(path.join(diagnosticConfig, "config.json"), "invalid config fixture\n");
      const nodeOnlyPath = path.dirname(process.execPath);
      const diagnosticEnv = { PATH: nodeOnlyPath, AIOS_CONFIG_DIR: diagnosticConfig };
      for (const key of [
        "AIOS_API_KEY",
        "AIOS_CREDENTIAL_SOURCE",
        "LINEAR_API_KEY",
        "LINEAR_OAUTH_TOKEN",
        "SLACK_BOT_TOKEN",
        "SLACK_USER_TOKEN",
      ]) {
        assert.equal(allowlistedEnv(diagnosticEnv)[key], undefined, `${key} must not be inherited`);
      }
      const devtoolsRoot = path.join(prefix, "node_modules", "@aiosbrain", "aios-devtools");
      const brokenDevtoolsRoot = `${devtoolsRoot}.broken-fixture`;
      renameSync(devtoolsRoot, brokenDevtoolsRoot);
      try {
        for (const command of ["help", "version", "doctor", "provenance"]) {
          const stdout = run(bin, [command, "--json"], { cwd: prefix, env: diagnosticEnv });
          const document = JSON.parse(stdout);
          assert.equal(document.command, command, `${command} must emit its own JSON document`);
          assert.equal(stdout.trim().split("\n").at(0).startsWith("{"), true);
          assert.doesNotMatch(stdout, /fixture-value/i);
          if (command === "doctor") assert.equal(document.ok, false, "invalid config is reported");
          if (command === "provenance") {
            assert.equal(document.installType, "registry", "npm tarball install is registry");
            assert.equal(document.package.root, realpathSync(pkgDir));
          }
        }
      } finally {
        renameSync(brokenDevtoolsRoot, devtoolsRoot);
      }

      const configModule = pathToFileURL(path.join(pkgDir, "scripts", "cli", "config-broker.mjs"));
      const migrationModule = pathToFileURL(path.join(pkgDir, "scripts", "cli", "migration.mjs"));
      const foundationFixture = path.join(base, "packed-foundation-fixture");
      mkdirSync(foundationFixture, { recursive: true });
      const foundationProof = run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import fs from "node:fs/promises";
import path from "node:path";
import { writeUserConfig } from ${JSON.stringify(configModule.href)};
import { runMigration } from ${JSON.stringify(migrationModule.href)};
const root = process.argv[1];
const userConfig = path.join(root, "config.json");
await fs.writeFile(userConfig, '{"schemaVersion":2,"future":{"enabled":true}}\\n', { mode: 0o600 });
await writeUserConfig(userConfig, { defaultWorkspace: "/fixture/workspace" });
const preserved = JSON.parse(await fs.readFile(userConfig, "utf8"));
const migrating = path.join(root, "migrating.json");
const original = Buffer.from("legacy-config-bytes\\n");
await fs.writeFile(migrating, original, { mode: 0o600 });
let interrupted = false;
try {
  await runMigration({
    configPath: migrating,
    packageRecord: { name: "@aiosbrain/aios", version: "fixture-prior" },
    stage: async (source) => Buffer.concat([source, Buffer.from("migrated\\n")]),
    validate: async () => {},
    interrupt: (state) => { if (state === "staged") throw new Error("fixture interruption"); },
  });
} catch (error) {
  if (error.code !== "AIOS_E_MIGRATION") throw error;
  interrupted = true;
}
const options = {
  configPath: migrating,
  packageRecord: { name: "@aiosbrain/aios", version: "fixture-prior" },
  stage: async (source) => Buffer.concat([source, Buffer.from("migrated\\n")]),
  validate: async () => {},
};
const resumed = await runMigration(options);
const afterFirst = await fs.readFile(migrating);
const converged = await runMigration(options);
const afterSecond = await fs.readFile(migrating);
process.stdout.write(JSON.stringify({
  interrupted,
  unknownPreserved: preserved.future?.enabled === true,
  resumed: resumed.resumed,
  state: converged.journal.state,
  byteStable: afterFirst.equals(afterSecond),
}));`,
          foundationFixture,
        ],
        { cwd: foundationFixture, env: { PATH: nodeOnlyPath } }
      );
      assert.deepEqual(JSON.parse(foundationProof), {
        interrupted: true,
        unknownPreserved: true,
        resumed: true,
        state: "committed",
        byteStable: true,
      });

      // 4b. The OTHER two bins must also be present and RUNNABLE by bare name — that is the
      //     entrypoint the docs advertise, and the one that was broken.
      for (const binName of Object.keys(declaredBins)) {
        const p = path.join(prefix, "node_modules", ".bin", binName);
        assert.ok(existsSync(p), `npm exposed the ${binName} bin`);
      }
      // `slack --help` exits non-zero on argparse usage, so capture rather than assert exit 0.
      const slackHelp = (() => {
        try {
          return run(path.join(prefix, "node_modules", ".bin", "slack"), ["--help"], {
            cwd: prefix,
          });
        } catch (e) {
          return `${e.stdout ?? ""}${e.stderr ?? ""}`;
        }
      })();
      // Parse argparse's own `{a,b,c}` choices block rather than substring-matching the help
      // text: `read` would match "already", `file` would match "filename". Membership in the
      // declared choice set is the actual property, and it needs no constructed regex.
      const slackVerbs = new Set(
        (/\{([a-z,]+)\}/.exec(slackHelp)?.[1] ?? "").split(",").filter(Boolean)
      );
      for (const verb of ["file", "resolve", "dm", "send", "read"]) {
        assert.ok(
          slackVerbs.has(verb),
          `installed slack must expose '${verb}' (got: ${[...slackVerbs].join(",") || "none"})`
        );
      }

      // 4c. The devtools pin must be EXACT and satisfied. `aios spec eval` reaches into the
      //     sibling package, so a stale pin silently reintroduces AIO-686 for every installer
      //     even though core's own code is fixed.
      const devtoolsPkg = path.join(
        prefix,
        "node_modules",
        "@aiosbrain",
        "aios-devtools",
        "package.json"
      );
      assert.ok(existsSync(devtoolsPkg), "the devtools dependency must be installed");
      assert.equal(
        JSON.parse(readFileSync(devtoolsPkg, "utf8")).version,
        JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).dependencies[
          "@aiosbrain/aios-devtools"
        ],
        "installed devtools must match core's exact pin"
      );

      // 4d. The property AIO-686 is about: a repo with NO .claude/rubrics/ must still grade,
      //     from a published install, instead of dying with "rubric not found" (exit 4). The
      //     verdict itself is not asserted — a bare repo legitimately fails other criteria.
      const bareRepo = path.join(base, "rubricless");
      mkdirSync(bareRepo, { recursive: true });
      writeFileSync(path.join(bareRepo, "issue.md"), "# Spec\n\nA short spec body.\n");
      let specOut = "";
      let specStatus = 0;
      try {
        specOut = run(bin, ["spec", "eval", path.join(bareRepo, "issue.md"), "--no-llm"], {
          cwd: bareRepo,
        });
      } catch (e) {
        specStatus = e.status ?? 1;
        specOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      assert.notEqual(specStatus, 4, `spec eval must not die on rubric loading: ${specOut}`);
      assert.doesNotMatch(specOut, /rubric not found/, specOut);

      // 4e. Credential resolution must not depend on a dotenvx that happens to be on PATH.
      //     When the package shipped @dotenvx/dotenvx as a devDependency, a production install
      //     carried no copy at all, so on any machine without a global dotenvx the F-C6 decrypt
      //     path silently returned "" and `linear`/`slack` could not resolve a key sitting
      //     encrypted in the workspace .env. Every dev machine masked it twice (direnv had
      //     already exported the key, and dotenvx was on PATH). Assert the property from the
      //     installed tree with dotenvx stripped from PATH: encrypt a key, then decrypt it using
      //     ONLY what the tarball installed. This install layout HOISTS the dependency to the
      //     prefix's node_modules (a global install nests it instead), which is exactly why
      //     resolveDotenvxInvocation() must use Node module resolution, not a fixed .bin path.
      const vendoredDotenvx = path.join(prefix, "node_modules", ".bin", "dotenvx");
      assert.ok(
        existsSync(vendoredDotenvx),
        "the install must carry dotenvx (runtime dependency, not dev)"
      );
      const envFixture = path.join(base, "dotenvx-fixture");
      mkdirSync(envFixture, { recursive: true });
      writeFileSync(path.join(envFixture, ".env"), "");
      run(vendoredDotenvx, ["set", "AIOS_API_KEY", "golden-secret", "-f", ".env"], {
        cwd: envFixture,
      });
      const barePath = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter);
      const decrypted = run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { decryptDotenvKey } from ${JSON.stringify(
            path.join(pkgDir, "packages", "foundation", "src", "brain-config.mjs")
          )};\nprocess.stdout.write(decryptDotenvKey(${JSON.stringify(envFixture)}, "AIOS_API_KEY"));`,
        ],
        { env: { PATH: barePath } }
      );
      assert.equal(
        decrypted,
        "golden-secret",
        "installed brain-config must decrypt a workspace .env key without a global dotenvx on PATH"
      );

      // 4f. AIO-1067 fresh-user Linear path from the PACKED install: empty HOME/config,
      //     no ambient credential, node-only PATH. Missing config must name the exact
      //     bootstrap; after `aios connect linear --reference` a read completes against a
      //     mocked provider (synthetic key, zero network); the compat `linear` bin is a
      //     warning-only delegate with identical stdout.
      const linearCfg = path.join(base, "linear-config");
      mkdirSync(linearCfg, { recursive: true });
      const linearEnv = { PATH: nodeOnlyPath, AIOS_CONFIG_DIR: linearCfg };
      let missingStatus = 0;
      let missingOut = "";
      try {
        run(bin, ["linear", "get", "AIO-73"], { cwd: prefix, env: linearEnv });
      } catch (e) {
        missingStatus = e.status ?? 1;
        missingOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      assert.equal(missingStatus, 3, `packed missing-credential exit: ${missingOut}`);
      assert.match(missingOut, /AIOS_E_CREDENTIAL_MISSING/);
      assert.match(missingOut, /remediation: aios connect linear/);
      run(bin, ["connect", "linear", "--reference", "env:AIOS_GOLDEN_LINEAR_KEY"], {
        cwd: prefix,
        env: linearEnv,
      });
      const mockUrl = pathToFileURL(
        path.join(ROOT, "test", "helpers", "mock-linear-provider.mjs")
      ).href;
      const mockedEnv = {
        ...linearEnv,
        AIOS_GOLDEN_LINEAR_KEY: "synthetic-golden-key-not-real",
        NODE_OPTIONS: `--import ${mockUrl}`,
      };
      const canonicalRead = run(bin, ["linear", "get", "AIO-73"], { cwd: prefix, env: mockedEnv });
      assert.match(canonicalRead, /AIO-73 {2}Alpha {2}\[Backlog\] {2}id=issue-a/);
      const linearBin = path.join(prefix, "node_modules", ".bin", "linear");
      const delegateRead = run(linearBin, ["get", "AIO-73"], { cwd: prefix, env: mockedEnv });
      assert.equal(delegateRead, canonicalRead, "delegate stdout must match `aios linear`");
      const statusJson = JSON.parse(
        run(bin, ["linear", "status", "--json"], { cwd: prefix, env: mockedEnv })
      );
      assert.deepEqual(statusJson, {
        provider: "linear",
        configured: true,
        source: { name: "user-config", fields: ["apiKey"] },
      });
      run(bin, ["disconnect", "linear"], { cwd: prefix, env: linearEnv });

      // 5. Scaffold a consultant workspace from the INSTALLED package (synthetic data).
      const ws = path.join(base, "golden-ws");
      run("bash", [
        path.join(pkgDir, "scripts", "scaffold-project.sh"),
        ...["--context", "consultant", "--slug", "golden-sample", "--owner", "alex"],
        ...["--stakeholder", "Sample Co", "--team", "alex,sam"],
        ...["--org", "your-github-org", "--currency", "USD", "--output", ws],
      ]);
      assert.ok(existsSync(path.join(ws, "aios.yaml")), "scaffold produced aios.yaml");
      // The .opencode hygiene file survives npm's .gitignore stripping via the
      // scaffold-side self-heal (see scaffold-project.sh).
      assert.ok(
        existsSync(path.join(ws, ".opencode", ".gitignore")),
        "scaffolded workspace has .opencode/.gitignore"
      );

      // 6. Validators run from the installed location against the fresh workspace.
      run("bash", [path.join(pkgDir, "validation", "validate-all.sh"), ws, "--quick"]);

      // 7. Offline sync-client smoke inside the scaffolded workspace.
      const status = run(bin, ["status", "--repo", ws], { cwd: ws });
      assert.ok(status.length > 0, "aios status printed a report");
      run(bin, ["status", "--porcelain", "--repo", ws], { cwd: ws });
      run(bin, ["push", "--dry-run", "--repo", ws], { cwd: ws });

      t.diagnostic(`golden path green: pack → install → scaffold → validate → status (${base})`);
    } finally {
      isolatedHome = null;
      if (!DIR_OVERRIDE) rmSync(base, { recursive: true, force: true });
    }
  }
);
