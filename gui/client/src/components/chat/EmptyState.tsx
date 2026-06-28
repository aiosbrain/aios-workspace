import { Button } from "@aios-alpha/ui";

const CHIP =
  "rounded-full border border-border-visible bg-transparent px-3.5 py-[7px] text-[13px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-40";

/** First-run prompt suggestions, shown beneath the centered composer hero. */
export function EmptyState({
  canStart,
  onPick,
  onDraftFromLink,
}: {
  canStart: boolean;
  onPick: (prompt: string) => void;
  onDraftFromLink: () => void;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        className={CHIP}
        disabled={!canStart}
        onClick={() => onPick("what changed this week?")}
      >
        what changed this week?
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className={CHIP}
        disabled={!canStart}
        onClick={onDraftFromLink}
      >
        draft from a link
      </Button>
    </div>
  );
}
