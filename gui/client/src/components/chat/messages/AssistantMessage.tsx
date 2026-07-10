import { cn } from "../../../lib/cn";
import { MarkdownBlock } from "../../ui/MarkdownBlock";
import type { AssistantMessage as AssistantMessageModel } from "../../../types/messages";

export function AssistantMessage({ message }: { message: AssistantMessageModel }) {
  return (
    <div
      className={cn(
        "assistant-prose max-w-[92%] self-start break-words rounded-xl border border-border-visible bg-card px-3.5 py-2.5 shadow-card",
        message.streaming && "streaming-cursor"
      )}
    >
      <MarkdownBlock>{message.text}</MarkdownBlock>
    </div>
  );
}
