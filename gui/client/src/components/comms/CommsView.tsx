/**
 * CommsView (I-14 / AIO-395) — the `comms` view: the Command Deck split-screen living inside the AIOS
 * shell. A health strip across the top, the ranked queue (protected partition + why strings) on the left,
 * the thread/ask detail on the right, and the scoped-confirmation dialog for authority-requiring approvals.
 *
 * Data comes from the coordinator's LOCAL read-model API (`/api/inbox`), which mirrors `aios inbox --json`
 * exactly. Read-only except the single scoped-confirm POST. A new blocking ask fires a content-free
 * desktop/Tauri notification (I-05 projection rule). Admin-tier local; nothing syncs to the Team Brain.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, RadioTower } from "lucide-react";
import { useConnection } from "../../state/cockpit";
import { cn } from "../../lib/cn";
import { CommsQueue } from "./CommsQueue";
import { CommsDetail } from "./CommsDetail";
import { ScopedConfirmDialog } from "./ScopedConfirmDialog";
import { fetchInbox, fetchInboxItem, postAskArchive, postAskReply, postDecision } from "./api";
import { notifyNewBlockingAsks, desktopNotify, isBlockingAsk } from "./notification";
import { LatestDetailRequest } from "./detail-request";
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
  const detailRequests = useRef(new LatestDetailRequest());
  selectedRef.current = selectedId;

  const loadDetail = useCallback(
    async (id: string) => {
      await detailRequests.current.load(
        id,
        () => fetchInboxItem(api, id),
        setDetail,
        (e) => {
          setDetail(null);
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
      setView(next);

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
      setError((e as Error).message);
    }
  }, [api, loadDetail]);

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

  const health = deriveHealth(view);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* health strip — derived honestly from the read model (counts + staleness + ranker + timestamp). */}
      <div className="flex items-center gap-3 border-b border-border-visible bg-card px-4 py-2">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
          <RadioTower size={13} /> Command Deck
        </span>
        <span
          className={cn(
            "flex items-center gap-1 rounded-full border px-2 py-px font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)]",
            health.stale
              ? "border-[color-mix(in_srgb,var(--aios-amber)_45%,var(--aios-border-visible))] text-[var(--aios-amber)]"
              : "border-border-visible text-[var(--green)]"
          )}
        >
          {health.stale ? <AlertTriangle size={11} /> : <Activity size={11} />}
          {health.stale ? "stale" : "deck live"}
        </span>
        {view && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {view.items.length} items · {health.agentAsks} agent asks · {view.ranker_version}
          </span>
        )}
        {error && (
          <span className="ml-auto font-mono text-[11px] text-destructive" role="status">
            {error}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {view ? (
          <CommsQueue view={view} selectedId={selectedId} onSelect={onSelect} />
        ) : (
          <div className="flex w-[360px] shrink-0 items-center justify-center border-r border-border-visible bg-card text-[13px] text-muted-foreground">
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

function deriveHealth(view: InboxView | null) {
  const items = view?.items ?? [];
  return {
    stale: Boolean(view?.staleness.stale),
    agentAsks: items.filter((i) => i.origin === "agent-event").length,
  };
}
