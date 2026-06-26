import { Button, EyebrowLabel } from "@aios-alpha/ui";

/** First-run prompt suggestions, shown when the chat has no messages. */
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
    <div className="empty">
      <EyebrowLabel className="empty-eyebrow">Start a turn</EyebrowLabel>
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
    </div>
  );
}
