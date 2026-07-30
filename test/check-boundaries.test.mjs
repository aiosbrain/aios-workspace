// AIO-597 — repo-boundary / seam gate (scripts/check-boundaries.mjs).
// Runs the real gate against a synthetic tree in a temp cwd (mirrors
// test/check-domain-isolation.test.mjs), proving it (a) flags an un-grandfathered cross-seam deep
// import, (b) allows the same import once it is grandfathered, (c) passes a clean tree, and
// (d) passes on THIS repo's actual tree with its real, measured allowlist.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-boundaries.mjs");

function minimalRules(extraGrandfathered = []) {
  return {
    rules: [
      {
        id: "R1",
        description: "scripts/<cmd>/* is importable only via its barrel or same-dir siblings.",
        from: "scripts/**",
        to: "scripts/*/**",
      },
      {
        id: "R2",
        description: "hooks/** import barrels only.",
        from: "hooks/**",
        to: "scripts/*/**",
      },
      {
        id: "R3",
        description: "src/** never imports scripts/**.",
        from: "src/**",
        to: "scripts/**",
      },
      {
        id: "R4",
        description: "gui/server never deep-imports scripts/**.",
        from: "gui/server/**",
        to: "scripts/**",
      },
      { id: "R5", description: "nothing imports test/**.", from: "**", to: "test/**" },
    ],
    grandfathered: extraGrandfathered,
  };
}

// Sets up a temp dir with a fixed synthetic tree (a "sealed" scripts/widgets/ cmd dir with no
// barrel, a hooks/ file, a src/ file, and a gui/server file) plus a caller-supplied set of extra
// files, then runs the real script against it with an isolated, minimal rules file.
function runIn({ grandfathered = [], extraFiles = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "boundaries-"));
  try {
    mkdirSync(path.join(dir, "scripts", "widgets"), { recursive: true });
    writeFileSync(
      path.join(dir, "scripts", "widgets", "internal.mjs"),
      `export const widgetSecret = 1;\n`
    );
    for (const [rel, body] of Object.entries(extraFiles)) {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), body);
    }
    const rulesPath = path.join(dir, "boundaries.json");
    writeFileSync(rulesPath, JSON.stringify(minimalRules(grandfathered), null, 2));

    try {
      const stdout = execFileSync("node", [SCRIPT], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, CHECK_BOUNDARIES_RULES_PATH: rulesPath },
      });
      return { code: 0, out: stdout };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("catches an un-grandfathered R1 deep import into a sealed scripts/<cmd>/ dir", () => {
  const r = runIn({
    extraFiles: {
      "scripts/other.mjs": `import { widgetSecret } from "./widgets/internal.mjs";\nexport const x = widgetSecret;\n`,
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /\[R1\]/);
  assert.match(r.out, /scripts\/other\.mjs:1/);
  assert.match(r.out, /scripts\/widgets\/internal\.mjs/);
});

test("passes the identical import once it is grandfathered", () => {
  const r = runIn({
    extraFiles: {
      "scripts/other.mjs": `import { widgetSecret } from "./widgets/internal.mjs";\nexport const x = widgetSecret;\n`,
    },
    grandfathered: [
      {
        from: "scripts/other.mjs",
        to: "scripts/widgets/internal.mjs",
        reason: "test fixture",
        issue: "AIO-597",
      },
    ],
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /clean/);
});

test("passes a clean tree with no cross-seam imports (and no unused grandfathers)", () => {
  const r = runIn({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /clean/);
});

test("allows a same-dir sibling inside scripts/<cmd>/ (no barrel needed)", () => {
  const r = runIn({
    extraFiles: {
      "scripts/widgets/other.mjs": `import { widgetSecret } from "./internal.mjs";\nexport const y = widgetSecret;\n`,
    },
  });
  assert.equal(r.code, 0, r.out);
});

test("allows a cmd's own top-level barrel importing its subdirectory", () => {
  const r = runIn({
    extraFiles: {
      "scripts/widgets.mjs": `export { widgetSecret } from "./widgets/internal.mjs";\n`,
    },
  });
  assert.equal(r.code, 0, r.out);
});

test("recognizes an `export … from` re-export as a value import, not just `import … from`", () => {
  const r = runIn({
    extraFiles: {
      "scripts/other.mjs": `export { widgetSecret } from "./widgets/internal.mjs";\n`,
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /\[R1\]/);
});

test("a comment containing the word 'import' does not create a false match", () => {
  const r = runIn({
    extraFiles: {
      "scripts/other.mjs": `// this module does not import anything from widgets, on purpose\nexport const z = 1;\n`,
    },
  });
  assert.equal(r.code, 0, r.out);
});

test("flags hooks/** reaching into a scripts/<cmd>/ subdirectory (R2)", () => {
  const r = runIn({
    extraFiles: {
      "hooks/probe.mjs": `import { widgetSecret } from "../scripts/widgets/internal.mjs";\nexport const p = widgetSecret;\n`,
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /\[R2\]/);
});

test("allows hooks/** importing a top-level scripts/*.mjs barrel", () => {
  const r = runIn({
    extraFiles: {
      "scripts/plain.mjs": `export const plain = 1;\n`,
      "hooks/probe.mjs": `import { plain } from "../scripts/plain.mjs";\nexport const p = plain;\n`,
    },
  });
  assert.equal(r.code, 0, r.out);
});

test("flags src/** importing scripts/** at all (R3)", () => {
  const r = runIn({
    extraFiles: {
      "src/operator-loop/thing.ts": `import { plain } from "../../scripts/plain.mjs";\nexport const t = plain;\n`,
      "scripts/plain.mjs": `export const plain = 1;\n`,
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /\[R3\]/);
});

test("flags gui/server deep-importing scripts/** (R4)", () => {
  const r = runIn({
    extraFiles: {
      "gui/server/x.mjs": `import { plain } from "../../scripts/plain.mjs";\nexport const g = plain;\n`,
      "scripts/plain.mjs": `export const plain = 1;\n`,
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /\[R4\]/);
});

test("flags anything outside test/ importing test/** (R5)", () => {
  const r = runIn({
    extraFiles: {
      "scripts/leaky.mjs": `import { fixture } from "../test/fixture.mjs";\nexport const l = fixture;\n`,
      "test/fixture.mjs": `export const fixture = 1;\n`,
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /\[R5\]/);
});

test("flags a core file importing the devtools path set (R6)", () => {
  const r = runIn({
    extraFiles: {
      "scripts/build.mjs": `export const b = 1;\n`,
      "scripts/core-thing.mjs": `import { b } from "./build.mjs";\nexport const x = b;\n`,
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /\[R6\]/);
});

test("devtools-internal and devtools→core imports are not R6", () => {
  const r = runIn({
    extraFiles: {
      "scripts/plain.mjs": `export const plain = 1;\n`,
      "scripts/build.mjs": `export const b = 1;\n`,
      // devtools-internal (ship → build) and devtools → core (ship/runtime → plain) both allowed.
      "scripts/ship.mjs": `import { b } from "./build.mjs";\nexport { runtime } from "./ship/runtime.mjs";\nexport const s = b;\n`,
      "scripts/ship/runtime.mjs": `import { plain } from "../plain.mjs";\nexport const runtime = plain;\n`,
    },
  });
  assert.equal(r.code, 0, r.out);
});

test("flags a bare lazy-loader dynamic import of the devtools path set (R6 regression)", () => {
  // The CLI registry's loaders are `loader: () => import("../x.mjs")` — bare `import(`, no
  // `await`. The parser must see these (AIO-594 D4 review: it originally only matched
  // `await import(` / `require(`, leaving the five registry→devtools couplings invisible).
  const files = {
    "scripts/build.mjs": `export const b = 1;\n`,
    "scripts/cli/registry.mjs": `export const cmds = [{ name: "build", loader: () => import("../build.mjs") }];\n`,
  };
  const flagged = runIn({ extraFiles: files });
  assert.equal(flagged.code, 1);
  assert.match(flagged.out, /\[R6\]/);
  assert.match(flagged.out, /dynamic import/);

  const grandfathered = runIn({
    extraFiles: files,
    grandfathered: [
      {
        from: "scripts/cli/registry.mjs",
        to: "scripts/build.mjs",
        reason: "lazy loader",
        issue: "AIO-594",
      },
    ],
  });
  assert.equal(grandfathered.code, 0, grandfathered.out);
});

test("exempts a test source file from R6 (devtools test ownership is the cut manifest's call)", () => {
  const r = runIn({
    extraFiles: {
      "scripts/ship.mjs": `export const s = 1;\n`,
      "test/ship-thing.test.mjs": `import { s } from "../scripts/ship.mjs";\nexport const t = s;\n`,
    },
  });
  assert.equal(r.code, 0, r.out);
});

test("exempts a *.test.mjs source file from R1-R4 (tests reach into internals)", () => {
  const r = runIn({
    extraFiles: {
      "scripts/other.test.mjs": `import { widgetSecret } from "./widgets/internal.mjs";\nexport const w = widgetSecret;\n`,
    },
  });
  assert.equal(r.code, 0, r.out);
});

test("rejects a stale grandfather entry (coupling no longer present in the tree)", () => {
  const r = runIn({
    grandfathered: [
      {
        from: "scripts/other.mjs",
        to: "scripts/widgets/internal.mjs",
        reason: "test fixture — deliberately unused",
        issue: "AIO-597",
      },
    ],
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /stale/);
});

test("passes on this repo's real tree with its real, measured boundaries.json", () => {
  const stdout = execFileSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.match(stdout, /clean/);
});
