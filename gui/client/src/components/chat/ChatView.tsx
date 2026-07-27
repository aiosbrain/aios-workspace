import { useRef } from "react";
import { useConnection, useRuntime, useSession } from "../../state/cockpit";
import { ModelPicker } from "./ModelPicker";
import { ApprovalModePicker } from "./ApprovalModePicker";
import { ContextMeter } from "./ContextMeter";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";

const SAFETY_BANNER =
  "self-stretch mb-1 rounded-md border px-[11px] py-[7px] text-[length:var(--aios-text-small)] text-amber border-[color-mix(in_srgb,var(--aios-amber)_30%,transparent)] bg-[color-mix(in_srgb,var(--aios-amber)_10%,transparent)]";

export function ChatView() {
  const { token } = useConnection();
  const { safetyNote, capabilities } = useRuntime();
  const {
    connected,
    connectionStatus,
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
  const showToolbar =
    (capabilities.modelSwitching && capabilities.models.length > 0) ||
    capabilities.approvalModes.length > 0;

  const placeholder =
    !connected && !isDraft
      ? connectionStatus === "offline"
        ? "offline — retrying… (Retry in the sidebar)"
        : connectionStatus === "reconnecting"
          ? "reconnecting…"
          : "connecting…"
      : isEmpty
        ? "Describe a task — Enter to send, Shift+Enter for a newline"
        : "Message your workspace… (Enter to send, Shift+Enter for newline)";

  const banners = (
    <>
      {!token && (
        <div className={SAFETY_BANNER}>
          Missing session token. Open the full link printed by <code>npm run gui</code> once — after
          that, refreshing this page will keep working in this tab.
        </div>
      )}
      {safetyNote && (
        <div
          className={SAFETY_BANNER}
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
      bare={isEmpty}
    />
  );

  // Codex-style centered empty state: heading + composer mid-canvas, chips beneath.
  if (isEmpty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        {banners}
        <div className="m-auto flex w-full max-w-[640px] flex-col items-stretch gap-4">
          <h1 className="mb-1 text-center font-sans text-[clamp(1.25rem,1.05rem+0.8vw,1.65rem)] font-semibold tracking-[var(--aios-tracking-tight)] text-foreground">
            What are you working on?
          </h1>
          {composer}
          {showToolbar ? (
            <div className="flex justify-center">
              <ModelPicker />
              <ApprovalModePicker />
            </div>
          ) : null}
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
      {showToolbar ? (
        <div className="flex items-center justify-end gap-2.5 border-b border-border-visible px-5 py-2.5">
          <ModelPicker />
          <ApprovalModePicker />
        </div>
      ) : null}
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
