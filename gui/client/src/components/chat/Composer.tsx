import { forwardRef } from "react";

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  busy: boolean;
  placeholder: string;
}

/** The message input. Enter sends; Shift+Enter inserts a newline. */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onChange, onSend, disabled, busy, placeholder },
  ref,
) {
  return (
    <footer>
      <textarea
        ref={ref}
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
      <button onClick={onSend} disabled={disabled || !value.trim()}>
        {busy ? "…" : "Send"}
      </button>
    </footer>
  );
});
