// Copied into the disposable pinned Brain after its production build, never shipped.
import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";
import { db, seedTeam, ingest } from "../datamechanics/helpers";
import { BASE_URL, convergeTeam } from "./http-helpers";
import { issueApiKey } from "@/lib/admin/keys";

it("invokes all eight installed standalone tools against the real Brain", async () => {
  const workspace = process.env.MCP_WORKSPACE_DIR!;
  const artifact = process.env.MCP_PACKAGE_ARTIFACT!;
  const container = process.env.MCP_ACCEPTANCE_CONTAINER_NAME!;
  expect(workspace && artifact && container).toBeTruthy();
  try {
    const seed = await seedTeam();
    const item = await ingest(seed, {
      path: "2-work/mcp-package.md",
      body: "The synthetic lighthouse launch is violet.",
      access: "team",
    });
    await ingest(seed, {
      kind: "task",
      body: "| ID | Task | Status |\n| --- | --- | --- |\n| MCP-1 | MCP lighthouse checklist | in_progress |",
      access: "team",
      path: "3-log/tasks.md",
      rows: [{ row_key: "MCP-1", title: "MCP lighthouse checklist", status: "in_progress" }],
    });
    const decision = await ingest(seed, {
      kind: "decision",
      body: "| ID | Decision | Audience |\n| --- | --- | --- |\n| MCP-D1 | Lighthouse launch is violet | team |",
      access: "team",
      path: "3-log/decision-log.md",
      rows: [{ row_key: "MCP-D1", title: "Lighthouse launch is violet", audience: "team" }],
    });
    await ingest(seed, {
      kind: "artifact",
      access: "team",
      path: "2-work/mcp-meeting.md",
      body: "Synthetic lighthouse meeting with Alex and Blair.",
      frontmatter: {
        meeting: true,
        title: "MCP lighthouse meeting",
        participants: "Synthetic Alex, Synthetic Blair",
      },
    });
    await convergeTeam(seed);
    // Same fixture operation as the Brain decision-writeback suite: mark the
    // ingested decision as edited after sync, which is what this legacy feed serves.
    const { data: decisionSource, error: sourceError } = await db()
      .from("items")
      .select("synced_at")
      .eq("id", decision.id)
      .single();
    expect(sourceError).toBeNull();
    const editedAt = new Date(new Date(decisionSource!.synced_at).getTime() + 1000).toISOString();
    expect(
      (
        await db()
          .from("decisions")
          .update({ updated_at: editedAt })
          .eq("team_id", seed.teamId)
          .eq("source_item_id", decision.id)
      ).error
    ).toBeNull();
    const { key } = await issueApiKey(
      db(),
      seed.teamId,
      seed.memberId,
      "Disposable standalone package acceptance"
    );
    // The existing MCP task tool reads the writeback feed. Canonically apply a
    // Brain-side work event so the ingested task is newer than its workspace push.
    const event = await fetch(`${BASE_URL}/api/v1/work-events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "x-aios-team": seed.teamSlug,
      },
      body: JSON.stringify({
        project: "acme",
        event_kind: "merged",
        repo: "synthetic/package-fixture",
        merged_sha: "a".repeat(40),
        pr_url: "https://example.invalid/synthetic/1",
        pr_title: "MCP-1 lighthouse checklist",
        work_keys: ["MCP-1"],
        actor: "tester",
      }),
    });
    expect(event.status, await event.text()).toBe(201);
    const fixture = JSON.stringify({ url: BASE_URL, key, team: seed.teamSlug, itemId: item.id });
    const local = process.env.MCP_PACKAGE_LOCAL === "1";
    const args = local
      ? [resolve(workspace, "test/mcp-package/accept.mjs"), artifact]
      : [
          "run",
          "--rm",
          "--name",
          container,
          "--network",
          "host",
          "--env",
          "MCP_PACKAGE_FIXTURE",
          "--env",
          "MCP_REGISTRY_ACCEPTANCE",
          "--mount",
          `type=bind,source=${artifact},target=/artifact,readonly`,
          "--mount",
          `type=bind,source=${resolve(workspace, "test/mcp-package")},target=/acceptance,readonly`,
          process.env.MCP_ACCEPTANCE_IMAGE || "node:22-bookworm-slim",
          "node",
          "/acceptance/accept.mjs",
          "/artifact",
        ];
    const child = spawn(local ? process.execPath : "docker", args, {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MCP_PACKAGE_FIXTURE: fixture,
        MCP_REGISTRY_ACCEPTANCE: process.env.MCP_REGISTRY_ACCEPTANCE || "0",
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code, "Installed package outcome assertions failed").toBe(0);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    const client = new Client({ connectionString: process.env.DATABASE_TEST_URL });
    await client.connect();
    try {
      await client.query("TRUNCATE teams RESTART IDENTITY CASCADE");
      for (const table of ["teams", "members", "api_keys", "items", "projects"]) {
        const result = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(result.rows[0].n, `cleanup ${table}`).toBe(0);
      }
      console.log("MCP_FIXTURE_CLEANUP_OK");
    } finally {
      await client.end();
    }
  }
}, 210000);
