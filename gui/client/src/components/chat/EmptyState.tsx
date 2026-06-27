import { Button } from "@aios-alpha/ui";

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
    <div className="empty-chips">
      <Button
        variant="secondary"
        size="sm"
        className="empty-chip"
        disabled={!canStart}
        onClick={() => onPick("what changed this week?")}
      >
        what changed this week?
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className="empty-chip"
        disabled={!canStart}
        onClick={onDraftFromLink}
      >
        draft from a link
      </Button>
    </div>
  );
}
