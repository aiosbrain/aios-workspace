#!/usr/bin/env node
// Claude Code statusLine command: reads the JSON payload Claude Code pipes on stdin
// and prints a one-line status (model, workspace, context %, 5h/7d rate-limit usage).
// Dependency-free by design — same convention as the other standalone hooks in this dir.
// Origin: adapted from https://github.com/alex-feldman/claude-statusline (reviewed 2026-07-30).

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    process.stdout.write("Claude");
    return;
  }
  const model = payload?.model?.display_name || "Unknown";
  const workspace = payload?.workspace?.project_dir || payload?.workspace?.current_dir || "";
  const workspaceRoot = workspace ? workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "";
  const ctxUsed = percent(payload?.context_window?.used_percentage);
  const fiveHour = percent(payload?.rate_limits?.five_hour?.used_percentage);
  const sevenDay = percent(payload?.rate_limits?.seven_day?.used_percentage);
  const parts = [model];
  if (workspaceRoot) parts.push(workspaceRoot);
  if (ctxUsed !== null) parts.push(`Context: ${ctxUsed}%`);
  if (fiveHour !== null) parts.push(`5h used: ${fiveHour}%`);
  if (sevenDay !== null) parts.push(`7d used: ${sevenDay}%`);
  process.stdout.write(parts.join(" | "));
});

function percent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.round(value);
}
