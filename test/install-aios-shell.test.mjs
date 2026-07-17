import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Toolkit-resolution precedence for the installed `aios()` shell function. The rule under
// test: EXPLICIT config always beats the conventional ~/Projects default — otherwise a user
// with a custom path who also happens to have the default checkout on disk silently runs the
// wrong one. Exercised by extracting the real function from the installer and sourcing it.

const SCRIPT = fileURLToPath(new URL("../scripts/install-aios-shell.sh", import.meta.url));

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
    const fnFile = path.join(scratch, "fn.sh");
    writeFileSync(fnFile, `${aiosFunctionSource()}\n`);
    const res = spawnSync("bash", ["-c", `source ${fnFile}; aios`], {
      cwd: scratch,
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });
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

test("falls back to the ~/Projects default when nothing is configured", () => {
  const { root, home } = makeEnvRoots();
  try {
    const out = runAios({ HOME: home });
    assert.match(out, /RAN_DEFAULT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
