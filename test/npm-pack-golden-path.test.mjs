import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
