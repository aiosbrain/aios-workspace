#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { compactSkillIndex, loadSkillSuite, routeSkillPrompt } from "../scripts/skill-context.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.argv[2] ?? path.join(HERE, ".."));

function fail(message) {
  console.error(`FAIL delivery skill suite: ${message}`);
  process.exitCode = 1;
}

function check(condition, message) {
  if (!condition) fail(message);
}

try {
  const manifestPath = path.join(repo, ".claude", "skill-suite.json");
  const schemaPath = path.join(repo, ".claude", "skill-suite.schema.json");
  const corpusPath = path.join(repo, ".claude", "skill-trigger-corpus.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    for (const error of validate.errors ?? [])
      fail(`manifest schema ${error.instancePath || "/"} ${error.message}`);
  }

  const suite = loadSkillSuite({ repo, manifestPath });
  const compact = compactSkillIndex({ repo, manifestPath });
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  check(corpus.version === 1, "trigger corpus version must be 1");
  check(Array.isArray(corpus.cases), "trigger corpus cases must be an array");
  const casesById = new Map((corpus.cases ?? []).map((entry) => [entry.id, entry]));
  check(
    casesById.size === suite.skills.length,
    "trigger corpus must cover every manifest skill once"
  );

  for (const skill of suite.skills) {
    const entry = casesById.get(skill.id);
    check(Boolean(entry), `${skill.id}: missing trigger corpus entry`);
    if (!entry) continue;
    for (const [field, count] of [
      ["positive", 5],
      ["negative", 5],
      ["overlap", 3],
      ["pressure", 2],
    ]) {
      check(
        Array.isArray(entry[field]) && entry[field].length >= count,
        `${skill.id}: ${field} needs at least ${count} cases`
      );
    }
    check(typeof entry.explicit === "string", `${skill.id}: explicit case is required`);

    for (const prompt of entry.positive ?? []) {
      const routed = routeSkillPrompt({ suite, prompt });
      if (skill.explicit_invocation_required)
        check(routed?.id !== skill.id, `${skill.id}: mutation skill auto-selected on '${prompt}'`);
      else check(routed?.id === skill.id, `${skill.id}: positive did not select on '${prompt}'`);
    }
    for (const prompt of [...(entry.negative ?? []), ...(entry.overlap ?? [])]) {
      const routed = routeSkillPrompt({ suite, prompt });
      check(routed?.id !== skill.id, `${skill.id}: selected on exclusion case '${prompt}'`);
    }
    for (const prompt of entry.pressure ?? []) {
      const routed = routeSkillPrompt({ suite, prompt });
      if (skill.explicit_invocation_required)
        check(routed?.id !== skill.id, `${skill.id}: mutation pressure case auto-selected`);
      else check(routed?.id === skill.id, `${skill.id}: pressure case did not retain selection`);
    }
    check(
      routeSkillPrompt({ suite, prompt: entry.explicit })?.id === skill.id,
      `${skill.id}: explicit case did not select`
    );
  }

  if (!process.exitCode) {
    console.log(
      `PASS delivery skill suite: ${suite.skills.length} skills, compact index ${compact.bytes} bytes`
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
