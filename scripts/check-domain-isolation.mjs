#!/usr/bin/env node
/**
 * Operator-loop domain-isolation guard (Engineering Constitution §4).
 *
 * "Domains are siblings, not friends." A workflow domain under `src/operator-loop/<domain>/`
 * must NOT value-import another domain's internals — the Operator Loop (`src/operator-loop/index.ts`)
 * is the only composition point, and domains interact through the loop's injected deps + typed
 * signals, never direct calls.
 *
 * This validator flags **value** imports across peer domains. It intentionally ALLOWS:
 *   - `import type { … }` across domains — typed, tier-tagged contracts are the legitimate seam (§4).
 *   - imports of loop-core modules that live directly under `src/operator-loop/` (collector, signal,
 *     manifest, ledger, index, …) — domains compose *through* the loop.
 *   - the `sources/` collector-adapter layer — a source reading a domain store to emit C1 signals is
 *     the collection step, not a peer-domain reach (see the contract in src/operator-loop/sources/*).
 *
 * Static parsing (static `import … from`, plus dynamic `await import("x")` / `require("x")` value
 * forms); reports file:line evidence and exits non-zero on any violation.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LOOP_DIR = path.join(ROOT, "src", "operator-loop");

// The five workflow domains that feed the loop (docs/v1-operator-loop/domains/*). `sources` is the
// collector's adapter layer (loop-core), NOT a peer domain, so it is deliberately absent here.
const DOMAIN_DIRS = new Set(["asks", "comms", "decisions", "time", "maturity", "inbox"]);

function walkTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// Domain a loop file belongs to, or null if it's loop-core / a non-domain subtree (e.g. sources/).
function domainOf(file) {
  const rel = path.relative(LOOP_DIR, file);
  const seg = rel.split(path.sep);
  if (seg.length < 2) return null; // a file directly under src/operator-loop/ = loop-core
  return DOMAIN_DIRS.has(seg[0]) ? seg[0] : null;
}

// Match every `import … from "…"` statement (multi-line tolerant). Returns { typeOnly, clause, mod, index }.
function parseImports(content) {
  const re = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  const imports = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    imports.push({ typeOnly: Boolean(m[1]), clause: m[2].trim(), mod: m[3], index: m.index });
  }
  return imports;
}

// A statement brings in a runtime value unless it is `import type …` OR a pure `{ type A, type B }`
// named list where every binding is type-only.
function importsAValue({ typeOnly, clause }) {
  if (typeOnly) return false;
  const braced = clause.match(/^\{([\s\S]*)\}$/);
  if (!braced) return true; // default or namespace import → value
  const names = braced[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return false;
  return names.some((n) => !/^type\s/.test(n));
}

// Dynamic value imports that the static-`from` parser can't see: `await import("x")` and
// `require("x")`. These always pull in a runtime value, so they're a potential evasion of the rule.
// A type-position dynamic import (`type T = import("x").Member`) is never preceded by `await` or
// `require(`, so it is not matched here — type-only cross-domain references stay allowed.
function parseDynamicValueImports(content) {
  const re = /(?:await\s+import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(content)) !== null) out.push({ mod: m[1], index: m.index });
  return out;
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

const violations = [];
for (const file of walkTs(LOOP_DIR)) {
  const own = domainOf(file);
  if (!own) continue; // only peer-domain files are constrained
  const content = readFileSync(file, "utf8");
  const record = (mod, index, detail) => {
    if (!mod.startsWith(".")) return; // external package
    const target = path.resolve(path.dirname(file), mod);
    const targetDomain = domainOf(target.endsWith(".ts") ? target : `${target}.ts`);
    if (!targetDomain || targetDomain === own) return; // same domain or loop-core → fine
    violations.push({
      file: path.relative(ROOT, file),
      line: lineOf(content, index),
      from: own,
      to: targetDomain,
      mod,
      detail,
    });
  };
  for (const imp of parseImports(content)) {
    if (importsAValue(imp)) {
      record(
        imp.mod,
        imp.index,
        imp.clause ? `import { ${imp.clause.replace(/\s+/g, " ")} }` : "(default/namespace import)"
      );
    }
  }
  for (const imp of parseDynamicValueImports(content)) {
    record(imp.mod, imp.index, `dynamic import("${imp.mod}")`);
  }
}

if (violations.length > 0) {
  console.error("✗ operator-loop domain isolation violated (Constitution §4):\n");
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}  [${v.from} → ${v.to}]  value import of ${v.mod}\n      ${v.detail}`
    );
  }
  console.error(
    "\n  A domain must not value-import another domain. Compose through src/operator-loop/index.ts\n" +
      "  (inject deps), or make the cross-domain import `import type { … }` if it is only a contract."
  );
  process.exit(1);
}

console.log("✓ operator-loop domain isolation clean (no cross-domain value imports)");
