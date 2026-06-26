/** One-line summary of a tool invocation's input, shown on the collapsed tool card. */
export function summarizeInput(_name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (typeof o.file_path === "string") return o.file_path;
  if (o.command != null) return String(o.command).slice(0, 80);
  if (typeof o.pattern === "string") return o.pattern;
  if (typeof o.skill === "string") return o.skill;
  const s = JSON.stringify(input);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}
