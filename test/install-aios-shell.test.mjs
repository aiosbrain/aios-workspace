import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Toolkit-resolution precedence for the installed `aios()` shell function. The rule under
// test: EXPLICIT config always beats the conventional ~/Projects default — otherwise a user
// with a custom path who also happens to have the default checkout on disk silently runs the
// wrong one. Exercised by extracting the real function from the installer and sourcing it.

const SCRIPT = fileURLToPath(new URL("../scripts/install-aios-shell.sh", import.meta.url));
const SCAFFOLD_SCRIPT = fileURLToPath(new URL("../scripts/scaffold-project.sh", import.meta.url));

/** The `aios()` function exactly as install-aios-shell.sh writes it into ~/.zshrc. */
function aiosFunctionSource() {
  const m = readFileSync(SCRIPT, "utf8").match(/^aios\(\) \{[\s\S]*?^\}$/m);
  assert.ok(m, "aios() function block found in install-aios-shell.sh");
  return m[0];
}

/** A toolkit checkout whose CLI just prints `label`, so we can see which one ran. */
function fakeToolkit(root, label) {
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "aios.mjs"), `console.log(${JSON.stringify(label)});\n`);
  return root;
}

/**
 * Run the extracted aios() from a scratch cwd (no aios.yaml anywhere above it, so the
 * walk-up misses and resolution falls through to the toolkit chain).
 */
function runAios(env) {
  const scratch = mkdtempSync(path.join(tmpdir(), "aios-shell-run-"));
  try {
    const runtime = path.join(scratch, "runtime");
    mkdirSync(runtime);
    symlinkSync(process.execPath, path.join(runtime, "node"));
    symlinkSync("/usr/bin/dirname", path.join(runtime, "dirname"));
    const fnFile = path.join(scratch, "fn.sh");
    writeFileSync(fnFile, `${aiosFunctionSource()}\n`);
    // The installer targets zsh; emulate its PATH-only whence in portable bash tests.
    const res = spawnSync(
      "/bin/bash",
      ["-c", `whence() { type -P "$2"; }; source ${fnFile}; aios`],
      {
        cwd: scratch,
        encoding: "utf8",
        env: { PATH: runtime, ...env },
      }
    );
    return `${res.stdout}${res.stderr}`.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A HOME containing the conventional default checkout, plus a custom one elsewhere. */
function makeEnvRoots() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-shell-"));
  const home = path.join(root, "home");
  fakeToolkit(path.join(home, "Projects", "aios", "aios-workspace"), "RAN_DEFAULT");
  fakeToolkit(path.join(root, "custom"), "RAN_CUSTOM");
  return { root, home, custom: path.join(root, "custom") };
}

test("deprecated AIOS_TOOLKIT_CLI beats the default checkout when both exist", () => {
  const { root, home, custom } = makeEnvRoots();
  try {
    // The regression: the default ~/Projects checkout EXISTS, and the user configured a
    // custom path via the legacy var. Their explicit config must win.
    const out = runAios({
      HOME: home,
      AIOS_TOOLKIT_CLI: path.join(custom, "scripts", "aios.mjs"),
    });
    assert.match(out, /RAN_CUSTOM/, "must run the explicitly configured checkout");
    assert.doesNotMatch(out, /RAN_DEFAULT/, "must NOT silently fall back to the default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AIOS_TOOLKIT_DIR wins over the deprecated AIOS_TOOLKIT_CLI", () => {
  const { root, home, custom } = makeEnvRoots();
  const other = fakeToolkit(path.join(root, "canonical"), "RAN_CANONICAL");
  try {
    const out = runAios({
      HOME: home,
      AIOS_TOOLKIT_DIR: other,
      AIOS_TOOLKIT_CLI: path.join(custom, "scripts", "aios.mjs"),
    });
    assert.match(out, /RAN_CANONICAL/, "the canonical var takes precedence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit toolkit config beats an installed PATH binary, including invalid config", () => {
  const { root, home, custom } = makeEnvRoots();
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "aios"), "#!/bin/sh\necho RAN_PATH\n", { mode: 0o755 });
  const env = { HOME: home, PATH: `${bin}:${process.env.PATH}` };
  try {
    for (const config of [
      { AIOS_TOOLKIT_DIR: custom },
      { AIOS_TOOLKIT_CLI: path.join(custom, "scripts", "aios.mjs") },
    ]) {
      assert.equal(runAios({ ...env, ...config }), "RAN_CUSTOM");
    }
    assert.equal(runAios(env), "RAN_PATH");
    const invalid = runAios({ ...env, AIOS_TOOLKIT_DIR: path.join(root, "missing") });
    assert.match(invalid, /AIOS_TOOLKIT_DIR has no/);
    assert.doesNotMatch(invalid, /RAN_PATH|RAN_DEFAULT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to the ~/Projects default when nothing is configured", () => {
  const { root, home } = makeEnvRoots();
  try {
    const out = runAios({ HOME: home });
    assert.match(out, /RAN_DEFAULT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer persists the selected personal workspace for cross-repo agent commands", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-shell-workspace-"));
  const workspace = path.join(root, "Chetan Workspace & agent");
  const rc = path.join(root, ".zshrc");
  const zshenv = path.join(root, ".zshenv");
  try {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "workspace: chetan\n");
    const install = spawnSync("bash", [SCRIPT, "--agent-workspace", workspace], {
      encoding: "utf8",
      env: { ...process.env, AIOS_SHELL_RC: rc, AIOS_AGENT_ENV_FILE: zshenv },
    });
    assert.equal(install.status, 0, install.stderr);
    const zsh = process.platform === "darwin" ? "zsh" : "bash";
    const source = spawnSync(
      zsh,
      zsh === "zsh"
        ? ["-lc", 'print -r -- "$AIOS_AGENT_WORKSPACE"']
        : ["-c", 'source "$AIOS_AGENT_ENV_FILE"; printf "%s\\n" "$AIOS_AGENT_WORKSPACE"'],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AIOS_AGENT_WORKSPACE: "",
          AIOS_AGENT_ENV_FILE: zshenv,
          ZDOTDIR: root,
        },
      }
    );
    assert.equal(source.status, 0, source.stderr);
    assert.equal(source.stdout.trim(), workspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scaffold passes its resolved workspace directory to the shell installer", () => {
  const scaffold = readFileSync(SCAFFOLD_SCRIPT, "utf8");
  assert.match(
    scaffold,
    /cd "\$OUTPUT"[\s\S]*?install-aios-shell\.sh" --agent-workspace "\$PWD"/,
    "relative --output paths must not be re-resolved beneath the newly created workspace"
  );
});
