import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(TOOLKIT, "scripts", "install-leak-gate-push-hook.sh");
const PRODUCT_MODE_STATE = "pre-push-leak-gate.product-mode";
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
delete GIT_ENV.AIOS_LEAK_GATE_INSTALL_PRODUCT_MODE;
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function initializeRepo(prefix) {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"], {
    env: GIT_ENV,
  });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { env: GIT_ENV });
  return repo;
}

function install(repo, env = {}) {
  execFileSync("bash", [INSTALLER], {
    cwd: repo,
    stdio: "pipe",
    env: { ...GIT_ENV, ...env },
  });
}

function productModeState(repo) {
  const commonDir = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();
  return path.join(path.resolve(repo, commonDir), "hooks", PRODUCT_MODE_STATE);
}

function runHook(repo, env = {}) {
  return spawnSync(path.join(repo, ".git", "hooks", "pre-push"), [], {
    cwd: repo,
    encoding: "utf8",
    env: { ...GIT_ENV, ...env },
  });
}

async function waitForFile(file, child) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(file)) return;
    if (child.exitCode !== null) throw new Error(`installer exited before creating ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function captureExit(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("installed non-product mode permits workspace-spine paths but still blocks configured terms", () => {
  const repo = initializeRepo("aios-pre-push-non-product-");
  const remote = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-non-product-remote-"));
  const termsRoot = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-terms-"));
  const terms = path.join(termsRoot, "terms.sh");
  roots.push(remote, termsRoot);
  execFileSync("git", ["init", "-q", "--bare", remote], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { env: GIT_ENV });
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  for (const directory of ["0-context", "1-inbox", "2-work", "3-log", "5-personal"]) {
    mkdirSync(path.join(repo, directory), { recursive: true });
    writeFileSync(path.join(repo, directory, "notes.md"), `safe ${directory} fixture\n`);
  }
  execFileSync("git", ["-C", repo, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "safe workspace-shaped tree"], {
    env: GIT_ENV,
  });
  install(repo);
  assert.equal(readFileSync(productModeState(repo), "utf8"), "0\n");

  // The installed decision stays authoritative until an explicit reinstall.
  mkdirSync(path.join(repo, "scaffold"));
  writeFileSync(path.join(repo, "scaffold", ".keep"), "");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "add signature after install"], {
    env: GIT_ENV,
  });
  const safeCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();

  const cleanPush = spawnSync("git", ["-C", repo, "push", "origin", "main"], {
    encoding: "utf8",
    env: { ...GIT_ENV, AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file" },
  });
  assert.equal(cleanPush.status, 0, cleanPush.stderr);

  writeFileSync(terms, "STRONG='synthetic-acme-confidential-token'\n");
  mkdirSync(path.join(repo, "4-shared"), { recursive: true });
  writeFileSync(
    path.join(repo, "4-shared", "confidential.md"),
    "synthetic-acme-confidential-token\n"
  );
  execFileSync("git", ["-C", repo, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "synthetic confidential term"], {
    env: GIT_ENV,
  });
  const blockedPush = spawnSync("git", ["-C", repo, "push", "origin", "main"], {
    encoding: "utf8",
    env: { ...GIT_ENV, AIOS_LEAK_TERMS_FILE: terms },
  });
  assert.notEqual(blockedPush.status, 0, "the configured term must still block mode 0");
  assert.match(blockedPush.stderr, /confidential material/i);
  assert.equal(
    execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], {
      encoding: "utf8",
      env: GIT_ENV,
    }).trim(),
    safeCommit,
    "the blocked push must leave the remote ref at the last clean commit"
  );
});

test("automatic reinstall cannot downgrade product mode after checkout signatures disappear", () => {
  const repo = initializeRepo("aios-pre-push-product-reinstall-");
  const remote = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-product-reinstall-remote-"));
  roots.push(remote);
  execFileSync("git", ["init", "-q", "--bare", remote], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { env: GIT_ENV });
  mkdirSync(path.join(repo, "scripts"));
  mkdirSync(path.join(repo, "scaffold"));
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  writeFileSync(path.join(repo, "scaffold", ".keep"), "");
  writeFileSync(path.join(repo, "README.md"), "safe\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "product base"], {
    env: GIT_ENV,
  });
  install(repo);
  const state = productModeState(repo);
  assert.equal(readFileSync(state, "utf8"), "1\n");

  rmSync(path.join(repo, "scaffold"), { recursive: true, force: true });
  rmSync(path.join(repo, "scripts", "leak-gate.sh"));
  execFileSync("git", ["-C", repo, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "remove product signatures"], {
    env: GIT_ENV,
  });
  install(repo);
  assert.equal(readFileSync(state, "utf8"), "1\n");

  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  mkdirSync(path.join(repo, "docs", "bd"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "bd", "prospect.md"), "synthetic prospect\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "restore scanner with product path"], {
    env: GIT_ENV,
  });
  const push = spawnSync("git", ["-C", repo, "push", "origin", "main"], {
    encoding: "utf8",
    env: { ...GIT_ENV, AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file" },
  });
  assert.notEqual(push.status, 0, "product-only forbidden paths must remain blocked");
  assert.match(push.stderr, /confidential material/i);
  const remoteHead = spawnSync("git", ["--git-dir", remote, "rev-parse", "main"], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  assert.notEqual(remoteHead.status, 0, "the blocked push must not create the remote ref");
});

test("a stale concurrent mode-0 install cannot overwrite a completed mode-1 install", async () => {
  const repo = initializeRepo("aios-pre-push-product-race-");
  const raceDir = mkdtempSync(path.join(os.tmpdir(), "aios-product-mode-race-"));
  roots.push(raceDir);
  const shimDir = path.join(raceDir, "bin");
  const ready = path.join(raceDir, "mode-0-ready");
  const release = path.join(raceDir, "release-mode-0");
  mkdirSync(shimDir);
  const realMktemp = execFileSync("bash", ["-c", "command -v mktemp"], {
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();
  const mktempShim = path.join(shimDir, "mktemp");
  writeFileSync(
    mktempShim,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'result="$("$REAL_MKTEMP" "$@")"',
      'if [[ "$*" == *".pre-push-leak-gate.product-mode."* ]]; then',
      '  : > "$RACE_READY"',
      '  while [[ ! -e "$RACE_RELEASE" ]]; do sleep 0.01; done',
      "fi",
      "printf '%s\\n' \"$result\"",
      "",
    ].join("\n")
  );
  chmodSync(mktempShim, 0o755);

  const mode0 = spawn("bash", [INSTALLER], {
    cwd: repo,
    env: {
      ...GIT_ENV,
      PATH: `${shimDir}:${GIT_ENV.PATH}`,
      AIOS_LEAK_GATE_INSTALL_PRODUCT_MODE: "0",
      REAL_MKTEMP: realMktemp,
      RACE_READY: ready,
      RACE_RELEASE: release,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const mode0Exit = captureExit(mode0);
  await waitForFile(ready, mode0);

  install(repo, { AIOS_LEAK_GATE_INSTALL_PRODUCT_MODE: "1" });
  const state = productModeState(repo);
  assert.equal(readFileSync(state, "utf8"), "1\n");
  writeFileSync(release, "go\n");

  const result = await mode0Exit;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(state, "utf8"), "1\n");
});

test("worktree, commit metadata, treeish, tag, and blob scans share installed mode", () => {
  const repo = initializeRepo("aios-pre-push-mode-routing-");
  const remote = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-mode-routing-remote-"));
  const logRoot = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-mode-log-"));
  const modeLog = path.join(logRoot, "modes.log");
  roots.push(remote, logRoot);
  execFileSync("git", ["init", "-q", "--bare", remote], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { env: GIT_ENV });
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  writeFileSync(
    path.join(repo, "scripts", "leak-gate.sh"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "${AIOS_LEAK_GATE_PRODUCT_REPO-unset}" >> "$MODE_LOG"\nexit 0\n'
  );
  chmodSync(path.join(repo, "scripts", "leak-gate.sh"), 0o755);
  writeFileSync(path.join(repo, "README.md"), "safe\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "safe commit"], {
    env: GIT_ENV,
  });
  install(repo);

  const env = { ...GIT_ENV, MODE_LOG: modeLog };
  const manual = runHook(repo, env);
  assert.equal(manual.status, 0, manual.stderr);
  const commitPush = spawnSync("git", ["-C", repo, "push", "origin", "main"], {
    encoding: "utf8",
    env,
  });
  assert.equal(commitPush.status, 0, commitPush.stderr);

  const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], {
    input: "safe detached blob\n",
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();
  execFileSync("git", ["-C", repo, "update-ref", "refs/tags/safe-blob", blob], {
    env: GIT_ENV,
  });
  const blobPush = spawnSync("git", ["-C", repo, "push", "origin", "refs/tags/safe-blob"], {
    encoding: "utf8",
    env,
  });
  assert.equal(blobPush.status, 0, blobPush.stderr);

  execFileSync("git", ["-C", repo, "tag", "-a", "safe-annotated", "-m", "safe tag"], {
    env: GIT_ENV,
  });
  const tagPush = spawnSync("git", ["-C", repo, "push", "origin", "refs/tags/safe-annotated"], {
    encoding: "utf8",
    env,
  });
  assert.equal(tagPush.status, 0, tagPush.stderr);

  const modes = readFileSync(modeLog, "utf8").trim().split("\n");
  assert.ok(modes.length >= 5, `expected every scan route, observed ${modes.length} scans`);
  assert.deepEqual(new Set(modes), new Set(["0"]));
});

test("missing, unreadable, and malformed installed modes fail closed with reinstall guidance", () => {
  const repo = initializeRepo("aios-pre-push-corrupt-mode-");
  mkdirSync(path.join(repo, "scripts"));
  writeFileSync(path.join(repo, "scripts", "leak-gate.sh"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(path.join(repo, "scripts", "leak-gate.sh"), 0o755);
  install(repo);
  const state = productModeState(repo);
  const cases = [
    ["missing", () => rmSync(state)],
    ["non-decimal", () => writeFileSync(state, "x\n")],
    ["out-of-domain", () => writeFileSync(state, "2\n")],
    ["extra data", () => writeFileSync(state, "0\n1\n")],
    ["unreadable", () => chmodSync(state, 0o000)],
  ];
  for (const [label, corrupt] of cases) {
    writeFileSync(state, "0\n", { mode: 0o600 });
    chmodSync(state, 0o600);
    corrupt();
    const result = runHook(repo);
    assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /scan could not complete safely/i, label);
    assert.match(result.stderr, /install-leak-gate-push-hook\.sh/i, label);
    assert.doesNotMatch(result.stderr, /found confidential material/i, label);
  }
  chmodSync(state, 0o600);
});

test("a confirmed leak message makes no unverified repository visibility claim", () => {
  const repo = initializeRepo("aios-pre-push-visibility-");
  mkdirSync(path.join(repo, "scripts"));
  writeFileSync(path.join(repo, "scripts", "leak-gate.sh"), "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(path.join(repo, "scripts", "leak-gate.sh"), 0o755);
  install(repo);
  const result = runHook(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /found confidential material/i);
  assert.doesNotMatch(result.stderr, /repository is (public|private)/i);
});
