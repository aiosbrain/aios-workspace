import { useState } from "react";
import { ChevronRight, FileText, ScrollText, Sparkles } from "lucide-react";
import { useConnection, useSession } from "../../state/cockpit";
import { MarkdownBlock } from "../ui/MarkdownBlock";
import { LoadingRows, LOOP_BTN_PRIMARY } from "./chrome";
import { toast } from "../ui/sonner";
import { cn } from "../../lib/cn";
import type { WeeklyCloseoutResponse } from "../../types/protocol";
import {
  askPromptForItem,
  parseBrief,
  type WeeklyGroup,
  type WeeklyGroupBlock,
  type WeeklyItem,
} from "./weekly";

/**
 * Weekly closeout — the owner brief as a console instead of a document dump.
 *
 * The C5 brief is a deterministic markdown artifact: one bullet per signal under a single
 * heading. Rendering it verbatim meant a 725-line wall in which 289 mirrored commit rows sat
 * beside 13 real decisions, all styled identically — "no way to make sense of this". This view
 * reads the brief back into groups (see weekly.ts), leads with what the operator actually
 * decided and owes, collapses the received feeds, and offers the same "Ask" hand-off the Today
 * queue does so a row can go straight to the agent with its evidence ref attached.
 *
 * The raw markdown stays one click away: this is a lens on the artifact, never a replacement
 * for it, and the brief on disk remains the source of truth.
 */

/** Compact row/inline control — matches the Today queue's button, not the panel-level primary. */
const BTN =
  "inline-flex items-center gap-1.5 rounded-[7px] border border-border-visible bg-secondary px-2.5 py-1 text-[12px] text-foreground cursor-pointer transition-colors hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)] disabled:cursor-default disabled:opacity-40";

/** Tone per group: owed work reads warm, received feeds read quiet. */
const GROUP_TONE: Record<WeeklyGroup, string> = {
  decision: "border-violet/40 bg-violet/10 text-violet",
  work: "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground",
  reply: "border-cyan/40 bg-cyan/10 text-cyan",
  meeting: "border-border-visible bg-secondary text-muted-foreground",
  task: "border-amber/45 bg-amber/10 text-amber",
  brain: "border-border-visible bg-secondary text-muted-foreground",
  context: "border-border-visible bg-secondary text-muted-foreground",
  mirror: "border-border-visible bg-secondary text-muted-foreground",
  other: "border-border-visible bg-secondary text-muted-foreground",
};

function GroupBadge({ group, label, count }: { group: WeeklyGroup; label: string; count: number }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)]",
        GROUP_TONE[group]
      )}
    >
      {label}
      <span className="opacity-70">{count}</span>
    </span>
  );
}

function ItemRow({ item, onAsk }: { item: WeeklyItem; onAsk: (item: WeeklyItem) => void }) {
  return (
    <li className="group/row flex items-center gap-2.5 rounded-[8px] px-2 py-1.5 hover:bg-secondary">
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={item.title}>
        {item.title}
      </span>
      {item.decisionType && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {item.decisionType}
        </span>
      )}
      {/* The evidence ref is the audit trail — demoted, never dropped. */}
      {item.evidence[0] && (
        <span
          className="hidden shrink-0 truncate font-mono text-[10px] text-muted-foreground opacity-60 md:block md:max-w-[220px]"
          title={item.evidence.join(", ")}
        >
          {item.evidence[0]}
        </span>
      )}
      <button
        type="button"
        className={cn(BTN, "shrink-0 opacity-0 group-hover/row:opacity-100 focus:opacity-100")}
        onClick={() => onAsk(item)}
        aria-label={`Ask the agent about ${item.title}`}
      >
        <Sparkles size={12} aria-hidden="true" />
        Ask
      </button>
    </li>
  );
}

function GroupBlock({
  block,
  onAsk,
}: {
  block: WeeklyGroupBlock;
  onAsk: (item: WeeklyItem) => void;
}) {
  const [open, setOpen] = useState(block.defaultOpen);
  return (
    <section className="rounded-[10px] border border-border-visible bg-card">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          size={14}
          className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <GroupBadge group={block.group} label={block.label} count={block.items.length} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          {block.hint}
        </span>
      </button>
      {open && (
        <ul className="m-0 flex list-none flex-col p-0 px-1.5 pb-1.5">
          {block.items.map((item) => (
            <ItemRow key={item.key} item={item} onAsk={onAsk} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BriefHeader({ brief }: { brief: ReturnType<typeof parseBrief> }) {
  const { header, itemCount } = brief;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-[14px] text-foreground">
          {header.member ? `Private operator brief — ${header.member}` : "Private operator brief"}
        </span>
        {header.from && header.to && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {header.from} → {header.to}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
        {header.verifier && (
          <span className={cn(header.verifier === "FAILED" && "text-destructive")}>
            verifier {header.verifier}
          </span>
        )}
        {header.tierCounts.map((t) => (
          <span key={t.tier}>
            {t.tier} {t.count}
          </span>
        ))}
        <span>{itemCount} signals</span>
        {header.foldedCommits > 0 && <span>{header.foldedCommits} commit rows folded</span>}
      </div>
    </div>
  );
}

export function WeeklyView() {
  const { api } = useConnection();
  const { askInNewChat } = useSession();
  const [data, setData] = useState<WeeklyCloseoutResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const res = await api.post<WeeklyCloseoutResponse>("/api/loop/weekly", {});
      setData(res);
      if (res.cliExitCode === 1) {
        toast.warning("Closeout drafted, but an audience is not shippable");
      } else {
        toast.success("Weekly closeout drafted");
      }
    } catch (e) {
      toast.error(`Closeout failed: ${(e as Error).message}`, { duration: 10_000 });
    }
    setBusy(false);
  };

  const askAgent = (item: WeeklyItem) => {
    // Always a FRESH chat, same as the Today queue: splicing into an open conversation drags in
    // unrelated context and a replayed transcript's socket is closed, so the turn is dropped.
    void askInNewChat(askPromptForItem(item));
  };

  const brief = data ? parseBrief(data.briefMarkdown) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          Runs the offline drafter locally — no network egress.
        </span>
        <div className="flex items-center gap-2">
          {data && (
            <button
              className={BTN}
              onClick={() => setShowRaw((v) => !v)}
              aria-pressed={showRaw}
              aria-label="Toggle the raw brief markdown"
            >
              {showRaw ? <ScrollText size={12} /> : <FileText size={12} />}
              {showRaw ? "Grouped" : "Raw brief"}
            </button>
          )}
          <button className={LOOP_BTN_PRIMARY} onClick={run} disabled={busy}>
            {busy ? "Running…" : data ? "Re-run closeout" : "Run closeout"}
          </button>
        </div>
      </div>

      {!data ? (
        busy ? (
          <LoadingRows />
        ) : (
          <div className="m-auto max-w-[440px] py-8 text-center text-muted-foreground">
            Run a weekly closeout to draft the owner brief and per-audience digests.
          </div>
        )
      ) : (
        <>
          {data.cliExitCode === 1 && (
            <div className="rounded-[8px] border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              At least one audience digest is not shippable — review before sharing.
            </div>
          )}

          {brief && <BriefHeader brief={brief} />}

          <div className="flex flex-wrap gap-2 font-mono text-[11px] text-muted-foreground">
            <span>run {data.runStamp}</span>
            {data.audiences.map((a) => (
              <span
                key={a.audience}
                className={cn(
                  "rounded-sm border border-border-visible px-1.5 py-px",
                  a.shippable ? "text-foreground" : "text-destructive"
                )}
              >
                {a.audience}: {a.status}
              </span>
            ))}
          </div>

          {showRaw ? (
            <div className="assistant-prose rounded-xl border border-border-visible bg-card px-3.5 py-2.5">
              <MarkdownBlock>{data.briefMarkdown}</MarkdownBlock>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {brief?.groups.length ? (
                brief.groups.map((block) => (
                  <GroupBlock key={block.group} block={block} onAsk={askAgent} />
                ))
              ) : (
                <div className="m-auto max-w-[440px] py-6 text-center text-[13px] text-muted-foreground">
                  The brief carried no signals this week.
                </div>
              )}

              <section className="mt-1 rounded-[10px] border border-border-visible bg-card px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <GroupBadge group="task" label="Next week" count={brief?.nextWeek.length ?? 0} />
                  <span className="text-[12px] text-muted-foreground">
                    Carried into next week by the drafter.
                  </span>
                </div>
                {brief?.nextWeek.length ? (
                  <ul className="m-0 mt-1.5 flex list-none flex-col p-0">
                    {brief.nextWeek.map((a) => (
                      <li
                        key={a.key}
                        className="flex items-center gap-2.5 rounded-[8px] px-2 py-1.5 hover:bg-secondary"
                      >
                        {a.tier && (
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            [{a.tier}]
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                          {a.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="m-0 mt-1.5 px-2 text-[12px] text-muted-foreground">
                    No next-week actions proposed.
                  </p>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
