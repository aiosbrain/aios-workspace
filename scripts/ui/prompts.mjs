import { createPresenter } from "./presenter.mjs";

/** Clack-compatible prompt boundary; completed answers stay in scrollback, secrets never do. */
export async function createPromptUI(fallback) {
  const presenter = process.stdin.isTTY ? await createPresenter() : null;
  if (!presenter) return fallback;
  const cancelled = Symbol("cancelled");
  async function ask(kind, options) {
    try {
      const answer = await presenter.prompt({ kind, ...options });
      const displayed =
        kind === "password"
          ? answer
            ? "provided"
            : "skipped"
          : Array.isArray(answer)
            ? answer
                .map((value) => options.options?.find((o) => o.value === value)?.label ?? value)
                .join(", ") || "none selected"
            : (options.options?.find((o) => o.value === answer)?.label ?? answer);
      presenter.step(`${options.message}: ${displayed}`);
      return answer;
    } catch (error) {
      if (error.code === "AIOS_UI_CANCELLED") return cancelled;
      throw error;
    }
  }
  return {
    intro: (message) => presenter.message(message),
    outro: (message) => presenter.message(message),
    cancel: () =>
      presenter.message(
        "Cancelled. Completed steps remain saved; no further steps were run.",
        "warning"
      ),
    isCancel: (value) => value === cancelled,
    log: {
      info: (message) => presenter.message(message),
      warn: (message) => presenter.message(message, "warning"),
      error: (message) => presenter.message(message, "error"),
      success: (message) => presenter.message(message, "success"),
      step: (message) => presenter.step(message),
      message: (message) => presenter.message(message),
    },
    text: (options) => ask("text", options),
    password: (options) => ask("password", options),
    select: (options) => ask("select", options),
    multiselect: (options) => ask("multiselect", options),
    async confirm(options) {
      const value = await ask("select", {
        ...options,
        initialValue: options.initialValue === true ? "yes" : "no",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      });
      return value === cancelled ? cancelled : value === "yes";
    },
  };
}
