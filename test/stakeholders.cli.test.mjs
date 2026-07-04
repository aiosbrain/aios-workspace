#!/usr/bin/env node
// test/stakeholders.cli.test.mjs — spawn the REAL `aios stakeholders` CLI against a stub
// Team-Brain HTTP server. The MCP tests cover the MCP dispatch path; this proves the CLI
// path independently: the tier probe ordering, the --owns/--who/--meeting query logic, the
// /items cursor pagination, 404 tolerance, mode validation, and the --json output shapes.
//
// No real brain: a local http server on 127.0.0.1 answers /api/v1/{me,company-graph,items}
// and branches on the Bearer token so one server drives every scenario.
//
// Run: node test/stakeholders.cli.test.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Async exec — the stub server shares this process's event loop, so the CLI child must run
// non-blocking or the server can never answer its request.
const execFileP = promisify(execFile);

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");

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

// ── Stub brain ────────────────────────────────────────────────────────────────
// Fixture graph mirrors fixtures/veridian: actor-006 (Nadia) OWNS "Month-End Financial
// Close" (job_family Finance) and reports to actor-001 (Elena).
const GRAPH = {
  people: [
    {
      entity_id: "actor-001",
      name: "Elena Vance",
      role: "CFO",
      job_family: "Finance",
      reports_to: null,
    },
    {
      entity_id: "actor-006",
      name: "Nadia Kovalchuk",
      role: "Finance Lead",
      job_family: "Finance",
      reports_to: "actor-001",
    },
  ],
  ownership: [
    {
      person_id: "actor-006",
      relationship: "OWNS",
      target_name: "Month-End Financial Close",
      target_job_family: "Finance",
    },
  ],
};

// /items is paginated: the meeting lives on page 2, so a CLI that fails to follow the
// cursor would miss it. Page 1 holds only a non-meeting artifact.
const ITEMS_PAGE1 = {
  items: [{ path: "2-work/report.md", frontmatter: { title: "Q3 Report" } }],
  next_cursor: "PAGE2",
};
const ITEMS_PAGE2 = {
  items: [
    {
      path: "1-inbox/weekly-sync.md",
      frontmatter: {
        meeting: true,
        title: "Weekly Finance Sync",
        participants: "Nadia Kovalchuk, Elena Vance, Priya Raman",
      },
    },
  ],
  next_cursor: null,
};

function token(req) {
  return String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname.replace(/^\/api\/v1/, "");
  const tok = token(req);

  if (route === "/me") {
    // ext-key is external-tier; every other key is team-tier.
    const tier = tok === "ext-key" ? "external" : "team";
    return send(res, 200, { role: "member", tier });
  }
  if (route === "/company-graph") {
    if (tok === "team-404-key") {
      return send(res, 404, { error: { code: "not_found", message: "no company graph" } });
    }
    if (tok === "team-500-key") {
      return send(res, 500, { error: { code: "internal", message: "boom" } });
    }
    return send(res, 200, GRAPH);
  }
  if (route === "/items") {
    const cursor = url.searchParams.get("cursor");
    return send(res, 200, cursor === "PAGE2" ? ITEMS_PAGE2 : ITEMS_PAGE1);
  }
  return send(res, 404, { error: { code: "not_found", message: "unknown route" } });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const BRAIN_URL = `http://127.0.0.1:${PORT}`;

// Minimal connected workspace so findRepoRoot + loadConfig succeed.
const repoDir = mkdtempSync(path.join(tmpdir(), "stakeholders-cli-"));
writeFileSync(
  path.join(repoDir, "aios.yaml"),
  [
    "version: 1",
    `brain_url: "${BRAIN_URL}"`,
    'team_id: "acme"',
    "api_key_env: AIOS_API_KEY",
    "sync_tiers:",
    "  - team",
    "context: employee",
    "",
  ].join("\n")
);

async function runCli(args, apiKey) {
  const env = {
    ...process.env,
    AIOS_BRAIN_URL: BRAIN_URL,
    AIOS_TEAM: "acme",
    AIOS_API_KEY: apiKey,
  };
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [AIOS, "stakeholders", "--repo", repoDir, ...args],
      { env, encoding: "utf8", timeout: 30000 }
    );
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

// Last JSON object printed on stdout.
function lastJson(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep scanning up */
    }
  }
  return null;
}

try {
  // 1. Tier gate — an external key is rejected up front on every mode, before any data leg.
  console.log("tier gate:");
  for (const mode of [
    ["--owns", "Finance"],
    ["--who", "Nadia"],
    ["--meeting", "Weekly"],
  ]) {
    const r = await runCli([...mode, "--json"], "ext-key");
    check(`${mode[0]} external key → non-zero exit`, r.code !== 0);
    check(
      `${mode[0]} external key → forbidden_tier message`,
      /forbidden_tier/.test(r.stdout + r.stderr)
    );
  }

  // 2. --owns matches the workflow name (case-insensitive substring) → resolves the owner.
  console.log("--owns:");
  {
    const r = await runCli(["--owns", "Financial Close", "--json"], "team-key");
    const j = lastJson(r.stdout);
    check("exit 0", r.code === 0);
    check("mode owns", j?.mode === "owns");
    check("one match", Array.isArray(j?.matches) && j.matches.length === 1);
    check("owner is Nadia Kovalchuk", j?.matches?.[0]?.person === "Nadia Kovalchuk");
    check("relationship OWNS", j?.matches?.[0]?.relationship === "OWNS");
    check("target job_family Finance", j?.matches?.[0]?.job_family === "Finance");
  }
  {
    // Also matches on job_family, and a miss returns an empty matches[] (not person:null).
    const r = await runCli(["--owns", "nothing-here", "--json"], "team-key");
    const j = lastJson(r.stdout);
    check("owns miss → matches: []", Array.isArray(j?.matches) && j.matches.length === 0);
  }

  // 3. --who resolves role, reports_to (id→name), and owned workflows.
  console.log("--who:");
  {
    const r = await runCli(["--who", "nadia", "--json"], "team-key");
    const j = lastJson(r.stdout);
    check("exit 0", r.code === 0);
    check("person name", j?.person?.name === "Nadia Kovalchuk");
    check("reports_to resolved to name", j?.person?.reports_to === "Elena Vance");
    check(
      "owns Month-End Financial Close",
      (j?.person?.owns || []).includes("Month-End Financial Close")
    );
  }
  {
    const r = await runCli(["--who", "nobody", "--json"], "team-key");
    const j = lastJson(r.stdout);
    check("who miss → person: null (not matches[])", j?.mode === "who" && j?.person === null);
  }

  // 4. --meeting follows the /items cursor across pages to find a meeting on page 2.
  console.log("--meeting:");
  {
    const r = await runCli(["--meeting", "Finance Sync", "--json"], "team-key");
    const j = lastJson(r.stdout);
    check("exit 0", r.code === 0);
    check("mode meeting", j?.mode === "meeting");
    check("found meeting across pagination", (j?.meetings || []).length === 1);
    check(
      "participants parsed",
      JSON.stringify(j?.meetings?.[0]?.participants) ===
        JSON.stringify(["Nadia Kovalchuk", "Elena Vance", "Priya Raman"])
    );
  }

  // 5. 404 on /company-graph → clean empty result (older brain), not an error.
  console.log("404 tolerance:");
  {
    const r = await runCli(["--owns", "Finance", "--json"], "team-404-key");
    const j = lastJson(r.stdout);
    check("exit 0 on 404", r.code === 0);
    check(
      "empty owns → matches: []",
      j?.mode === "owns" && Array.isArray(j?.matches) && j.matches.length === 0
    );
    const rw = await runCli(["--who", "Nadia", "--json"], "team-404-key");
    const jw = lastJson(rw.stdout);
    check("empty who → person: null", jw?.mode === "who" && jw?.person === null);
  }

  // 6. A non-404 graph failure surfaces as an error (NOT masqueraded as an empty graph).
  console.log("non-404 error:");
  {
    const r = await runCli(["--owns", "Finance", "--json"], "team-500-key");
    check("500 → non-zero exit", r.code !== 0);
    check("500 → unavailable message", /company graph unavailable/.test(r.stdout + r.stderr));
  }

  // 7. Mode validation — zero or multiple modes is a usage error.
  console.log("mode validation:");
  {
    const none = await runCli(["--json"], "team-key");
    check("no mode → non-zero exit", none.code !== 0);
    const both = await runCli(["--owns", "x", "--who", "y"], "team-key");
    check("two modes → non-zero exit", both.code !== 0);
  }
} finally {
  server.close();
  rmSync(repoDir, { recursive: true, force: true });
}

if (failed) {
  console.log(`${RED}stakeholders CLI: ${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`${GREEN}stakeholders CLI: all checks passed${NC}`);
