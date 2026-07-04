#!/usr/bin/env node
// test/council-models.test.mjs — council panel config + diversity guard (AIO-225 P0).

import {
  resolveCouncilConfig,
  assertDiverse,
  normalizePanelModels,
  modelFamily,
  DEFAULT_COUNCIL_MODELS,
} from "../scripts/council-models.mjs";
import { parseCouncilArgs } from "../scripts/council.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MODELS_LOADER = path.join(DIR, "..", "scripts", "council-models.mjs");
const COUNCIL_LOADER = path.join(DIR, "..", "scripts", "council.mjs");

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

function dieInChild(fnBody) {
  const script =
    `import * as m from ${JSON.stringify(MODELS_LOADER)};` +
    `try { ${fnBody}; process.stdout.write("ok"); }` +
    `catch (e) { process.stderr.write(String(e?.message ?? e)); process.exit(1); }`;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, stderr: `${e.stderr ?? ""}` };
  }
}

console.log("modelFamily");
{
  check("claude → anthropic", modelFamily("anthropic/claude-opus-4-8") === "anthropic");
  check("gpt → openai", modelFamily("openai/gpt-5.5") === "openai");
  check("gemini → google", modelFamily("google/gemini-3.5-flash") === "google");
  check("empty id → other", modelFamily("") === "other");
}

console.log("normalizePanelModels");
{
  check(
    "drops blanks from trailing comma",
    normalizePanelModels(["openai/gpt-5.5", "google/gemini-3.5-flash", ""]).length === 2
  );
  const tooFew = dieInChild(`m.normalizePanelModels(["openai/gpt-5.5", ""])`);
  check("rejects fewer than 2 after blank drop", tooFew.ok === false);
}

console.log("assertDiverse");
{
  const diverse = assertDiverse(["openai/gpt-5.5", "google/gemini-3.5-flash"]);
  check("returns normalized panel", diverse.length === 2);
  const sameFamily = dieInChild(
    `m.assertDiverse(["anthropic/claude-sonnet-4", "anthropic/claude-opus-4"])`
  );
  check("rejects single-family panel", sameFamily.ok === false);
  const blankPad = dieInChild(
    `m.assertDiverse(["anthropic/claude-sonnet-4", "anthropic/claude-opus-4", ""])`
  );
  check("blank id cannot pad diversity", blankPad.ok === false);
}

console.log("resolveCouncilConfig");
{
  const empty = mkdtempSync(path.join(tmpdir(), "council-empty-"));
  check(
    "no file → defaults",
    JSON.stringify(resolveCouncilConfig(empty).models) === JSON.stringify(DEFAULT_COUNCIL_MODELS)
  );
  rmSync(empty, { recursive: true, force: true });

  const repo = mkdtempSync(path.join(tmpdir(), "council-file-"));
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  writeFileSync(
    path.join(repo, ".aios", "council-models.yaml"),
    "council_models:\n  - openai/gpt-5.5\n  - x-ai/grok-4.3\n"
  );
  check(
    "file override wins",
    resolveCouncilConfig(repo).models.join(",") === "openai/gpt-5.5,x-ai/grok-4.3"
  );
  writeFileSync(
    path.join(repo, ".aios", "council-models.yaml"),
    "chairman_model: openai/gpt-5.5\n"
  );
  const badFile = dieInChild(
    `import { resolveCouncilConfig } from ${JSON.stringify(MODELS_LOADER)};` +
      `resolveCouncilConfig(${JSON.stringify(repo)});`
  );
  check("invalid file fails closed (no silent default)", badFile.ok === false);
  rmSync(repo, { recursive: true, force: true });

  check(
    "CLI override wins",
    resolveCouncilConfig(null, { modelsOverride: ["openai/gpt-5.5", "google/gemini-3.5-flash"] })
      .models.length === 2
  );
}

console.log("parseCouncilArgs");
{
  const parsed = parseCouncilArgs([
    "Should",
    "we",
    "ship?",
    "--models",
    "openai/gpt-5.5,google/gemini-3.5-flash",
  ]);
  check("joins positional question", parsed.question === "Should we ship?");
  check("parses models override", parsed.modelsOverride?.length === 2);
  const missingVal = (() => {
    const script =
      `import { parseCouncilArgs } from ${JSON.stringify(COUNCIL_LOADER)};` +
      `parseCouncilArgs(["q", "--models"]);`;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, stderr: `${e.stderr ?? ""}` };
    }
  })();
  check("--models without value dies", missingVal.ok === false);
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
