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
import { existsSync, readFileSync } from "node:fs";
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

export const AIOSInstincts: Plugin = async ({ directory }) => {
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
      if (input.status !== "idle") return;
      const inbox = path.join(root, "1-inbox", "transcripts");
      if (existsSync(inbox)) {
        console.info("[aios-instincts] tip: new transcripts in 1-inbox/transcripts? run decision-extractor");
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
