import { presentSendState } from "./presenters";
import type { OutboxCommand } from "./types";

export function SentSection({ commands }: { commands: OutboxCommand[] }) {
  const sent = commands.filter(
    (command) => command.state === "sent" || command.state === "reconciled"
  );
  if (sent.length === 0) return null;
  return (
    <details className="max-w-3xl rounded-md border border-border-visible bg-card px-3 py-2">
      <summary className="cursor-pointer text-[12px] font-medium text-muted-foreground">
        Sent ({sent.length})
      </summary>
      <ul className="mt-2 space-y-1 border-t border-border-visible pt-2">
        {sent.map((command) => {
          const presentation = presentSendState(command.state);
          return (
            <li
              key={command.command_id}
              className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground"
              title={presentation.tooltip}
            >
              <span>{presentation.label}</span>
              <span>{presentation.tooltip}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
