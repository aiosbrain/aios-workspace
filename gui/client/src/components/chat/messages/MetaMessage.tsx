import { cn } from "../../../lib/cn";
import type { MetaMessage as MetaMessageModel } from "../../../types/messages";

export function MetaMessage({ message }: { message: MetaMessageModel }) {
  const isError = /^error:/.test(message.text);
  return (
    <div
      className={cn(
        "self-center bg-transparent p-0.5 text-xs",
        isError ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {message.text}
    </div>
  );
}
