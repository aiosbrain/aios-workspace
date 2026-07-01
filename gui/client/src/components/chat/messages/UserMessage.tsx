import type { UserMessage as UserMessageModel } from "../../../types/messages";

export function UserMessage({ message }: { message: UserMessageModel }) {
  return (
    <div className="max-w-[80%] self-end whitespace-pre-wrap break-words rounded-xl border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3.5 py-2.5">
      {message.text}
    </div>
  );
}
