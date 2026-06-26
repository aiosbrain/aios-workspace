import { useRef } from "react";
import { useConnection, useRuntime, useSession } from "../../state/cockpit";
import { ModelPicker } from "./ModelPicker";
import { ContextMeter } from "./ContextMeter";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";

export function ChatView() {
  const { token } = useConnection();
  const { safetyNote } = useRuntime();
  const {
    connected,
    messages,
    input,
    setInput,
    busy,
    permissions,
    currentSession,
    sendMessage,
    respondPermission,
    respondPermissionOption,
    undoMemory,
  } = useSession();

  const composerRef = useRef<HTMLTextAreaElement>(null);

  const isDraft = currentSession === null;
  const draftConnecting = isDraft && busy && !connected;
  const composerDisabled = draftConnecting || (!connected && !isDraft);
  const canStartMessage = !composerDisabled;

  const placeholder = !connected && !isDraft
    ? "connecting…"
    : messages.length === 0
      ? "What are you working on?"
      : "Message your workspace… (Enter to send, Shift+Enter for newline)";

  const header = (
    <>
      {!token && (
        <div className="safety-banner">
          Missing session token. Open the full link printed by <code>npm run gui</code> once — after
          that, refreshing this page will keep working in this tab.
        </div>
      )}
      {safetyNote && (
        <div
          className="safety-banner"
          title="Writes the agent makes through its own shell run after the turn ends are scanned, not blocked beforehand."
        >
          ⚠ {safetyNote}
        </div>
      )}
      {messages.length === 0 && (
        <EmptyState
          canStart={canStartMessage}
          onPick={(prompt) => sendMessage(prompt)}
          onDraftFromLink={() => {
            setInput("Draft my profile from this link: ");
            composerRef.current?.focus();
          }}
        />
      )}
    </>
  );

  return (
    <>
      <div className="chat-head">
        <ModelPicker />
      </div>
      <MessageList
        header={header}
        messages={messages}
        permissions={permissions}
        onUndoMemory={undoMemory}
        onRespond={respondPermission}
        onRespondOption={respondPermissionOption}
      />
      <ContextMeter />
      <Composer
        ref={composerRef}
        value={input}
        onChange={setInput}
        onSend={() => sendMessage()}
        disabled={composerDisabled}
        busy={busy}
        placeholder={placeholder}
      />
    </>
  );
}
