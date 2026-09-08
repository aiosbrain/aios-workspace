import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../scripts/brain-mcp.mjs";

test("aios_loop_collect (local tool) reads the workspace at ctx.cwd and matches the collector core", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aios-loop-mcp-"));
  try {
    // project.yaml is the workspace marker findWorkspaceRoot walks up to; 3-log is current spine.
    writeFileSync(path.join(dir, "project.yaml"), "slug: testproj\nmember: testuser\n");
    mkdirSync(path.join(dir, "3-log"), { recursive: true });
    const today = new Date().toISOString().slice(0, 10); // in-window date (collector window is [now-7d, now])
    writeFileSync(
      path.join(dir, "3-log", "decision-log.md"),
      "---\naccess: team\n---\n\n" +
        "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n" +
        "|---|------|----------|-----------|------------|--------|------|----------|\n" +
        `| 1 | ${today} | Test decision | because | alex | impact | 1 | team |\n` +
        Array.from(
          { length: 300 },
          (_, i) =>
            `| ${i + 2} | ${today} | Synthetic decision ${i}: ${"x".repeat(100)} | because | alex | impact | 1 | team |\n`
        ).join("")
    );
    // Local tool ignores the brain client; ctx.cwd points it at the workspace.
    const dispatch = createDispatcher({ ctx: { cwd: dir } });
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: { name: "aios_loop_collect", arguments: { cadence: "weekly" } },
    });
    assert.ok(!res.result.isError, res.result.content?.[0]?.text);
    assert.ok(
      res.result.content[0].text.length > 25_000,
      "large loop output remains complete JSON"
    );
    const manifest = JSON.parse(res.result.content[0].text);
    assert.equal(manifest.window.cadence, "weekly");
    assert.ok(
      manifest.signals.some((s) => s.kind === "decision" && s.summary === "Test decision"),
      "manifest includes the decision signal"
    );
    // Identical to the CLI path: same shared identity resolver + same collector core ⇒ same
    // member, project, and signal refs (IO3 — MCP manifest == CLI manifest).
    const { collect } = await import("../dist/operator-loop/index.js");
    const { resolveLoopIdentity } = await import("../scripts/loop-config.mjs");
    const { member, project } = resolveLoopIdentity(dir);
    const direct = collect({ root: dir, cadence: "weekly", member, project });
    assert.equal(manifest.member, member, "MCP member matches the shared resolver");
    assert.equal(manifest.project, project, "MCP project matches the shared resolver");
    assert.deepEqual(
      manifest.signals.map((s) => `${s.ref.path}#${s.ref.row ?? ""}`),
      direct.signals.map((s) => `${s.ref.path}#${s.ref.row ?? ""}`)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
