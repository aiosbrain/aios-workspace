import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const slackPy = join(root, "scaffold/.claude/descriptors/skills/slack-personal/slack.py");
const pinFile = join(root, "scaffold/.claude/descriptors/skills/slack-personal/slack.py.sha256");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const actual = sha256(slackPy);
const expected = readFileSync(pinFile, "utf8").trim();

if (actual !== expected) {
  console.error("slack-cli-sync: slack.py SHA256 mismatch");
  console.error(`  pin:    ${expected}`);
  console.error(`  actual: ${actual}`);
  console.error(
    "  canonical source: THIS file (scaffold/.claude/descriptors/skills/slack-personal/slack.py)."
  );
  console.error(
    "  hermes-aluna/bin/slack.py and any workspace .claude/skills/slack-personal/ copy are"
  );
  console.error(
    "  DEPLOYMENTS of it, not sources. Change it here, re-pin, then propagate outward —"
  );
  console.error(
    "  the two copies drifted in OPPOSITE directions once already (one gained `file`, the"
  );
  console.error("  other `resolve --member`) precisely because the direction was ambiguous.");
  process.exit(1);
}

console.log(`slack-cli-sync: ok (${actual.slice(0, 12)}…)`);

const help = spawnSync("python3", [slackPy, "dm", "--help"], { encoding: "utf8" });
if (help.status !== 0 || !help.stdout.includes("--message-stdin")) {
  console.error("slack-cli-sync: multiline message input is not exposed by the CLI");
  process.exit(1);
}

console.log("slack-cli-sync: multiline input ok");

// The verb surface is the thing that silently diverged between copies. Assert it here, where a
// missing verb is a one-line failure, rather than discovering it from an agent that fell back to
// some other tool because `slack file` did not exist in the copy it happened to reach.
const top = spawnSync("python3", [slackPy, "--help"], { encoding: "utf8" });
for (const verb of ["file", "resolve", "dm", "send", "read", "react", "channels", "whoami"]) {
  if (!top.stdout.includes(verb)) {
    console.error(`slack-cli-sync: the CLI no longer exposes '${verb}'`);
    process.exit(1);
  }
}

console.log("slack-cli-sync: verb surface ok");

// The CLI promises plain `python3`, and `/usr/bin/python3` is 3.9 on macOS. A 3.12-only
// construct (PEP 701 lets an f-string reuse its own quote type) is a SyntaxError there — the
// whole CLI fails to parse, every verb, before anything runs. It shipped past 18 green tests
// because they all ran on the newest interpreter on the box, which is the only one that
// accepted it. So compile it under the OLDEST python3 we can find, not the default one.
const olderPythons = ["/usr/bin/python3", "python3.9", "python3.10", "python3.11"];
let checkedOlder = null;
for (const py of olderPythons) {
  const probe = spawnSync(py, ["-c", "import sys; print(sys.version_info[:2])"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) continue;
  // ast.parse, NOT py_compile: py_compile writes __pycache__/*.pyc NEXT TO THE SOURCE, inside
  // scaffold/, where it gets picked up by the pack-manifest test as content that would ship in
  // the tarball. Parsing detects the same syntax error and leaves nothing behind.
  const compiled = spawnSync(
    py,
    ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", slackPy],
    { encoding: "utf8" }
  );
  if (compiled.status !== 0) {
    console.error(`slack-cli-sync: slack.py does not compile under ${py} ${probe.stdout.trim()}`);
    console.error(`  ${(compiled.stderr || "").trim().split("\n").slice(-3).join("\n  ")}`);
    console.error(
      "  The CLI is invoked as plain `python3`; it must parse on the oldest one present."
    );
    process.exit(1);
  }
  checkedOlder = `${py} ${probe.stdout.trim()}`;
  break;
}
console.log(
  checkedOlder
    ? `slack-cli-sync: parses under ${checkedOlder}`
    : "slack-cli-sync: no older python3 found to cross-check (skipped)"
);
