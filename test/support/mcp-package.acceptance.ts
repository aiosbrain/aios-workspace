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
      body: "Synthetic MCP task rows",
      access: "team",
      path: "3-log/tasks.md",
      rows: [{ row_key: "MCP-1", title: "MCP lighthouse checklist", status: "in_progress" }],
    });
    await ingest(seed, {
      kind: "decision",
      body: "Synthetic MCP decision rows",
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
    const { key } = await issueApiKey(
      db(),
      seed.teamId,
      seed.memberId,
      "Disposable standalone package acceptance"
    );
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
