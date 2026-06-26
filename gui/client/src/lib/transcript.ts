import type { TranscriptEvent, Usage } from "../types/protocol";
import type { UiMessage } from "../types/messages";
import { formatResultMeta } from "./format";

/**
 * Fold a stored transcript (array of WS events) into a messages[] for replay.
 * Differs from the live handler: `echo_user` BECOMES a user message here (the live
 * path ignores it because the UI already rendered it optimistically), and historical
 * `permission_request` events are dropped — never shown as live approval prompts.
 */
export function buildMessagesFromEvents(events: TranscriptEvent[]): UiMessage[] {
  const msgs: UiMessage[] = [];
  let lastUsage: Usage | null = null;
  let prevCost = 0;

  for (const ev of events) {
    switch (ev.type) {
      case "echo_user":
        msgs.push({ kind: "user", text: ev.text });
        break;
      case "delta": {
        const last = msgs[msgs.length - 1];
        if (last?.kind === "assistant" && last.streaming) last.text += ev.text;
        else msgs.push({ kind: "assistant", text: ev.text, streaming: true });
        break;
      }
      case "assistant_done": {
        const last = msgs[msgs.length - 1];
        if (last?.kind === "assistant") last.streaming = false;
        break;
      }
      case "tool_use":
        msgs.push({ kind: "tool", name: ev.name, input: ev.input, id: ev.id, result: null });
        break;
      case "tool_result": {
        const t = [...msgs].reverse().find((m) => m.kind === "tool" && m.id === ev.id);
        if (t && t.kind === "tool") {
          t.result = ev.text;
          t.isError = ev.is_error;
        }
        break;
      }
      case "usage":
        lastUsage = ev.usage;
        break;
      case "warning":
        msgs.push({ kind: "meta", text: `⚠ ${ev.message}` });
        break;
      case "result":
        msgs.push({ kind: "meta", text: formatResultMeta(lastUsage, ev.cost_usd, prevCost) });
        if (typeof ev.cost_usd === "number") prevCost = ev.cost_usd;
        lastUsage = null;
        break;
      default:
        // hello, model, session, permission_request, memory_* → not replayed
        break;
    }
  }

  const last = msgs[msgs.length - 1];
  if (last?.kind === "assistant") last.streaming = false; // never leave a stale cursor
  return msgs;
}
