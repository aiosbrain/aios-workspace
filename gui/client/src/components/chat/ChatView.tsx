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
  const isEmpty = messages.length === 0;

  const placeholder = !connected && !isDraft
    ? "connecting…"
    : isEmpty
      ? "Describe a task — Enter to send, Shift+Enter for a newline"
      : "Message your workspace… (Enter to send, Shift+Enter for newline)";

  const banners = (
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
    </>
  );

  const composer = (
    <Composer
      ref={composerRef}
      value={input}
      onChange={setInput}
      onSend={() => sendMessage()}
      disabled={composerDisabled}
      busy={busy}
      placeholder={placeholder}
    />
  );

  // Codex-style centered empty state: heading + composer mid-canvas, chips beneath.
  if (isEmpty) {
    return (
      <div className="chat-hero">
        {banners}
        <div className="hero-inner">
          <h1 className="hero-title">What are you working on?</h1>
          {composer}
          <div className="hero-controls">
            <ModelPicker />
          </div>
          <EmptyState
            canStart={canStartMessage}
            onPick={(prompt) => sendMessage(prompt)}
            onDraftFromLink={() => {
              setInput("Draft my profile from this link: ");
              composerRef.current?.focus();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="chat-head">
        <ModelPicker />
      </div>
      <MessageList
        header={banners}
        messages={messages}
        permissions={permissions}
        onUndoMemory={undoMemory}
        onRespond={respondPermission}
        onRespondOption={respondPermissionOption}
      />
      <ContextMeter />
      {composer}
    </>
  );
}
