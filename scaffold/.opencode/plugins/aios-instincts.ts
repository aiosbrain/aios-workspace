/**
 * AIOS instincts plugin — OpenCode port of Claude Code hook behaviors.
 *
 * Mapping (Claude → OpenCode):
 * | Instinct              | Hook                  | Status      |
 * |-----------------------|-----------------------|-------------|
 * | Session drift check   | session.created       | Full        |
 * | Access gate           | tool.execute.before   | Full        |
 * | Document tracker      | tool.execute.after    | Partial     |
 * | Decision capture      | session.status        | Partial     |
 * | Email safety          | tool.execute.before   | Deferred    |
 * | Inside-out workflow   | command.execute.before| Deferred    |
 * | Confluence sync       | tool.execute.after    | Partial     |
 * | Bookkeeping sync      | tool.execute.after    | Partial     |
 * | Weekly summary        | —                     | Deferred    |
 * | M365 email routing    | —                     | Claude-only |
 */
import type { Plugin } from "@opencode-ai/plugin";
import type { AssistantMessage } from "@opencode-ai/sdk";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const TEAM_DIRS = ["0-context/", "1-inbox/", "2-work/", "3-log/", "4-shared/"];
const ADMIN_MARKERS = [/access:\s*private/i, /access:\s*admin/i, /ADMIN ONLY/i];

function loadSecretPatterns(root: string): RegExp[] {
  const file = path.join(root, "validation", "secret-patterns.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => new RegExp(line));
}

function relPath(root: string, filePath: string): string {
  if (!filePath) return "";
  const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  return path.relative(root, abs).replace(/\\/g, "/");
}

function isTeamPath(rel: string): boolean {
  return TEAM_DIRS.some((d) => rel === d.slice(0, -1) || rel.startsWith(d));
}

function extractWritePayload(output: Record<string, unknown>): { filePath: string; content: string } {
  const args = (output.args ?? output) as Record<string, unknown>;
  const filePath = String(args.filePath ?? args.file_path ?? args.path ?? "");
  const content = String(args.content ?? args.new_string ?? args.newString ?? "");
  return { filePath, content };
}

function appendCostRecord(root: string, record: Record<string, unknown>) {
  const dir = path.join(root, ".aios", "loop", "maturity");
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "opencode-sessions.ndjson"), JSON.stringify(record) + "\n");
  } catch {
    /* skip — a missed capture is acceptable */
  }
}

export const AIOSInstincts: Plugin = async ({ directory, client }) => {
  const root = directory;
  const secretPatterns = loadSecretPatterns(root);

  return {
    "session.created": async () => {
      const indexPath = path.join(root, "0-context", "index.md");
      if (!existsSync(indexPath)) {
        console.warn("[aios-instincts] drift: missing 0-context/index.md — run workspace-setup");
      }
    },

    "session.status": async (input) => {
      const status = (input as { status?: string }).status;
      const sessionID = (input as { sessionID?: string }).sessionID;

      // Cost capture: when a session goes idle, fetch its messages for cost data.
      if (status === "idle" && sessionID) {
        try {
          const result = await client.session.messages({
            path: { id: sessionID },
            query: { limit: 200 },
          }) as { data?: Array<{ info: unknown }> } | Array<{ info: unknown }>;
          const messages = Array.isArray(result) ? result : (result as { data?: Array<{ info: unknown }> }).data;
          if (!messages || !messages.length) return;

          let totalCost = 0;
          let inputTokens = 0;
          let outputTokens = 0;
          let model = "";

          for (const { info } of messages) {
            const msg = info as { role?: string; cost?: number; tokens?: { input?: number; output?: number }; modelID?: string };
            if (msg.role === "assistant") {
              totalCost += msg.cost || 0;
              inputTokens += msg.tokens?.input || 0;
              outputTokens += msg.tokens?.output || 0;
              model = msg.modelID || model;
            }
          }

          if (totalCost > 0 || inputTokens > 0) {
            appendCostRecord(root, {
              tool: "opencode",
              session_id: sessionID,
              cost_usd: Math.round(totalCost * 100000) / 100000,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_read_tokens: 0,
              model,
              ts: new Date().toISOString(),
              project: root,
            });
          }
        } catch {
          /* session cost capture is best-effort */
        }
      }

      if (status === "idle") {
        const inbox = path.join(root, "1-inbox", "transcripts");
        if (existsSync(inbox)) {
          console.info("[aios-instincts] tip: new transcripts in 1-inbox/transcripts? run decision-extractor");
        }
      }
    },

    "tool.execute.before": async (input, output) => {
      const tool = input.tool;
      if (!["write", "edit", "apply_patch", "multiedit"].includes(tool)) return;

      const { filePath, content } = extractWritePayload(output as Record<string, unknown>);
      if (!content) return;

      for (const pattern of secretPatterns) {
        if (pattern.test(content)) {
          throw new Error(
            `[aios-instincts] BLOCKED: potential secret in ${filePath || "write"} (pattern: ${pattern.source})`,
          );
        }
      }

      const rel = relPath(root, filePath);
      if (rel && isTeamPath(rel)) {
        for (const marker of ADMIN_MARKERS) {
          if (marker.test(content)) {
            throw new Error(
              `[aios-instincts] BLOCKED: private/admin marker in team path ${rel}`,
            );
          }
        }
      }
    },

    "tool.execute.after": async (input) => {
      const tool = input.tool;
      if (!["write", "edit", "apply_patch"].includes(tool)) return;
      const rel = relPath(root, String((input as { args?: { filePath?: string } }).args?.filePath ?? ""));
      if (/^3-log\//.test(rel)) {
        console.info(`[aios-instincts] log write: ${rel} — confirm decision-log format if applicable`);
      }
    },
  };
};

export default AIOSInstincts;
