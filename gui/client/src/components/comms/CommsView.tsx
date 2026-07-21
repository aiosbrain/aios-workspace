/**
 * CommsView (I-14 / AIO-395) — the quiet three-pane `comms` workspace inside the AIOS shell.
 *
 * Data comes from the coordinator's LOCAL read-model API (`/api/inbox`), which mirrors `aios inbox --json`
 * exactly. Mutations are limited to scoped decisions, resumable-agent replies, archive, and the gated
 * native Gmail reply flow. A new blocking ask fires a content-free desktop/Tauri notification (I-05
 * projection rule). Admin-tier local; nothing syncs to the Team Brain.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "../../state/cockpit";
import { CommsQueue } from "./CommsQueue";
import { CommsDetail } from "./CommsDetail";
import { ScopedConfirmDialog } from "./ScopedConfirmDialog";
import { ReplyConfirmDialog } from "./ReplyConfirmDialog";
import {
  fetchInbox,
  fetchInboxItem,
  fetchOutbox,
  postAskArchive,
  postAskReply,
  postDecision,
  postReplyCheck,
  postReplySend,
} from "./api";
import { notifyNewBlockingAsks, desktopNotify, isBlockingAsk } from "./notification";
import { LatestDetailRequest } from "./detail-request";
import { ApiError } from "../../lib/api";
import { canRetryConfirmed, deferredRetryAfter, retryDelayMs } from "./reply-retry";
import { gmailThreadRef, immutableReplySnapshot, retainLastGood } from "./view-state";
import type {
  DisplayProjection,
  InboxDetail,
  InboxView,
  OutboxCommand,
  OutboxView,
  ReplyConfirmationSnapshot,
} from "./types";

const POLL_MS = 15_000;

interface RetryPlan {
  snapshot: ReplyConfirmationSnapshot;
  threadRef: string;
  attempts: number;
  retryAt: string | null;
  exhausted: boolean;
}

interface RecoverableReply {
  snapshot: ReplyConfirmationSnapshot;
  threadRef: string;
}

export function CommsView() {
  const { api } = useConnection();
  const [view, setView] = useState<InboxView | null>(null);
  const [detail, setDetail] = useState<InboxDetail | null>(null);
  const [outbox, setOutbox] = useState<OutboxView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projection, setProjection] = useState<DisplayProjection | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [replySnapshot, setReplySnapshot] = useState<ReplyConfirmationSnapshot | null>(null);
  const [replyThreadRef, setReplyThreadRef] = useState<string | null>(null);
  const [replyDialogBusy, setReplyDialogBusy] = useState(false);
  const [replyDialogError, setReplyDialogError] = useState<string | null>(null);
  const [localCommand, setLocalCommand] = useState<OutboxCommand | null>(null);
  const [retryPlan, setRetryPlan] = useState<RetryPlan | null>(null);
  const [failedReply, setFailedReply] = useState<RecoverableReply | null>(null);
  const [replyRecoveryError, setReplyRecoveryError] = useState<string | null>(null);
  const [replyResetKey, setReplyResetKey] = useState(0);
  const [, setOutboxError] = useState<string | null>(null);

  const seenBlocking = useRef<Set<string> | null>(null);
  const selectedRef = useRef<string | null>(null);
  const detailRequests = useRef(new LatestDetailRequest());
  selectedRef.current = selectedId;

  const loadDetail = useCallback(
    async (id: string) => {
      await detailRequests.current.load(
        id,
        () => fetchInboxItem(api, id),
        setDetail,
        (e) => {
          // Keep the last-good detail on a failed refresh — blanking to the placeholder mid-read
          // would look like the item vanished. The error surfaces in the queue header instead.
          setError((e as Error).message);
        }
      );
    },
    [api]
  );

  const load = useCallback(async () => {
    try {
      const next = await fetchInbox(api);
      setError(null);
      setView((current) => retainLastGood(current, { ok: true, value: next }));

      // Content-free notifications: seed the seen-set silently on the first load, then only banner a
      // genuinely NEW blocking ask thereafter.
      if (seenBlocking.current === null) {
        seenBlocking.current = new Set(next.items.filter(isBlockingAsk).map((i) => i.id));
      } else {
        notifyNewBlockingAsks(seenBlocking.current, next, desktopNotify);
        for (const item of next.items) if (isBlockingAsk(item)) seenBlocking.current.add(item.id);
      }

      // Keep a selection: default to the first (highest-ranked) item.
      const stillThere = next.items.some((i) => i.id === selectedRef.current);
      const nextId = stillThere ? selectedRef.current : (next.items[0]?.id ?? null);
      if (nextId !== selectedRef.current) {
        selectedRef.current = nextId;
        detailRequests.current.select(nextId);
        setSelectedId(nextId);
        setDetail(null);
      }
      if (nextId) void loadDetail(nextId);
    } catch (e) {
      setView((current) => retainLastGood(current, { ok: false }));
      setError((e as Error).message);
    }
  }, [api, loadDetail]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const loadOutbox = useCallback(async () => {
    try {
      const next = await fetchOutbox(api);
      setOutbox((current) => retainLastGood(current, { ok: true, value: next }));
      setOutboxError(null);
    } catch (outboxFailure) {
      // Independent from inbox polling: keep the last-good outbox projection and leave the queue live.
      setOutbox((current) => retainLastGood(current, { ok: false }));
      setOutboxError((outboxFailure as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void loadOutbox();
    const timer = setInterval(() => void loadOutbox(), POLL_MS);
    return () => clearInterval(timer);
  }, [loadOutbox]);

  const onSelect = useCallback(
    (id: string) => {
      selectedRef.current = id;
      detailRequests.current.select(id);
      setSelectedId(id);
      setDetail(null);
      void loadDetail(id);
    },
    [loadDetail]
  );

  const onDecide = useCallback(
    async (decision: "approve" | "deny") => {
      if (!projection) return;
      setDialogBusy(true);
      setDialogError(null);
      try {
        // The decision resource IS the capability handle: the URL id must equal the handle so the server
        // can bind them (no cross-item / arbitrary-id substitution). The body still carries exactly three
        // fields.
        const res = await postDecision(api, projection.handle, {
          handle: projection.handle,
          digest: projection.digest,
          decision,
        });
        if (!res.ok && res.error) {
          setDialogError(res.error);
          setDialogBusy(false);
          return;
        }
        setProjection(null);
        setDialogBusy(false);
        await load();
      } catch (e) {
        setDialogError((e as Error).message);
        setDialogBusy(false);
      }
    },
    [api, projection, load]
  );

  const onReply = useCallback(
    async (id: string, message: string) => {
      const result = await postAskReply(api, id, message);
      if (!result.ok) throw new Error(result.error || "Claude did not accept the reply");
      await load();
    },
    [api, load]
  );

  const onArchive = useCallback(
    async (id: string) => {
      const result = await postAskArchive(api, id);
      if (!result.ok) throw new Error(result.error || "Could not archive the ask");
      await load();
    },
    [api, load]
  );

  const onReviewReply = useCallback(
    async (id: string, body: string) => {
      const threadRef = gmailThreadRef(detail);
      if (!threadRef || detail?.item?.id !== id) {
        throw new Error("Select the Gmail message again before reviewing this reply.");
      }
      const checked = await postReplyCheck(api, id, body);
      if (!checked.ok) throw new Error(checked.error);
      const snapshot = immutableReplySnapshot(id, body, checked);
      setReplySnapshot(snapshot);
      setReplyThreadRef(threadRef);
      setReplyDialogError(null);
      setFailedReply(null);
      setReplyRecoveryError(null);
    },
    [api, detail]
  );

  const sendConfirmed = useCallback(
    async (
      snapshot: ReplyConfirmationSnapshot,
      threadRef: string,
      attempts: number,
      fromDialog: boolean
    ) => {
      setReplyRecoveryError(null);
      if (fromDialog) {
        setReplyDialogBusy(true);
        setReplyDialogError(null);
      }
      setLocalCommand({
        command_id: snapshot.command_id,
        state: "attempting",
        thread_ref: threadRef,
        native_message_id: null,
        native_thread_id: null,
        last_attempt_at: new Date().toISOString(),
      });
      try {
        const result = await postReplySend(api, snapshot.itemId, {
          command_id: snapshot.command_id,
          digest: snapshot.digest,
          body: snapshot.body,
        });
        if (result.ok) {
          setLocalCommand({
            command_id: result.command_id,
            state: result.state,
            thread_ref: threadRef,
            native_message_id: result.native_message_id,
            native_thread_id: result.native_thread_id,
            last_attempt_at: new Date().toISOString(),
          });
          setReplySnapshot(null);
          setReplyThreadRef(null);
          setRetryPlan(null);
          setFailedReply(null);
          setReplyRecoveryError(null);
          setReplyResetKey((value) => value + 1);
          void load();
          void loadOutbox();
          return;
        }

        setReplySnapshot(null);
        setReplyThreadRef(null);
        setLocalCommand({
          command_id: result.command_id,
          state: result.state,
          thread_ref: threadRef,
          native_message_id: null,
          native_thread_id: null,
          last_attempt_at: new Date().toISOString(),
        });
        if (result.state === "outcome_unknown") {
          const exhausted = !canRetryConfirmed(attempts);
          setRetryPlan({
            snapshot,
            threadRef,
            attempts,
            retryAt: result.retry_after ?? null,
            exhausted,
          });
          setFailedReply(null);
        } else {
          setRetryPlan(null);
          setFailedReply({ snapshot, threadRef });
        }
        void loadOutbox();
      } catch (sendError) {
        const retryAt = deferredRetryAfter(sendError);
        if (sendError instanceof ApiError && sendError.status === 429) {
          const exhausted = !canRetryConfirmed(attempts);
          setReplySnapshot(null);
          setReplyThreadRef(null);
          setLocalCommand({
            command_id: snapshot.command_id,
            state: "outcome_unknown",
            thread_ref: threadRef,
            native_message_id: null,
            native_thread_id: null,
            last_attempt_at: new Date().toISOString(),
          });
          setRetryPlan({ snapshot, threadRef, attempts, retryAt, exhausted });
          return;
        }
        if (fromDialog) {
          setLocalCommand(null);
          setReplyDialogError((sendError as Error).message);
          return;
        }
        setLocalCommand({
          command_id: snapshot.command_id,
          state: "failed",
          thread_ref: threadRef,
          native_message_id: null,
          native_thread_id: null,
          last_attempt_at: new Date().toISOString(),
        });
        setRetryPlan(null);
        setFailedReply({ snapshot, threadRef });
      } finally {
        if (fromDialog) setReplyDialogBusy(false);
      }
    },
    [api, load, loadOutbox]
  );

  useEffect(() => {
    if (!retryPlan || retryPlan.exhausted) return;
    const timer = setTimeout(() => {
      setRetryPlan(null);
      void sendConfirmed(retryPlan.snapshot, retryPlan.threadRef, retryPlan.attempts + 1, false);
    }, retryDelayMs(retryPlan.retryAt));
    return () => clearTimeout(timer);
  }, [retryPlan, sendConfirmed]);

  useEffect(() => {
    if (!retryPlan) return;
    const terminal = outbox?.commands.find(
      (command) =>
        command.command_id === retryPlan.snapshot.command_id &&
        (command.state === "sent" || command.state === "reconciled")
    );
    if (!terminal) return;
    setRetryPlan(null);
    setLocalCommand(terminal);
    setFailedReply(null);
    setReplyRecoveryError(null);
    setReplyResetKey((value) => value + 1);
  }, [outbox, retryPlan]);

  const selectedThreadRef = gmailThreadRef(detail);
  const durableCommand =
    outbox?.commands.find((command) => command.thread_ref === selectedThreadRef) ?? null;
  const localForThread = localCommand?.thread_ref === selectedThreadRef ? localCommand : null;
  const durableCompletesLocal = Boolean(
    localForThread &&
    durableCommand?.command_id === localForThread.command_id &&
    (durableCommand.state === "sent" || durableCommand.state === "reconciled")
  );
  const selectedCommand = durableCompletesLocal
    ? durableCommand
    : (localForThread ?? durableCommand);
  const durableSentCommands =
    outbox?.commands.filter(
      (command) => command.state === "sent" || command.state === "reconciled"
    ) ?? [];
  const sentCommands =
    localCommand &&
    (localCommand.state === "sent" || localCommand.state === "reconciled") &&
    !durableSentCommands.some((command) => command.command_id === localCommand.command_id)
      ? [localCommand, ...durableSentCommands]
      : durableSentCommands;
  const canTryReplyAgain =
    selectedCommand?.state === "failed" &&
    failedReply?.threadRef === selectedThreadRef &&
    failedReply.snapshot.itemId === detail?.item?.id;
  const recoveryExhausted = Boolean(
    retryPlan?.exhausted && retryPlan.threadRef === selectedThreadRef
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1">
        {view ? (
          <CommsQueue view={view} selectedId={selectedId} onSelect={onSelect} error={error} />
        ) : (
          <div className="flex w-[348px] shrink-0 items-center justify-center border-r border-border-visible bg-card text-[13px] text-muted-foreground">
            {error ? "Failed to load the queue." : "Loading queue…"}
          </div>
        )}
        <CommsDetail
          detail={detail}
          onScopedConfirm={setProjection}
          onReply={onReply}
          onArchive={onArchive}
          outboxCommand={selectedCommand}
          sentCommands={sentCommands}
          replyResetKey={replyResetKey}
          recoveryExhausted={recoveryExhausted}
          replyRecoveryError={
            failedReply?.threadRef === selectedThreadRef ? replyRecoveryError : null
          }
          onReviewReply={onReviewReply}
          onTryReplyAgain={
            canTryReplyAgain && failedReply
              ? () => {
                  void onReviewReply(failedReply.snapshot.itemId, failedReply.snapshot.body).catch(
                    (reviewError) => {
                      setReplyRecoveryError((reviewError as Error).message);
                    }
                  );
                }
              : undefined
          }
        />
      </div>

      {projection && (
        <ScopedConfirmDialog
          projection={projection}
          busy={dialogBusy}
          error={dialogError}
          onDecide={onDecide}
          onClose={() => {
            setProjection(null);
            setDialogError(null);
          }}
        />
      )}

      {replySnapshot && replyThreadRef && (
        <ReplyConfirmDialog
          snapshot={replySnapshot}
          busy={replyDialogBusy}
          error={replyDialogError}
          onConfirm={() => {
            if (replyDialogBusy) return;
            void sendConfirmed(replySnapshot, replyThreadRef, 1, true);
          }}
          onClose={() => {
            if (replyDialogBusy) return;
            setReplySnapshot(null);
            setReplyThreadRef(null);
            setReplyDialogError(null);
          }}
        />
      )}
    </div>
  );
}
