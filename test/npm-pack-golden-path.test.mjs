import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    ...opts,
    env: { ...process.env, CI: "1", ...(opts.env || {}) },
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
      for (const verb of ["file", "resolve", "dm", "send", "read"]) {
        assert.match(
          slackHelp,
          new RegExp(`\\b${verb}\\b`),
          `installed slack must expose '${verb}'`
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
      if (!DIR_OVERRIDE) rmSync(base, { recursive: true, force: true });
    }
  }
);
