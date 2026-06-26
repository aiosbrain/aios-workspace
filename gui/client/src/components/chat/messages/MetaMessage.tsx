import type { MetaMessage as MetaMessageModel } from "../../../types/messages";

export function MetaMessage({ message }: { message: MetaMessageModel }) {
  const isError = /^error:/.test(message.text);
  return <div className={`msg meta${isError ? " error" : ""}`}>{message.text}</div>;
}
