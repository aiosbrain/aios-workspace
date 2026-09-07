import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BOOTSTRAP_VERSION } from "../scripts/repo-bootstrap/manifest.mjs";
import { runBootstrap } from "../scripts/repo-bootstrap/engine.mjs";
import { parseWorkflowYaml } from "../scripts/workflow-yaml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;
const write = (dir, file, text) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, ...args], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}
function copy(dir, file) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  copyFileSync(path.join(root, file), path.join(dir, file));
}

for (const generated of [false, true]) {
  test(
    `${generated ? "generated bootstrap" : "repository CI"}: candidate cannot replace trusted hygiene authority`,
    { timeout: 30_000 },
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "trusted-hygiene-"));
      const base = path.join(dir, "trusted-hygiene");
      const candidate = path.join(dir, "candidate");
      try {
        mkdirSync(base);
        git(base, "init", "-q");
        let yaml;
        if (generated) {
          runBootstrap({
            toolkitDir: root,
            targetDir: base,
            params: {
              BOOTSTRAP_VERSION,
              REPO_NAME: "synthetic",
              LINT_SCRIPT: "lint",
              TEST_SCRIPT: "test",
            },
          });
          yaml = readFileSync(path.join(base, ".github/workflows/ci.yml"), "utf8");
          // A second bootstrap updates managed files but preserves an existing CI workflow.
          write(base, ".github/workflows/ci.yml", "# repository owned\n");
          runBootstrap({
            toolkitDir: root,
            targetDir: base,
            params: { REPO_NAME: "synthetic" },
            force: true,
          });
          assert.equal(
            readFileSync(path.join(base, ".github/workflows/ci.yml"), "utf8"),
            "# repository owned\n"
          );
        } else {
          for (const file of [
            "scripts/check-file-size.mjs",
            "scripts/check-boundaries.mjs",
            "scripts/git-files.mjs",
            "packages/foundation/src/git-files.mjs",
            "validation/agent-readiness-lib.mjs",
            "scripts/size-caps.json",
            "scripts/boundaries.json",
          ])
            copy(base, file);
          yaml = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
          // A tiny synthetic repository has none of the toolkit's existing grandfathered edges.
          const rules = JSON.parse(
            readFileSync(path.join(base, "scripts/boundaries.json"), "utf8")
          );
          rules.grandfathered = [];
          write(base, "scripts/boundaries.json", JSON.stringify(rules));
        }
        const doc = parseWorkflowYaml(yaml);
        const job = doc.jobs[generated ? "gates" : "constitution"];
        const checkouts = job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
        assert.equal(checkouts.length, 2);
        assert.equal(checkouts[0].with.path, "trusted-hygiene");
        assert.match(checkouts[0].with.ref, /github.event.pull_request.base.sha/);
        assert.equal(checkouts[1].with.path, "candidate");
        for (const step of checkouts) assert.equal(step.with["persist-credentials"], false);
        assert.equal(job.defaults.run["working-directory"], "candidate");
        const preflight = job.steps.find((s) => s.name === "Verify trusted hygiene files");
        const size = job.steps.find((s) => s.name?.startsWith("File-size gate"));
        const boundaries = job.steps.find((s) => s.name === "Repo-boundary gate");
        assert.ok(preflight && size && boundaries);
        const before = job.steps.slice(0, job.steps.indexOf(boundaries) + 1);
        assert.equal(
          before.some((s) => /\b(?:npm|npx|yarn|pnpm)\b/.test(s.run ?? "")),
          false
        );
        for (const step of [size, boundaries])
          assert.match(step.run, /^node "\$GITHUB_WORKSPACE\/trusted-hygiene\//);
        assert.match(
          size.run,
          /--config "\$GITHUB_WORKSPACE\/trusted-hygiene\/scripts\/size-caps.json"/
        );
        cpSync(base, candidate, { recursive: true });
        rmSync(path.join(candidate, ".git"), { recursive: true, force: true });
        git(candidate, "init", "-q");
        const run = (body) =>
          spawnSync("bash", ["-eu", "-c", body], {
            cwd: candidate,
            env: { ...env, GITHUB_WORKSPACE: dir },
            encoding: "utf8",
            timeout: 10_000,
          });
        const passed = (body) => {
          const r = run(body);
          assert.equal(r.status, 0, r.stdout + r.stderr);
        };
        const rejected = (body, reason) => {
          const r = run(body);
          assert.equal(r.status, 1, r.stdout + r.stderr);
          assert.match(r.stdout + r.stderr, reason);
        };
        passed(preflight.run);
        passed(size.run);
        passed(boundaries.run);
        write(candidate, "scripts/oversize.mjs", "// line\n".repeat(601));
        write(candidate, "scripts/cross-boundary.mjs", 'import "../test/helper.mjs";\n');
        write(candidate, "test/helper.mjs", "export {};\n");
        git(
          candidate,
          "add",
          "scripts/oversize.mjs",
          "scripts/cross-boundary.mjs",
          "test/helper.mjs"
        );
        const prove = () => {
          rejected(size.run, /oversize.mjs/);
          rejected(boundaries.run, /cross-boundary.mjs/);
        };
        prove();
        write(candidate, "scripts/check-file-size.mjs", "process.exit(0);\n");
        write(candidate, "scripts/check-boundaries.mjs", "process.exit(0);\n");
        prove();
        write(
          candidate,
          "package.json",
          JSON.stringify({ scripts: { "check:size": "true", "check:boundaries": "true" } })
        );
        prove();
        write(
          candidate,
          "scripts/size-caps.json",
          JSON.stringify({
            defaultCap: 10000,
            include: ["**/*.mjs"],
            exclude: [],
            grandfathered: {},
          })
        );
        prove();
        const rules = JSON.parse(readFileSync(path.join(base, "scripts/boundaries.json"), "utf8"));
        rules.grandfathered = [
          {
            from: "scripts/cross-boundary.mjs",
            to: "test/helper.mjs",
            reason: "candidate self-waiver",
          },
        ];
        write(candidate, "scripts/boundaries.json", JSON.stringify(rules));
        prove();
        // An old base waiver may become unused as the candidate removes debt.
        const baseRules = JSON.parse(
          readFileSync(path.join(base, "scripts/boundaries.json"), "utf8")
        );
        baseRules.grandfathered.push({
          from: "scripts/deleted.mjs",
          to: "test/old.mjs",
          reason: "candidate removed this coupling",
        });
        write(base, "scripts/boundaries.json", JSON.stringify(baseRules));
        prove();
        // Exact authority mutations must reverse the verdict, proving the fixture can detect them.
        passed("node scripts/check-file-size.mjs");
        passed("node scripts/check-boundaries.mjs");
        passed("npm run check:size");
        passed("npm run check:boundaries");
        passed(
          size.run.replace(
            '"$GITHUB_WORKSPACE/trusted-hygiene/scripts/size-caps.json"',
            "scripts/size-caps.json"
          )
        );
        copyFileSync(
          path.join(base, "scripts/check-boundaries.mjs"),
          path.join(candidate, "scripts/check-boundaries.mjs")
        );
        passed("node scripts/check-boundaries.mjs");
        // Missing trusted code, dependencies or configuration never falls back to candidate data.
        for (const file of [
          "scripts/check-file-size.mjs",
          "scripts/size-caps.json",
          "scripts/check-boundaries.mjs",
          "scripts/boundaries.json",
          "scripts/git-files.mjs",
          "validation/agent-readiness-lib.mjs",
        ]) {
          const original = readFileSync(path.join(base, file));
          rmSync(path.join(base, file));
          rejected(preflight.run, /Missing trusted hygiene file/);
          writeFileSync(path.join(base, file), original);
        }
        write(candidate, "scripts/oversize.mjs", "export {};\n");
        write(candidate, "scripts/cross-boundary.mjs", "export {};\n");
        passed(size.run);
        passed(boundaries.run);
        rejected(boundaries.run.replace(" --allow-stale", ""), /stale grandfather/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
}
