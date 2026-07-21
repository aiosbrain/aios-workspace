import { useEffect, useState } from "react";
import { Send } from "lucide-react";

export interface ReplyComposerProps {
  itemId: string;
  resetKey: number;
  onReview: (itemId: string, body: string) => Promise<void>;
}

export function ReplyComposer({ itemId, resetKey, onReview }: ReplyComposerProps) {
  const [body, setBody] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBody("");
    setChecking(false);
    setError(null);
  }, [itemId, resetKey]);

  return (
    <section className="max-w-3xl border-t border-border-visible pt-4">
      <label htmlFor={`gmail-reply-${itemId}`} className="text-[12px] font-medium text-foreground">
        Reply in Gmail
      </label>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Recipients, subject, account, and Gmail thread are filled from this message.
      </p>
      <textarea
        id={`gmail-reply-${itemId}`}
        className="mt-3 min-h-28 w-full resize-y rounded-md border border-border-visible bg-background px-3 py-2 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
        value={body}
        disabled={checking}
        placeholder="Write your reply…"
        onChange={(event) => setBody(event.target.value)}
      />
      {error && (
        <p className="mt-2 text-[12px] text-destructive" role="status">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:bg-[var(--accent-hover)] disabled:opacity-50"
          disabled={checking || !body.trim()}
          onClick={async () => {
            setChecking(true);
            setError(null);
            try {
              // Body bytes are intentionally not trimmed: review and send bind exactly what was typed.
              await onReview(itemId, body);
            } catch (reviewError) {
              setError((reviewError as Error).message);
            } finally {
              setChecking(false);
            }
          }}
        >
          <Send size={13} /> {checking ? "Checking…" : "Review & send"}
        </button>
      </div>
    </section>
  );
}
