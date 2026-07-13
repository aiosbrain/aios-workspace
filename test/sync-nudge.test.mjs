import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "hooks", "aios-sync-nudge.sh");

function fixture({ deepWork = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-nudge-"));
  const home = path.join(dir, "home");
  mkdirSync(path.join(dir, "hooks"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  copyFileSync(HOOK, path.join(dir, "hooks", "aios-sync-nudge.sh"));
  chmodSync(path.join(dir, "hooks", "aios-sync-nudge.sh"), 0o755);
  writeFileSync(path.join(dir, "aios.yaml"), "workspace: test\n");
  writeFileSync(
    path.join(dir, "scripts", "aios.mjs"),
    "#!/usr/bin/env node\nconsole.log('status new=2 modified=1');\n"
  );
  writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify(deepWork ? { preferredNotifChannel: "notifications_disabled" } : {})
  );
  return { dir, home };
}

function runHook(dir, home) {
  return execFileSync("bash", [path.join(dir, "hooks", "aios-sync-nudge.sh")], {
    cwd: dir,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

test("hook file is executable", () => {
  assert.ok(statSync(HOOK).mode & 0o111);
});

test("reports the number of pending sync-eligible files", () => {
  const { dir, home } = fixture();
  try {
    assert.match(runHook(dir, home), /aios: 3 sync-eligible file\(s\) changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deep-work mode suppresses the sync nudge", () => {
  const { dir, home } = fixture({ deepWork: true });
  try {
    assert.equal(runHook(dir, home), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
