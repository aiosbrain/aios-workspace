import { Box, Text, render, useInput, useApp, useStdout } from "ink";
import { useState, useEffect } from "react";
import { Providers } from "./theme.js";
import { Select } from "./vendor/ui/select.js";
import { MultiSelect } from "./vendor/ui/multi-select.js";
import { TextInput } from "./vendor/ui/text-input.js";
import { PasswordInput } from "./vendor/ui/password-input.js";
import { StatusMessage } from "./vendor/ui/status-message.js";
import { ProgressBar } from "./vendor/ui/progress-bar.js";
import { safeText } from "./report.js";
import type { Capabilities, Prompt, ProgressEvent } from "./types.js";

export class PromptCancelled extends Error {
  code = "AIOS_UI_CANCELLED";
  constructor() {
    super("Cancelled. Completed steps remain saved; no further steps were run.");
  }
}
function Question({
  question,
  complete,
  cancel,
  ctx,
}: {
  question: Prompt;
  complete: (value: string | string[]) => void;
  cancel: () => void;
  ctx: Capabilities;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [width, setWidth] = useState(ctx.width);
  useEffect(() => {
    const resize = () => setWidth(stdout.columns || ctx.width);
    stdout.on("resize", resize);
    return () => {
      stdout.off("resize", resize);
    };
  }, [stdout, ctx.width]);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      cancel();
      exit();
    }
  });
  const submit = (value: string | string[]) => {
    complete(value);
    exit();
  };
  const options =
    question.options?.map((o) => ({ ...o, label: safeText(o.label), hint: safeText(o.hint) })) ??
    [];
  return (
    <Box flexDirection="column" width={width}>
      <Text bold>{safeText(question.message)}</Text>
      {question.kind === "select" ? (
        <Select
          options={options}
          defaultValue={question.initialValue}
          autoFocus
          onSubmit={submit}
        />
      ) : question.kind === "multiselect" ? (
        <MultiSelect
          options={options}
          defaultValue={question.initialValues}
          autoFocus
          height={Math.max(2, Math.min(8, (stdout.rows || 24) - 7))}
          onSubmit={submit}
        />
      ) : question.kind === "password" ? (
        <PasswordInput
          autoFocus
          width={Math.max(10, width - 4)}
          showToggle={false}
          onSubmit={submit}
        />
      ) : (
        <TextInput
          autoFocus
          width={Math.max(10, width - 2)}
          bordered={false}
          placeholder={question.placeholder}
          onSubmit={submit}
        />
      )}
      <Text>
        {question.kind === "multiselect"
          ? ctx.glyphs === "ascii"
            ? "Up/Down move | Space toggle | Enter confirm | Esc cancel"
            : "↑↓ move · Space toggle · Enter confirm · Esc cancel"
          : ctx.glyphs === "ascii"
            ? "Enter confirm | Esc cancel"
            : "Enter confirm · Esc cancel"}
      </Text>
    </Box>
  );
}
let active = false;
export async function prompt(
  ctx: Capabilities,
  question: Prompt,
  stdout = process.stdout,
  stdin = process.stdin
): Promise<string | string[]> {
  if (active) throw new Error("A terminal prompt is already active");
  let value: string | string[] | undefined;
  let cancelled = false;
  const instance = render(
    <Providers ctx={ctx}>
      <Question
        ctx={ctx}
        question={question}
        complete={(answer) => {
          value = answer;
        }}
        cancel={() => {
          cancelled = true;
        }}
      />
    </Providers>,
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, alternateScreen: false }
  );
  active = true;
  const stop = () => {
    cancelled = true;
    instance.unmount();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await instance.waitUntilExit();
    if (cancelled || value === undefined) throw new PromptCancelled();
    return value;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    instance.cleanup();
    active = false;
  }
}

// Live regions exist only while an asynchronous operation is quiet. Callers stop before
// printing legacy output, asking a question, or returning to another renderer.
export function startProgress(ctx: Capabilities, event: ProgressEvent, stdout = process.stderr) {
  if (active || !ctx.motion || ctx.tier !== "rich") return { stop() {} };
  const instance = render(
    <Providers ctx={ctx}>
      <Box flexDirection="column" width={ctx.width}>
        <StatusMessage variant="loading">{safeText(event.label)}</StatusMessage>
        {event.total !== undefined && event.total > 0 && event.completed !== undefined && (
          <ProgressBar
            value={event.completed}
            total={event.total}
            width={Math.min(24, Math.max(4, ctx.width - 16))}
          />
        )}
      </Box>
    </Providers>,
    {
      stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: false,
    }
  );
  active = true;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    instance.clear();
    instance.cleanup();
    active = false;
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", terminated);
  };
  const interrupted = () => {
    stop();
    process.kill(process.pid, "SIGINT");
  };
  const terminated = () => {
    stop();
    process.kill(process.pid, "SIGTERM");
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", terminated);
  return { stop };
}
