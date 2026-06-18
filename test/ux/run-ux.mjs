#!/usr/bin/env node
// test/ux/run-ux.mjs — orchestrator for the agentic e2e UX-testing harness (cockpit pilot).
//
// Responsibilities (per the approved plan):
//   1. Scaffold a throwaway employee fixture workspace, install the Firecrawl skill via the
//      REAL connector path (storeConnector with a dummy key), then validate the fixture.
//   2. Start the Firecrawl stub (offline, deterministic) — unless --real-firecrawl.
//   3. Reserve a free port, launch the cockpit via scripts/run-gui.mjs with a KNOWN token +
//      FIRECRAWL_API_URL pointed at the stub; poll /api/info; retry on a fresh port on bind
//      failure / timeout.
//   4. Per flow: run the agentic driver → the rubric judge (with the REAL injected callModel)
//      → judge-independent post-asserts → write evidence/<flow>/report.json.
//   5. finally{} teardown: kill cockpit + stub PIDs, agent-browser close --session.
//
// Statuses / exit codes:
//   pass            → 0
//   skipped_no_key  → 0   (ANTHROPIC_API_KEY unset → we skip BEFORE scaffold/launch and write a
//                          skipped summary; this proves the harness is wired + exits cleanly, but
//                          does NOT exercise cockpit startup/teardown, which need a key to drive)
//   ux_fail         → 1   (a flow's gate is below threshold / a post-assert failed)
//   harness_error   → 2   (infra broke)
//   review_needed   → 0   + WARNING + artifacts (judge non-agreement; not a UX regression)
//
// CLI: --flow <id|all> · --keep-evidence · --real-firecrawl · --setup-only
//
// NOTE: the REAL callModel (a thin @anthropic-ai/sdk adapter, temp 0, image blocks) lives in
// THIS file and is injected into the PURE judge (judge.mjs). The judge never imports an SDK.

import net from "node:net";
import http from "node:http";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { getDescriptor, storeConnector } from "../../scripts/connector.mjs";
import { judgeFlow } from "./judge.mjs";
// NOTE: driver.mjs is imported LAZILY inside the live-flow path (it pulls in the Agent SDK),
// so `node run-ux.mjs` is startable with no node_modules and reaches the no-key skip cleanly.
import * as flowA from "./flows/onboarding-draft-from-link.mjs";
import * as flowB from "./flows/skills-install-consent.mjs";
import { killGroup } from "./proc.mjs";
import { extractJsonObject } from "./json-extract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const EVIDENCE_ROOT = path.join(HERE, "evidence");
// Obviously-non-secret dummy used only to gate the throwaway local cockpit
// fixture during UX testing — never a real credential.
const KNOWN_TOKEN = "dummy-token";
const DRIVER_MODEL = process.env.AIOS_UX_DRIVER_MODEL || "claude-sonnet-4-5";
const JUDGE_MODEL = process.env.AIOS_UX_JUDGE_MODEL || "claude-sonnet-4-5";

const FLOWS = { [flowA.id]: flowA, [flowB.id]: flowB };

// ── tiny arg parser ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes(n);
const getArg = (n, d) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; };
const KEEP_EVIDENCE = hasFlag("--keep-evidence");
const REAL_FIRECRAWL = hasFlag("--real-firecrawl");
const SETUP_ONLY = hasFlag("--setup-only");
// Opt-in: make a judge review_needed a HARD failure (exit 1). Default off — review_needed → 0.
const FAIL_ON_REVIEW = hasFlag("--fail-on-review");
const FLOW_SEL = getArg("--flow", "all");

const log = (...a) => console.log("[run-ux]", ...a);
const warn = (...a) => console.warn("[run-ux] WARNING:", ...a);

// ── port reservation: bind :0, read the assigned port, release it ──────────────
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function pollInfo(port, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/info", timeout: 2000 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 200) { try { resolve(JSON.parse(body)); return; } catch { /* retry */ } }
          retry();
        });
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => { if (Date.now() > deadline) reject(new Error("/api/info readiness timed out")); else setTimeout(attempt, intervalMs); };
    attempt();
  });
}

// ── fixture: scaffold employee workspace + install firecrawl via storeConnector ─
function scaffoldFixture(parentTmp) {
  const out = path.join(parentTmp, "ux-fixture");
  log("scaffolding fixture workspace at", out);
  execFileSync("bash", [
    path.join(ROOT, "scripts", "scaffold-project.sh"),
    "--context", "employee",
    "--slug", "ux-fixture",
    "--owner", "tester",
    "--output", out,
  ], { stdio: "inherit" });

  // Install the Firecrawl skill the SAME way the product does (copies the skill +
  // vaults the key + flips status), so the fixture matches the real install contract.
  log("installing firecrawl connector (storeConnector) with a dummy key");
  storeConnector(out, getDescriptor(out, "firecrawl"), { FIRECRAWL_API_KEY: "dummy-ux-key" });

  const skillFile = path.join(out, ".claude", "skills", "firecrawl-direct", "firecrawl-extract.mjs");
  if (!existsSync(skillFile)) throw new Error(`firecrawl skill not installed at ${skillFile}`);

  validateFixture(out);
  return out;
}

// Run validate-all.sh as a regression catch. The fixture is a CONNECTED workspace, so it
// legitimately has a dotenvx vault `.env` (ciphertext + public key only, and gitignored).
// OGR03's "`.env` file committed" check scans the raw working tree and does not honour
// gitignore, so on a connected fixture that single check is EXPECTED to trip. We tolerate
// ONLY that one expected finding (and re-assert the vault is ciphertext, never plaintext);
// ANY other validator failure is a real regression and aborts the harness.
function validateFixture(repo) {
  log("validating fixture (validate-all.sh)");
  let out = "", code = 0;
  try { out = execFileSync("bash", [path.join(ROOT, "validation", "validate-all.sh"), repo], { encoding: "utf8" }); }
  catch (e) { out = `${e.stdout || ""}${e.stderr || ""}`; code = e.status || 1; }
  process.stdout.write(out);
  if (code === 0) return;

  // Which OGRs failed?
  const failedOgrs = [...out.matchAll(/OGR(\d+) FAILED/g)].map((m) => m[1]);
  const onlyOgr03 = failedOgrs.length > 0 && failedOgrs.every((n) => n === "03");
  const onlyEnvFinding = /✗ \.env file committed/.test(out) && !/✗ (?!\.env file committed)/.test(out);
  if (onlyOgr03 && onlyEnvFinding) {
    // Re-assert the only `.env` is the encrypted dotenvx vault (ciphertext, not plaintext).
    const envPath = path.join(repo, ".env");
    const txt = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const isVault = /DOTENV_PUBLIC_KEY/.test(txt) && /encrypted:/.test(txt);
    if (!isVault) throw new Error("validate-all OGR03 failed and .env is NOT an encrypted dotenvx vault — aborting");
    warn("validate-all: OGR03 flagged the dotenvx vault .env (expected for a connected fixture; it is ciphertext + gitignored). All other validators green.");
    return;
  }
  throw new Error(`validate-all.sh failed on the fixture (OGR ${failedOgrs.join(", ") || "?"}) — a real regression, aborting`);
}

// ── launch cockpit with retry-on-bind-failure ──────────────────────────────────
async function launchCockpit(fixture, stubUrl) {
  for (let tries = 0; tries < 3; tries++) {
    const port = await reserveFreePort();
    log(`launching cockpit on port ${port} (attempt ${tries + 1})`);
    const env = {
      ...process.env,
      AIOS_GUI_TOKEN: KNOWN_TOKEN,
      // Deterministic, deny-by-default server-side Bash policy for Flow A: the cockpit runs under
      // the NAMED built-in policy `ux-onboarding` (exact-argv shapes live in gui/server/tool-policy.mjs),
      // which allows only the firecrawl-extract / suggest-connectors commands and denies everything
      // else, recording a tool_policy event per decision. (Flow B triggers no Bash → unaffected.)
      AIOS_GUI_TEST_POLICY: flowA.POLICY_NAME,
      ...(stubUrl ? { FIRECRAWL_API_URL: stubUrl } : {}),
    };
    // detached → run-gui becomes its own process-group leader, so teardown can group-kill it
    // AND the gui/server/index.mjs grandchild it forks (which a plain child.kill would orphan).
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "run-gui.mjs"), "--repo", fixture, "--port", String(port)], {
      env, stdio: ["ignore", "inherit", "inherit"], detached: true,
    });
    let exited = false; child.on("exit", () => { exited = true; });
    try {
      const info = await pollInfo(port, { timeoutMs: 90000 });
      if (exited) throw new Error("cockpit process exited during startup");
      const tokenUrl = `http://127.0.0.1:${port}/?token=${KNOWN_TOKEN}`;
      log("cockpit ready:", info.repo);
      return { child, port, tokenUrl };
    } catch (e) {
      warn(`cockpit launch attempt ${tries + 1} failed: ${e.message}`);
      killGroup(child.pid); // group-kill the partially-started cockpit (run-gui + any grandchild)
      if (tries === 2) throw e;
    }
  }
}

// ── the REAL judge model adapter (lives HERE, injected into the pure judge) ─────
// Thin @anthropic-ai/sdk wrapper: temp 0; attaches the flow's screenshots as base64 image
// blocks alongside the criterion text. Imported dynamically so the harness only needs the
// SDK present when actually judging (and the pure judge never imports it).
async function makeRealCallModel(evidenceDir) {
  const { Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { readFileSync: rf, existsSync: ex } = await import("node:fs");

  return async function callModel(req) {
    // Build the image blocks from the screenshots captured for THIS flow.
    const imageBlocks = [];
    for (const shot of (req.evidence?.screenshots || [])) {
      const abs = path.isAbsolute(shot) ? shot : path.join(evidenceDir, shot);
      if (!ex(abs)) continue;
      try {
        const data = rf(abs).toString("base64");
        imageBlocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data } });
      } catch { /* skip unreadable shot */ }
    }
    const userText = req.messages.map((m) => m.content).join("\n");
    const content = [...imageBlocks, { type: "text", text: userText }];

    const resp = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 512,
      temperature: 0,
      system: req.system,
      messages: [{ role: "user", content }],
    });
    const raw = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    // Models wrap their JSON in a ```json fence despite the "no fences" instruction; the judge
    // gate is strict by contract, so normalize to a bare JSON object string here in the adapter.
    return extractJsonObject(raw);
  };
}

// ── per-flow run ───────────────────────────────────────────────────────────────
async function runFlow(flow, fixture, tokenUrl) {
  const evidenceDir = path.join(EVIDENCE_ROOT, flow.id);
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });

  // Pre-run baseline for the no-silent-write post-assert (Flow A).
  const baseline = typeof flow.captureBaseline === "function" ? flow.captureBaseline(fixture) : undefined;

  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { runDriver } = await import("./driver.mjs"); // lazy: only the live path needs the driver
  log(`[${flow.id}] driving…`);
  const driven = await runDriver({ flow, tokenUrl, evidenceDir, model: DRIVER_MODEL, sdk });

  // Judge-INDEPENDENT enforcement audit (Flow A): the cockpit ran under the deny-by-default
  // server-side Bash policy and recorded a `tool_policy` event per decision into its session
  // transcript (.aios/sessions/<id>.jsonl). Read those events and assert that ONLY the allowed
  // commands were approved (and that firecrawl-extract was actually requested). A failure here
  // is a real enforcement regression → ux_fail.
  let toolPolicyAudit = { ok: true, checks: [], note: "no tool_policy audit for this flow" };
  if (typeof flow.auditToolPolicy === "function") {
    const events = readToolPolicyEvents(fixture);
    toolPolicyAudit = flow.auditToolPolicy(events);
  }

  const evidence = { screenshots: driven.screenshots, errors: driven.errors, transcript: driven.transcript };
  const callModel = await makeRealCallModel(evidenceDir);
  log(`[${flow.id}] judging…`);
  const judgeResult = await judgeFlow(flow.rubric, evidence, callModel);

  const post = typeof flow.postAssert === "function" ? flow.postAssert({ repo: fixture, baseline }) : { ok: true, checks: [] };

  // Resolve flow status: a failed post-assert OR a failed tool-policy audit OR a judge fail →
  // ux_fail. A judge review_needed (with post-asserts green) → review_needed. Otherwise pass.
  let status;
  if (!post.ok || judgeResult.status === "fail" || !toolPolicyAudit.ok) status = "ux_fail";
  else if (judgeResult.status === "review_needed") status = "review_needed";
  else status = "pass";

  const report = {
    flow: flow.id, status,
    judge: judgeResult,
    postAssert: post,
    toolPolicyAudit,
    evidenceDir,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  log(`[${flow.id}] status=${status} (judge=${judgeResult.status}, postAssert=${post.ok}, toolPolicy=${toolPolicyAudit.ok})`);
  return report;
}

// Read every `tool_policy` event the cockpit recorded across its session transcripts
// (.aios/sessions/*.jsonl) for the fixture. These are written server-side by confirmClaudeTool
// under the env-gated deny-by-default policy. Returns a flat array of parsed events.
function readToolPolicyEvents(fixture) {
  const sessionsDir = path.join(fixture, ".aios", "sessions");
  if (!existsSync(sessionsDir)) return [];
  const events = [];
  let files = [];
  try { files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  for (const f of files) {
    let text = "";
    try { text = readFileSync(path.join(sessionsDir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { const obj = JSON.parse(t); if (obj && obj.type === "tool_policy") events.push(obj); } catch { /* skip */ }
    }
  }
  return events;
}

// ── teardown ────────────────────────────────────────────────────────────────────
function killProc(child, label) {
  if (!child || child.pid == null) return;
  // Cockpit + stub are spawned `detached` (own process group); signal the WHOLE group so the
  // grandchild server (run-gui.mjs → gui/server/index.mjs) is reaped, not orphaned. A plain
  // child.kill() would leave it holding the port + the inherited stdout pipe (a hang).
  const signaled = killGroup(child.pid);
  if (!signaled) { try { child.kill("SIGKILL"); } catch { /* */ } } // fallback: not a group leader
  log(`killed ${label}`);
}
function closeBrowserSessions() {
  for (const flow of Object.values(FLOWS)) {
    try { execFileSync("agent-browser", ["--session", flow.id, "close"], { stdio: "ignore", timeout: 10000 }); }
    catch { /* session may not exist / agent-browser absent — fine */ }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1) Parse selection first.
  const selected = FLOW_SEL === "all" ? Object.values(FLOWS) : (FLOWS[FLOW_SEL] ? [FLOWS[FLOW_SEL]] : null);
  if (!selected) { warn(`unknown --flow '${FLOW_SEL}'. Known: ${Object.keys(FLOWS).join(", ")}, or 'all'`); return 2; }

  // 2) Ensure the evidence root exists BEFORE writing any summary into it.
  mkdirSync(EVIDENCE_ROOT, { recursive: true });

  const haveKey = !!process.env.ANTHROPIC_API_KEY;

  // 3) No-key skip happens BEFORE any fixture scaffold or cockpit launch — so the skip path
  //    needs no node_modules and no cockpit. (Without a key there is nothing to drive/judge.)
  if (!haveKey && !SETUP_ONLY) {
    writeFileSync(path.join(EVIDENCE_ROOT, "summary.json"), JSON.stringify({ status: "skipped_no_key", flows: [] }, null, 2) + "\n");
    log("ANTHROPIC_API_KEY unset → skipped_no_key (nothing to drive/judge without a key).");
    return 0;
  }

  // 4) From here on we genuinely need to scaffold + launch (for --setup-only or a live run).
  const parentTmp = mkdtempSync(path.join(tmpdir(), "aios-ux-"));
  let cockpit = null, stub = null, fixture = null;
  let exitCode = 0;

  try {
    // ── setup (also proven on --setup-only, even with no API key) ──
    fixture = scaffoldFixture(parentTmp);

    if (!REAL_FIRECRAWL) {
      const stubPort = await reserveFreePort();
      log("starting firecrawl stub on", stubPort);
      stub = spawn(process.execPath, [path.join(HERE, "firecrawl-stub.mjs"), "--port", String(stubPort)], { stdio: ["ignore", "inherit", "inherit"], detached: true });
      var stubUrl = `http://127.0.0.1:${stubPort}`;
    }

    const launched = await launchCockpit(fixture, REAL_FIRECRAWL ? null : stubUrl);
    cockpit = launched.child;
    const tokenUrl = launched.tokenUrl;

    if (SETUP_ONLY) {
      log("--setup-only: setup + launch + readiness proven; tearing down.");
      return 0;
    }

    // ── run flows ──
    const reports = [];
    for (const flow of selected) {
      try { reports.push(await runFlow(flow, fixture, tokenUrl)); }
      catch (e) {
        warn(`[${flow.id}] harness error: ${e.message}`);
        reports.push({ flow: flow.id, status: "harness_error", error: e.message });
      }
    }

    // ── overall exit code ──
    const anyHarnessError = reports.some((r) => r.status === "harness_error");
    const anyFail = reports.some((r) => r.status === "ux_fail");
    const anyReview = reports.some((r) => r.status === "review_needed");
    let overall;
    if (anyHarnessError) { overall = "harness_error"; exitCode = 2; }
    else if (anyFail) { overall = "ux_fail"; exitCode = 1; }
    else if (anyReview) {
      overall = "review_needed";
      // Default: a review_needed is NOT a regression → exit 0 + warning. Opt-in
      // --fail-on-review (e.g. a gating nightly) turns it into a hard failure.
      exitCode = FAIL_ON_REVIEW ? 1 : 0;
      warn(`review_needed — judge did not reach agreement on at least one criterion; see artifacts.${FAIL_ON_REVIEW ? " (--fail-on-review → exit 1)" : ""}`);
    }
    else { overall = "pass"; exitCode = 0; }

    writeFileSync(path.join(EVIDENCE_ROOT, "summary.json"), JSON.stringify({ status: overall, flows: reports.map((r) => ({ flow: r.flow, status: r.status })) }, null, 2) + "\n");
    log("OVERALL:", overall);
  } catch (e) {
    warn("harness error:", e.message);
    exitCode = 2;
  } finally {
    // Teardown ALWAYS: cockpit + stub PIDs, agent-browser sessions.
    killProc(cockpit, "cockpit");
    killProc(stub, "firecrawl-stub");
    closeBrowserSessions();
    if (!KEEP_EVIDENCE) {
      try { rmSync(parentTmp, { recursive: true, force: true }); } catch { /* */ }
    } else {
      log("kept fixture at", parentTmp);
    }
  }
  return exitCode;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2); });
