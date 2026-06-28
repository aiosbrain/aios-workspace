// Shared utility-class strings for the modal wizards (Connect + Skill review).
// Kept in one place so the connect flow and the skill-review gate stay visually
// identical. Colors/type come from the design tokens via the GUI var bridge.
export const WIZ_OVERLAY = "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6";
export const WIZ =
  "flex max-h-[90vh] w-[min(520px,100%)] flex-col gap-3.5 overflow-y-auto rounded-2xl border border-border-visible bg-popover p-5 shadow-overlay";
export const WIZ_HEAD = "flex items-center justify-between text-[15px] font-semibold";
export const WIZ_X = "cursor-pointer bg-transparent text-base text-muted-foreground";
export const WIZ_STEP = "flex flex-col gap-1.5";
export const WIZ_STEP_N = "font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground";
export const WIZ_LINK =
  "inline-block rounded-[9px] border border-border-visible bg-secondary px-3.5 py-[9px] text-[13px] font-semibold text-primary no-underline";
export const WIZ_INAPP = "text-[13px] text-muted-foreground";
export const WIZ_NOTE = "my-0.5 text-[12.5px] leading-[1.45] text-muted-foreground";
export const WIZ_SCOPES = "m-0 text-[12.5px] text-foreground";
export const WIZ_FIELD = "flex flex-col gap-1";
export const WIZ_FIELD_LABEL = "text-xs text-muted-foreground";
export const WIZ_INPUT_ROW = "flex gap-1.5";
export const WIZ_INPUT =
  "flex-1 rounded-[8px] border border-border-visible bg-background px-[11px] py-[9px] font-mono text-[13px] text-foreground outline-none focus:border-primary";
export const WIZ_EYE =
  "cursor-pointer rounded-[8px] border border-border-visible bg-secondary px-2.5";
export const WIZ_VALIDATING = "text-[13px] text-muted-foreground";
export const WIZ_CHECKS = "m-0 flex list-none flex-col gap-1 p-0";
export const WIZ_ERROR = "text-[13px] text-destructive [&_a]:text-primary";
export const WIZ_GO =
  "cursor-pointer rounded-md bg-primary px-4 py-2.5 font-semibold text-primary-foreground enabled:hover:bg-[var(--accent-hover)] enabled:hover:shadow-[var(--glow-violet)] disabled:cursor-default disabled:opacity-40";
export const WIZ_SECONDARY =
  "cursor-pointer rounded-[10px] border border-border-visible bg-transparent px-4 py-2.5 text-foreground";
export const WIZ_DONE = "flex flex-col items-start gap-2.5";
export const WIZ_DONE_BADGE = "text-base font-bold text-emerald";
export const WIZ_DONE_ACTIONS = "flex gap-2";
export const WIZ_TEXT =
  "w-full rounded-[8px] border border-border-visible bg-background px-[11px] py-[9px] font-mono text-[13px] text-foreground outline-none focus:border-primary";
