import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRepo({ hooksPath = null, gateExit = 0 } = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-"));
  roots.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  if (hooksPath) execFileSync("git", ["-C", repo, "config", "core.hooksPath", hooksPath]);

  const hooksDir = path.join(repo, hooksPath ?? ".git/hooks");
  const scriptsDir = path.join(repo, "scripts");
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, "leak-gate.sh"), `#!/usr/bin/env bash\nexit ${gateExit}\n`);
  chmodSync(path.join(scriptsDir, "leak-gate.sh"), 0o755);

  const foreignHook = path.join(hooksDir, "pre-push");
  writeFileSync(foreignHook, "#!/usr/bin/env bash\nprintf 'chained\\n' >> \"$CHAIN_MARKER\"\n");
  chmodSync(foreignHook, 0o755);
  return { repo, hooksDir };
}

function install(repo) {
  execFileSync("bash", [INSTALLER], { cwd: repo, stdio: "pipe" });
}

function runHook(repo, hooksDir, env = {}) {
  const marker = path.join(repo, "chain-ran");
  const result = spawnSync(path.join(hooksDir, "pre-push"), [], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CHAIN_MARKER: marker, ...env },
  });
  return {
    ...result,
    marker: (() => {
      try {
        return readFileSync(marker, "utf8");
      } catch {
        return "";
      }
    })(),
  };
}

test("push rejects a confidential commit even when a later commit deletes the file", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-history-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-remote-"));
  roots.push(repo, remote);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(path.join(repo, "scaffold"), { recursive: true });
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  writeFileSync(path.join(repo, "scaffold", ".keep"), "");
  writeFileSync(path.join(repo, "README.md"), "safe\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "safe base"]);
  install(repo);

  rmSync(path.join(repo, "scripts", "leak-gate.sh"));
  mkdirSync(path.join(repo, "docs", "bd"), { recursive: true });
  writeFileSync(path.join(repo, ".gitattributes"), "docs/bd/** export-ignore\n");
  writeFileSync(path.join(repo, "docs", "bd", "prospect.md"), "confidential prospect\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", [
    "-C",
    repo,
    "commit",
    "-q",
    "-m",
    "add private brief without scanner signature",
  ]);
  rmSync(path.join(repo, "docs"), { recursive: true, force: true });
  rmSync(path.join(repo, ".gitattributes"));
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "delete private brief"]);

  const push = spawnSync("git", ["-C", repo, "push", "origin", "main"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  assert.notEqual(push.status, 0, "the history-containing push must be blocked");
  assert.match(push.stderr, /confidential material/i);
  const remoteHead = spawnSync("git", ["--git-dir", remote, "rev-parse", "main"], {
    encoding: "utf8",
  });
  assert.notEqual(remoteHead.status, 0, "the blocked push must not create the remote ref");
});

test("push rejects a lightweight tag that publishes a protected blob", () => {
  const { repo } = makeRepo();
  const remote = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-blob-remote-"));
  const terms = path.join(repo, "terms.sh");
  roots.push(remote);
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  writeFileSync(terms, "STRONG='sensitiveclient-name'\n");
  const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], {
    input: "sensitiveclient-name\n",
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["-C", repo, "update-ref", "refs/tags/leak-blob", blob]);
  install(repo);

  const push = spawnSync("git", ["-C", repo, "push", "origin", "refs/tags/leak-blob"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AIOS_LEAK_TERMS_FILE: terms,
      CHAIN_MARKER: path.join(repo, "chain-ran"),
    },
  });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /confidential material/i);
});

test("push rejects owner-only frontmatter in a detached blob without private terms", () => {
  const { repo } = makeRepo();
  const remote = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-tier-blob-remote-"));
  roots.push(remote);
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], {
    input: "---\naccess: admin\n---\n",
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["-C", repo, "update-ref", "refs/tags/admin-blob", blob]);
  install(repo);

  const push = spawnSync("git", ["-C", repo, "push", "origin", "refs/tags/admin-blob"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file",
      CHAIN_MARKER: path.join(repo, "chain-ran"),
    },
  });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /confidential material/i);
});

test("new-ref scanning ignores stale local remote-tracking refs", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-stale-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-stale-remote-"));
  roots.push(repo, remote);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(path.join(repo, "scaffold"), { recursive: true });
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  writeFileSync(path.join(repo, "scaffold", ".keep"), "");
  mkdirSync(path.join(repo, "docs", "bd"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "bd", "prospect.md"), "confidential prospect\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "private ancestor"]);
  const privateCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", privateCommit]);
  rmSync(path.join(repo, "docs"), { recursive: true, force: true });
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "clean tip"]);
  install(repo);

  const push = spawnSync("git", ["-C", repo, "push", "origin", "HEAD:refs/heads/new-branch"], {
    encoding: "utf8",
    env: { ...process.env, AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file" },
  });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /confidential material/i);
});

test("preserved hooks still resolve helper programs beside their original hook path", () => {
  const { repo, hooksDir } = makeRepo();
  const helper = path.join(hooksDir, "block-push-helper");
  writeFileSync(helper, "#!/usr/bin/env bash\nexit 23\n");
  chmodSync(helper, 0o755);
  writeFileSync(
    path.join(hooksDir, "pre-push"),
    '#!/usr/bin/env bash\nhelper="$(dirname "$0")/block-push-helper"\n[ ! -x "$helper" ] || "$helper"\n'
  );
  chmodSync(path.join(hooksDir, "pre-push"), 0o755);
  assert.equal(spawnSync(path.join(hooksDir, "pre-push")).status, 23);

  install(repo);
  const result = runHook(repo, hooksDir, { AIOS_ALLOW_UNGATED_PUSH: "1" });
  assert.equal(result.status, 23, result.stderr);
});

test("preserved shell hooks still observe the canonical pre-push basename", () => {
  const { repo, hooksDir } = makeRepo();
  writeFileSync(
    path.join(hooksDir, "pre-push"),
    '#!/usr/bin/env bash\n[ "$(basename "$0")" != "pre-push" ] || exit 23\n'
  );
  chmodSync(path.join(hooksDir, "pre-push"), 0o755);
  assert.equal(spawnSync(path.join(hooksDir, "pre-push")).status, 23);

  install(repo);
  const result = runHook(repo, hooksDir, { AIOS_ALLOW_UNGATED_PUSH: "1" });
  assert.equal(result.status, 23, result.stderr);
});

test("new-ref exclusions do not rescan unrelated remote branch history", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-multitip-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-multitip-remote-"));
  roots.push(repo, remote);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(path.join(repo, "scaffold"), { recursive: true });
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  writeFileSync(path.join(repo, "scaffold", ".keep"), "");
  writeFileSync(path.join(repo, "README.md"), "safe\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "safe main"]);
  execFileSync("git", ["-C", repo, "push", "-q", "origin", "main"]);

  execFileSync("git", ["-C", repo, "switch", "-q", "-c", "private-history"]);
  mkdirSync(path.join(repo, "docs", "bd"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "bd", "old.md"), "already remote\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "remote private history"]);
  execFileSync("git", ["-C", repo, "push", "-q", "origin", "private-history"]);
  execFileSync("git", ["-C", repo, "switch", "-q", "main"]);
  execFileSync("git", ["-C", repo, "switch", "-q", "-c", "safe-new"]);
  writeFileSync(path.join(repo, "safe.txt"), "new safe work\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "safe new ref"]);
  install(repo);

  const push = spawnSync("git", ["-C", repo, "push", "origin", "safe-new"], {
    encoding: "utf8",
    env: { ...process.env, AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file" },
  });
  assert.equal(push.status, 0, push.stderr);
});

test("reinstall preserves both an existing chain and a newer replacement hook", () => {
  const { repo, hooksDir } = makeRepo();
  install(repo);

  writeFileSync(
    path.join(hooksDir, "pre-push"),
    "#!/usr/bin/env bash\nprintf 'replacement\\n' >> \"$CHAIN_MARKER\"\n"
  );
  chmodSync(path.join(hooksDir, "pre-push"), 0o755);
  install(repo);

  const result = runHook(repo, hooksDir, { AIOS_ALLOW_UNGATED_PUSH: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.marker, /chained/);
  assert.match(result.marker, /replacement/);
});

test("a custom core.hooksPath still runs the pre-existing chained hook", () => {
  const { repo, hooksDir } = makeRepo({ hooksPath: ".githooks" });
  install(repo);

  const result = runHook(repo, hooksDir);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.marker, "chained\n");
});

test("the emergency leak-gate override still runs the pre-existing chained hook", () => {
  const { repo, hooksDir } = makeRepo();
  install(repo);

  const result = runHook(repo, hooksDir, { AIOS_ALLOW_UNGATED_PUSH: "1" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.marker, "chained\n");
  assert.match(result.stderr, /BYPASSED/);
});

test("a scanner error is reported as an incomplete scan, not a confirmed leak", () => {
  const { repo, hooksDir } = makeRepo({ gateExit: 2 });
  install(repo);

  const result = runHook(repo, hooksDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /scan could not complete/i);
  assert.doesNotMatch(result.stderr, /found confidential material/i);
  assert.equal(result.marker, "", "the foreign hook must not run after an incomplete scan");
});

test("push rejects a commit that a replacement ref hides from the gate", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-replace-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-replace-remote-"));
  roots.push(repo, remote);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(path.join(repo, "scaffold"), { recursive: true });
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  writeFileSync(path.join(repo, "scaffold", ".keep"), "");
  writeFileSync(path.join(repo, "README.md"), "safe\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "safe base"]);
  const safe = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  install(repo);

  mkdirSync(path.join(repo, "docs", "bd"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "bd", "prospect.md"), "confidential prospect\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "add private brief"]);
  const protectedCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  // A clean stand-in carrying the SAFE tree, grafted over the protected commit. Git reads the
  // replacement; git push still transmits the original objects.
  const standIn = execFileSync(
    "git",
    ["-C", repo, "commit-tree", `${safe}^{tree}`, "-p", safe, "-m", "clean"],
    { encoding: "utf8" }
  ).trim();
  execFileSync("git", ["-C", repo, "replace", protectedCommit, standIn]);

  // Guard against a vacuous pass: if the replacement did not take, this test proves nothing.
  assert.notEqual(
    execFileSync("git", ["-C", repo, "replace", "-l"], { encoding: "utf8" }).trim(),
    "",
    "fixture is vacuous: no replacement ref was created"
  );

  const push = spawnSync("git", ["-C", repo, "push", "origin", "main"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  assert.notEqual(push.status, 0, "a replacement ref must not hide a protected commit");
  assert.match(push.stderr, /confidential material/i);
  const remoteHead = spawnSync("git", ["--git-dir", remote, "rev-parse", "main"], {
    encoding: "utf8",
  });
  assert.notEqual(remoteHead.status, 0, "the blocked push must not create the remote ref");
});

test("push rejects a confidential commit message even when every tree is clean", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-msg-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "aios-pre-push-msg-remote-"));
  roots.push(repo, remote);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(path.join(repo, "scaffold"), { recursive: true });
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );
  writeFileSync(path.join(repo, "scaffold", ".keep"), "");
  writeFileSync(path.join(repo, "README.md"), "safe\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  // The tree is entirely clean; the confidential material lives only in the message, which is
  // published on push exactly like the tree is.
  execFileSync("git", [
    "-C",
    repo,
    "commit",
    "-q",
    "-m",
    "---\naccess: admin\n---\n\nowner-only notes in the commit message\n",
  ]);
  install(repo);

  const push = spawnSync("git", ["-C", repo, "push", "origin", "main"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  assert.notEqual(push.status, 0, "a commit message is a published object and must be scanned");
  const remoteHead = spawnSync("git", ["--git-dir", remote, "rev-parse", "main"], {
    encoding: "utf8",
  });
  assert.notEqual(remoteHead.status, 0, "the blocked push must not create the remote ref");
});

test("preserved hooks keep the interpreter flags declared in their shebang", () => {
  const { repo, hooksDir } = makeRepo();
  // `-e` must abort the hook at the failing command. Losing it lets a security check that
  // formerly stopped the push fall through to `exit 0`.
  writeFileSync(path.join(hooksDir, "pre-push"), "#!/bin/bash -e\nsh -c 'exit 23'\nexit 0\n");
  chmodSync(path.join(hooksDir, "pre-push"), 0o755);
  assert.equal(
    spawnSync(path.join(hooksDir, "pre-push")).status,
    23,
    "fixture is not real: the platform did not honour the shebang flag"
  );

  install(repo);
  const result = runHook(repo, hooksDir, { AIOS_ALLOW_UNGATED_PUSH: "1" });
  assert.equal(result.status, 23, result.stderr);
});

test("preserved non-shell hooks still observe the canonical pre-push basename", () => {
  const { repo, hooksDir } = makeRepo();
  // Shebanged at this Node binary: deterministic, and it matches no arm of the interpreter
  // case the dispatcher used to apply. argv[1] is the path handed to execve.
  writeFileSync(
    path.join(hooksDir, "pre-push"),
    `#!${process.execPath}\n` +
      'const path = require("node:path");\n' +
      'process.exit(path.basename(process.argv[1]) === "pre-push" ? 23 : 0);\n'
  );
  chmodSync(path.join(hooksDir, "pre-push"), 0o755);
  assert.equal(spawnSync(path.join(hooksDir, "pre-push")).status, 23);

  install(repo);
  const result = runHook(repo, hooksDir, { AIOS_ALLOW_UNGATED_PUSH: "1" });
  assert.equal(result.status, 23, result.stderr);
});

// Characterization, not RED: green before and after. This is the only guard that catches the
// dispatcher's sibling symlink farm being wrong or omitted.
test("preserved non-shell hooks still resolve helper programs beside their original hook path", () => {
  const { repo, hooksDir } = makeRepo();
  const helper = path.join(hooksDir, "block-push-helper");
  writeFileSync(helper, "#!/usr/bin/env bash\nexit 23\n");
  chmodSync(helper, 0o755);
  writeFileSync(
    path.join(hooksDir, "pre-push"),
    `#!${process.execPath}\n` +
      'const path = require("node:path");\n' +
      'const { spawnSync } = require("node:child_process");\n' +
      'const helper = path.join(path.dirname(process.argv[1]), "block-push-helper");\n' +
      "process.exit(spawnSync(helper).status ?? 0);\n"
  );
  chmodSync(path.join(hooksDir, "pre-push"), 0o755);
  assert.equal(spawnSync(path.join(hooksDir, "pre-push")).status, 23);

  install(repo);
  const result = runHook(repo, hooksDir, { AIOS_ALLOW_UNGATED_PUSH: "1" });
  assert.equal(result.status, 23, result.stderr);
});

// Characterization, not RED: pins the decision to scrub the gate's replace-blind override at
// the boundary where foreign code runs, so preserved hooks see the environment git would give.
test("preserved hooks do not inherit the gate's replace-blind override", () => {
  const { repo, hooksDir } = makeRepo();
  writeFileSync(
    path.join(hooksDir, "pre-push"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "${GIT_NO_REPLACE_OBJECTS-unset}" >> "$CHAIN_MARKER"\n'
  );
  chmodSync(path.join(hooksDir, "pre-push"), 0o755);

  install(repo);
  const result = runHook(repo, hooksDir, { AIOS_ALLOW_UNGATED_PUSH: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.marker, "unset\n");
});
