/**
 * CommsView (I-14 / AIO-395) — the quiet three-pane `comms` workspace inside the AIOS shell.
 *
 * Data comes from the coordinator's LOCAL read-model API (`/api/inbox`), which mirrors `aios inbox --json`
 * exactly. Read-only except the single scoped-confirm POST. A new blocking ask fires a content-free
 * desktop/Tauri notification (I-05 projection rule). Admin-tier local; nothing syncs to the Team Brain.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "../../state/cockpit";
import { CommsQueue } from "./CommsQueue";
import { CommsDetail } from "./CommsDetail";
import { ScopedConfirmDialog } from "./ScopedConfirmDialog";
import {
  fetchInbox,
  fetchInboxItem,
  postAskAck,
  postAskArchive,
  postAskReply,
  postDecision,
} from "./api";
import { notifyNewBlockingAsks, desktopNotify, isBlockingAsk } from "./notification";
import { LatestDetailRequest, reconcileDetailNotify } from "./detail-request";
import { shouldAcknowledgeDeliveredAsk } from "./ack-evidence";
import type { DisplayProjection, InboxDetail, InboxView } from "./types";

const POLL_MS = 15_000;

export function CommsView() {
  const { api } = useConnection();
  const [view, setView] = useState<InboxView | null>(null);
  const [detail, setDetail] = useState<InboxDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projection, setProjection] = useState<DisplayProjection | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const seenBlocking = useRef<Set<string> | null>(null);
  const selectedRef = useRef<string | null>(null);
  const detailRef = useRef<InboxDetail | null>(null);
  const ackInFlight = useRef(new Set<string>());
  const ackSettled = useRef(new Set<string>());
  const detailRequests = useRef(new LatestDetailRequest());
  selectedRef.current = selectedId;

  const loadDetail = useCallback(
    async (id: string) => {
      return detailRequests.current.load(
        id,
        () => fetchInboxItem(api, id),
        (next) => {
          detailRef.current = next;
          setDetail(next);
        },
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
        detailRef.current = null;
        setDetail(null);
      }
      // Detail is fetched after the queue, so reconcile its newer selected-row and lane projection
      // into the queue before committing either surface.
      const refreshedDetail = nextId ? await loadDetail(nextId) : undefined;
      setView(reconcileDetailNotify(next, nextId, refreshedDetail));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, loadDetail]);

  const ackIfHuman = useCallback(
    async (id: string, candidate: InboxDetail | null = detailRef.current) => {
      if (typeof document === "undefined") return;
      if (
        !shouldAcknowledgeDeliveredAsk({
          id,
          selectedId: selectedRef.current,
          detail: candidate,
          visibilityState: document.visibilityState,
          hasFocus: document.hasFocus(),
        })
      ) {
        return;
      }
      if (ackInFlight.current.has(id) || ackSettled.current.has(id)) return;

      ackInFlight.current.add(id);
      try {
        const result = await postAskAck(api, id);
        if (result.recorded || result.reason === "already-acked") {
          ackSettled.current.add(id);
          await load();
        }
      } catch {
        // A later focus/detail refresh may retry. The queue remains the durable source of truth.
      } finally {
        ackInFlight.current.delete(id);
      }
    },
    [api, load]
  );

  // Effects run after React commits the detail panel. That render—not the GET or poll that supplied
  // it—is the human evidence required before the local acknowledgment POST is allowed.
  useEffect(() => {
    const id = detail?.item?.id;
    if (id) void ackIfHuman(id, detail);
  }, [detail, ackIfHuman]);

  useEffect(() => {
    const retrySelected = () => {
      const id = selectedRef.current;
      if (id) void ackIfHuman(id);
    };
    window.addEventListener("focus", retrySelected);
    document.addEventListener("visibilitychange", retrySelected);
    return () => {
      window.removeEventListener("focus", retrySelected);
      document.removeEventListener("visibilitychange", retrySelected);
    };
  }, [ackIfHuman]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const onSelect = useCallback(
    (id: string) => {
      selectedRef.current = id;
      detailRequests.current.select(id);
      setSelectedId(id);
      detailRef.current = null;
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
    </div>
  );
}
