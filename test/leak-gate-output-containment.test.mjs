// test/leak-gate-output-containment.test.mjs
//
// The confidentiality leak gate must never become the disclosure it exists to prevent.
//
// It used to print the matching `grep -n` lines, which wrote the protected identifier into
// terminal scrollback — and, because scripts/build.mjs, scripts/promote.mjs and
// scripts/timeline.mjs each CAPTURE the gate's stdout+stderr and re-emit it into findings /
// review context / rendered output, into downstream artifacts too. With
// $AIOS_LEAK_TERMS_B64 configured it also reached the CI job log, which is typically
// readable by more people than the repository being protected.
//
// The contract asserted here:
//   1. exit 1 for ANY detected leak (the fail-closed boundary in SECURITY.md that
//      build/promote/timeline all depend on) — unchanged, and there is no new exit code;
//   2. the literal `leak-gate: FAILED` line survives as the stable machine-visible marker;
//   3. `leak-gate: CLEAN` survives on the clean path;
//   4. NONE of the configured STRONG / WORDS / PATTERNS terms appear anywhere in the
//      COMBINED stdout+stderr — that combination is precisely what the callers capture;
//   5. a matching file's path is never printed, because a path segment can itself carry a
//      protected identifier. Location is allowlisted to known-safe top-level directory
//      names, or withheld;
//   6. the opt-in $AIOS_LEAK_GATE_DETAIL_FILE is the ONLY place matched content is written,
//      and it is mode 0600.
//
// Every protected-looking string is assembled at runtime by concatenation so this committed
// file never contains a literal the gate (or the NDA pre-commit hook) would flag.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEAK_GATE = path.join(REPO, "scripts", "leak-gate.sh");
const RUN_TIMEOUT_MS = 120_000;

// Assembled at runtime — never literals in this committed file.
const STRONG_TERM = "wonka" + "-" + "group";
const WORD_TERM = "Init" + "ech";
const PATTERN_TEXT = "TICKET" + "-" + "4471";
const PATTERN_RE = "TICKET-[0-9]+";

const TERMS_SH =
  `STRONG='${STRONG_TERM}'\n` + `WORDS='${WORD_TERM}'\n` + `PATTERNS='${PATTERN_RE}'\n`;

/** Every byte the gate must never emit. */
const FORBIDDEN = [STRONG_TERM, WORD_TERM, PATTERN_TEXT, PATTERN_RE];

function assertNoForbiddenBytes(out, context) {
  for (const term of FORBIDDEN) {
    assert.ok(
      !out.includes(term),
      `the gate emitted a protected term (${context}). ` +
        `Output must never contain the matched text; got:\n${out}`
    );
  }
  // Absolute paths are the same disclosure class: a checkout can live under a
  // confidentially-named directory, and callers invoke the gate by absolute path, so any
  // echo of $0 or $ROOT would carry that name into the captured stdout they re-emit.
  assert.ok(
    !out.includes(REPO),
    `the gate emitted its own absolute path (${context}) — a checkout directory can ` +
      `itself be confidential; use a fixed relative string instead:\n${out}`
  );
}

function termsFileIn(dir) {
  const file = path.join(dir, "terms.sh");
  writeFileSync(file, TERMS_SH);
  return file;
}

function run(args, env = {}) {
  const res = spawnSync("bash", [LEAK_GATE, ...args], {
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env, ...env },
  });
  assert.ok(res.status !== null, `leak-gate did not terminate (killed by ${res.signal})`);
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    // Exactly what build.mjs / promote.mjs / timeline.mjs capture and re-emit.
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/** A throwaway git repo; content is planted by the caller. */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "leakout-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "leak-gate output test");
  git("config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "2-work"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# sandbox\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return dir;
}

function withDirs(fn) {
  const dir = makeRepo();
  const termsDir = mkdtempSync(path.join(tmpdir(), "leakout-terms-"));
  try {
    fn(dir, termsDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(termsDir, { recursive: true, force: true });
  }
}

// ── the three term classes ──────────────────────────────────────────────────

for (const [label, body] of [
  ["STRONG (substring, case-insensitive)", `engagement with ${STRONG_TERM.toUpperCase()}\n`],
  ["WORDS (whole word)", `met ${WORD_TERM} today\n`],
  ["PATTERNS (business data)", `see ${PATTERN_TEXT} for detail\n`],
]) {
  test(`leak-gate: a ${label} hit blocks with exit 1 and emits none of the terms`, () => {
    withDirs((dir, termsDir) => {
      writeFileSync(path.join(dir, "2-work", "draft.md"), body);
      const r = run([dir], { AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir) });

      assert.equal(r.code, 1, `expected the fail-closed exit 1, got ${r.code}:\n${r.out}`);
      assert.match(r.out, /leak-gate: FAILED/, "the stable FAILED marker must survive");
      assertNoForbiddenBytes(r.out, label);
    });
  });
}

// ── the path/filename vector ────────────────────────────────────────────────

test("leak-gate: a matching file's NAME is never printed, even under an allowlisted dir", () => {
  withDirs((dir, termsDir) => {
    // The filename itself carries the protected term — printing the path would leak it.
    const name = `${STRONG_TERM}-notes.md`;
    writeFileSync(path.join(dir, "2-work", name), `client ${STRONG_TERM}\n`);
    const r = run([dir], { AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir) });

    assert.equal(r.code, 1, `expected exit 1, got ${r.code}:\n${r.out}`);
    assertNoForbiddenBytes(r.out, "confidential filename");
    assert.ok(!r.out.includes(name), `the filename was printed:\n${r.out}`);
    // The allowlisted parent directory IS safe to name, and is how you find it.
    assert.match(r.out, /under: 2-work/, `expected the allowlisted location:\n${r.out}`);
  });
});

test("leak-gate: a confidential DIRECTORY segment is withheld, not guessed at", () => {
  withDirs((dir, termsDir) => {
    const secretDir = `${STRONG_TERM}-engagement`;
    mkdirSync(path.join(dir, secretDir), { recursive: true });
    writeFileSync(path.join(dir, secretDir, "notes.md"), `client ${STRONG_TERM}\n`);
    const r = run([dir], { AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir) });

    assert.equal(r.code, 1, `expected exit 1, got ${r.code}:\n${r.out}`);
    assertNoForbiddenBytes(r.out, "confidential directory");
    assert.match(r.out, /location withheld/, `unrecognised dirs must be withheld:\n${r.out}`);
  });
});

test("leak-gate: a single-file argument reports no filename (aios promote path)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "leakout-file-"));
  const termsDir = mkdtempSync(path.join(tmpdir(), "leakout-terms-"));
  try {
    const file = path.join(dir, "promoted.md");
    writeFileSync(file, `client: ${STRONG_TERM}\n`);
    const r = run([file], { AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir) });

    assert.equal(r.code, 1, `expected exit 1 on a single file, got ${r.code}:\n${r.out}`);
    assertNoForbiddenBytes(r.out, "single file");
    assert.ok(!r.out.includes("promoted.md"), `the filename was printed:\n${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(termsDir, { recursive: true, force: true });
  }
});

// ── both term-delivery channels ─────────────────────────────────────────────

test("leak-gate: terms delivered via AIOS_LEAK_TERMS_B64 are equally contained", () => {
  withDirs((dir) => {
    writeFileSync(path.join(dir, "2-work", "draft.md"), `client ${STRONG_TERM}\n`);
    const r = run([dir], {
      AIOS_LEAK_TERMS_FILE: "/nonexistent/terms.sh",
      AIOS_LEAK_TERMS_B64: Buffer.from(TERMS_SH, "utf8").toString("base64"),
    });

    assert.equal(r.code, 1, `expected exit 1 via B64 terms, got ${r.code}:\n${r.out}`);
    assert.match(r.out, /leak-gate: FAILED/);
    assertNoForbiddenBytes(r.out, "AIOS_LEAK_TERMS_B64");
  });
});

// ── multiple hits, and the clean path ───────────────────────────────────────

test("leak-gate: multiple hits across categories are counted, never quoted", () => {
  withDirs((dir, termsDir) => {
    writeFileSync(path.join(dir, "2-work", "a.md"), `client ${STRONG_TERM}\n`);
    writeFileSync(path.join(dir, "2-work", "b.md"), `client ${STRONG_TERM}\n`);
    writeFileSync(path.join(dir, "2-work", "c.md"), `ref ${PATTERN_TEXT}\n`);
    const r = run([dir], { AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir) });

    assert.equal(r.code, 1, `expected exit 1, got ${r.code}:\n${r.out}`);
    assertNoForbiddenBytes(r.out, "multiple hits");
    assert.match(r.out, /2 file\(s\)/, `expected a substring hit count of 2:\n${r.out}`);
    assert.match(r.out, /business-data pattern/, `expected the pattern category:\n${r.out}`);
  });
});

test("leak-gate: a clean tree still reports CLEAN and exits 0", () => {
  withDirs((dir, termsDir) => {
    writeFileSync(path.join(dir, "2-work", "fine.md"), "nothing sensitive here\n");
    const r = run([dir], { AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir) });

    assert.equal(r.code, 0, `expected a clean exit 0, got ${r.code}:\n${r.out}`);
    assert.match(r.out, /leak-gate: CLEAN/, "the stable CLEAN marker must survive");
    assertNoForbiddenBytes(r.out, "clean run");
  });
});

test("leak-gate: the CLEAN line does not echo ROOT (a path may itself be confidential)", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "leakout-root-"));
  const termsDir = mkdtempSync(path.join(tmpdir(), "leakout-terms-"));
  try {
    // Callers pass arbitrary paths; this one is named after the protected term.
    const dir = path.join(parent, `${STRONG_TERM}-render`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ok.md"), "nothing sensitive\n");
    const r = run([dir], { AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir) });

    assert.equal(r.code, 0, `expected exit 0, got ${r.code}:\n${r.out}`);
    assertNoForbiddenBytes(r.out, "CLEAN line echoing ROOT");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(termsDir, { recursive: true, force: true });
  }
});

// ── the opt-in detail sink ──────────────────────────────────────────────────

test("leak-gate: detail goes ONLY to the opt-in file, which is mode 0600", () => {
  withDirs((dir, termsDir) => {
    writeFileSync(path.join(dir, "2-work", "draft.md"), `client ${STRONG_TERM}\n`);
    const detail = path.join(termsDir, "detail.txt");
    const r = run([dir], {
      AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir),
      AIOS_LEAK_GATE_DETAIL_FILE: detail,
    });

    assert.equal(r.code, 1, `expected exit 1, got ${r.code}:\n${r.out}`);
    // Still nothing on the streams the callers capture.
    assertNoForbiddenBytes(r.out, "detail-file mode");

    const body = readFileSync(detail, "utf8");
    assert.ok(body.includes(STRONG_TERM), "the opt-in detail file must contain the match");
    assert.ok(body.includes("draft.md"), "the opt-in detail file must contain the path");

    const mode = statSync(detail).mode & 0o777;
    assert.equal(mode, 0o600, `detail file must be 0600, got ${mode.toString(8)}`);
  });
});

test("leak-gate: an unwritable detail file degrades without weakening the gate", () => {
  withDirs((dir, termsDir) => {
    writeFileSync(path.join(dir, "2-work", "draft.md"), `client ${STRONG_TERM}\n`);
    const r = run([dir], {
      AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir),
      AIOS_LEAK_GATE_DETAIL_FILE: "/nonexistent-dir/detail.txt",
    });

    assert.equal(r.code, 1, `the gate must still block, got ${r.code}:\n${r.out}`);
    assert.match(r.out, /leak-gate: FAILED/);
    assertNoForbiddenBytes(r.out, "unwritable detail file");
  });
});

// ── tracing must not defeat the containment ─────────────────────────────────

test("leak-gate: an inherited `set -x` cannot trace the protected terms out", () => {
  withDirs((dir, termsDir) => {
    writeFileSync(path.join(dir, "2-work", "draft.md"), `client ${STRONG_TERM}\n`);
    const res = spawnSync("bash", ["-x", LEAK_GATE, dir], {
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
      env: { ...process.env, AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir) },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    assert.equal(res.status, 1, `expected exit 1 under bash -x, got ${res.status}:\n${out}`);
    assertNoForbiddenBytes(out, "bash -x tracing");
  });
});

// ── a grep without --null must fail CLOSED, never silently clean ───────────

test("leak-gate: a grep that rejects --null still blocks (no silent fail-open)", () => {
  withDirs((dir, termsDir) => {
    writeFileSync(path.join(dir, "2-work", "draft.md"), `client ${STRONG_TERM}\n`);

    // Shadow `grep` with one that rejects --null the way an old//minimal grep would.
    // Without the capability probe this makes every sweep return empty, and the gate
    // would report CLEAN over a leaking tree — the fail-open this guards against.
    const binDir = path.join(termsDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, "grep");
    writeFileSync(
      shim,
      "#!/usr/bin/env bash\n" +
        'for a in "$@"; do\n' +
        '  if [ "$a" = "--null" ]; then\n' +
        "    echo \"grep: unrecognized option '--null'\" >&2; exit 2\n" +
        "  fi\n" +
        "done\n" +
        'exec /usr/bin/grep "$@"\n'
    );
    execFileSync("chmod", ["+x", shim]);

    const r = run([dir], {
      AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir),
      PATH: `${binDir}:${process.env.PATH}`,
    });

    assert.equal(r.code, 1, `a --null-less grep must still block, got ${r.code}:\n${r.out}`);
    assert.match(r.out, /leak-gate: FAILED/);
    assert.match(r.out, /1 file\(s\)/, `expected the hit to be counted:\n${r.out}`);
    assertNoForbiddenBytes(r.out, "grep without --null");
  });
});

// ── the caller boundary: what build/promote/timeline actually embed ─────────

test("leak-gate: captured stdout+stderr is safe to embed in caller findings", () => {
  withDirs((dir, termsDir) => {
    writeFileSync(path.join(dir, "2-work", "draft.md"), `client ${STRONG_TERM}\n`);

    // Reproduces the exact capture shape used by promote.mjs (and build.mjs / timeline.mjs):
    // execFileSync with piped stdio, then `${e.stdout}${e.stderr}` folded into a finding.
    let captured = "";
    let threw = false;
    try {
      execFileSync("bash", [LEAK_GATE, dir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AIOS_LEAK_TERMS_FILE: termsFileIn(termsDir) },
      });
    } catch (e) {
      threw = true;
      captured = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    }

    assert.ok(threw, "a leak must make the gate throw for callers (non-zero exit)");
    assert.ok(captured.length > 0, "callers must still receive an explanatory finding");
    assertNoForbiddenBytes(captured, "caller-captured finding");
  });
});
