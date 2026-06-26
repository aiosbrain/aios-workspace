import type { UserMessage as UserMessageModel } from "../../../types/messages";

export function UserMessage({ message }: { message: UserMessageModel }) {
  return <div className="msg user">{message.text}</div>;
}
