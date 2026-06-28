import { forwardRef } from "react";
import { ArrowUp } from "lucide-react";

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  busy: boolean;
  placeholder: string;
}

/** The message input — a compact rounded box with a small send button (Codex/Cursor style). */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onChange, onSend, disabled, busy, placeholder },
  ref
) {
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
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
          className="composer-send"
          onClick={onSend}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          title="Send"
        >
          {busy ? <span className="composer-spinner" /> : <ArrowUp size={17} strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  );
});
