import { forwardRef } from "react";
import { ArrowUp } from "lucide-react";

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  /** Hero variant: drop the docked wrapper's top border + padding. */
  bare?: boolean;
}

/** The message input — a compact rounded box with a small send button (Codex/Cursor style). */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onChange, onSend, disabled, busy, placeholder, bare = false },
  ref
) {
  return (
    <div className={bare ? "" : "border-t border-border-visible px-5 py-3.5"}>
      <div className="flex items-end gap-2 rounded-xl border border-border-visible bg-card py-1.5 pl-3.5 pr-1.5 transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--aios-ring)_18%,transparent)]">
        <textarea
          ref={ref}
          rows={1}
          className="max-h-[180px] min-h-[24px] min-w-0 flex-1 resize-none border-none bg-transparent py-[7px] font-sans leading-normal text-foreground outline-none placeholder:text-muted-foreground"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button
          className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground transition-[background,opacity] hover:bg-[var(--accent-hover)] disabled:cursor-default disabled:opacity-40"
          onClick={onSend}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          title="Send"
        >
          {busy ? (
            <span className="h-[14px] w-[14px] animate-[composer-spin_0.7s_linear_infinite] rounded-full border-2 border-[color-mix(in_srgb,var(--accent-fg)_40%,transparent)] border-t-[var(--accent-fg)]" />
          ) : (
            <ArrowUp size={17} strokeWidth={2.5} />
          )}
        </button>
      </div>
    </div>
  );
});
