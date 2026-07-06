#!/usr/bin/env node
/**
 * onboard-ui.mjs — the interactive prompt layer for `aios onboard`, replacing the old
 * serial [y/N]-per-connector wizard with an OpenClaw/Hermes-style flow: one arrow-key +
 * spacebar multi-select over every connector (Team Brain pinned and pre-selected at the
 * top), masked secret input, and per-item validation feedback with a reason on failure.
 *
 * This is the ONLY place in this CLI that takes an npm dependency (@clack/prompts) —
 * hand-rolling reliable multi-select + masking + Ctrl-C handling + non-TTY fallback is
 * exactly the class of bug most projects get subtly wrong. The sync engine
 * (push/pull/status/query) and connector.mjs's engine underneath this stay dependency-free.
 */

import * as clack from "@clack/prompts";

/** Bail out the same way everywhere on Ctrl-C/Esc: a cancel message, then exit 1. */
export function bailOnCancel(value) {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled — nothing else was changed.");
    process.exit(1);
  }
  return value;
}

function connectorLabel(item) {
  return item.status === "wired" ? `${item.name} (already connected)` : item.name;
}

/**
 * Pure: build the {options, initialValues} clack's multiselect needs from the connector
 * list + the pinned Team Brain entry (the Team Brain isn't a real connector descriptor,
 * since its auth is a plain env var, not a descriptor-driven validate/store flow) —
 * pinned to the top, pre-selected, and (like every already-wired connector) labeled as
 * already connected so re-running onboard reflects current state instead of
 * re-prompting blindly. Each option's hint is the connector's own summary, so
 * near-identical names (e.g. "Slack" vs "Slack (personal)") read as distinct lines
 * instead of bare ids with no explanation. Exported separately from pickConnectors so
 * this logic is unit-testable without driving a real interactive prompt.
 */
export function buildConnectorOptions(connectors, pinned) {
  const options = [];
  const initialValues = [];
  if (pinned) {
    options.push({ value: pinned.id, label: connectorLabel(pinned), hint: pinned.summary });
    initialValues.push(pinned.id);
  }
  for (const c of connectors) {
    options.push({ value: c.id, label: connectorLabel(c), hint: c.summary });
    if (c.status === "wired") initialValues.push(c.id);
  }
  return { options, initialValues };
}

export async function pickConnectors(connectors, { pinned } = {}) {
  const { options, initialValues } = buildConnectorOptions(connectors, pinned);
  const selected = await clack.multiselect({
    message: "Connect a few things — every step is optional. Space to toggle, Enter to confirm.",
    options,
    initialValues,
    required: false,
  });
  return bailOnCancel(selected);
}

/**
 * Masked secret prompt, with the "how do I get one" instructions shown above it.
 * Trims the result — a pasted secret commonly carries a trailing newline/space that
 * would otherwise get stored verbatim and silently break auth later.
 */
export async function askSecret(label, { instructions, instructionsUrl } = {}) {
  if (instructions) clack.log.info(instructions);
  else if (instructionsUrl) clack.log.info(`Get one: ${instructionsUrl}`);
  const value = await clack.password({ message: `${label}:` });
  return bailOnCancel(value)?.trim() ?? "";
}

/**
 * connectFlow's readline-era prompts read like "  Slack token (SLACK_BOT_TOKEN): " —
 * trailing colon/whitespace and leading indentation that made sense for a raw
 * `rl.question()` line but reads oddly as a clack prompt message. Pure so the trimming
 * itself is unit-testable without driving a real prompt.
 */
export function cleanQuestion(question) {
  return question.trim().replace(/:\s*$/, "");
}

/**
 * Adapts connectFlow's/oauthConnectFlow's injectable `ask(question) => Promise<string>`
 * callback (in scripts/aios.mjs) onto clack's masked password prompt — every question
 * connectFlow ever asks through `ask` is a secret (a token/key value), so masking
 * unconditionally is correct. This is the one integration point that lets the existing
 * connect→validate→store engine stay untouched.
 */
export async function askViaClack(question) {
  const value = await clack.password({ message: cleanQuestion(question) });
  return bailOnCancel(value) ?? "";
}

/** Render connector.mjs's validateConnector() check list with ✓/✗ + reason. */
export function reportValidation(checks) {
  for (const check of checks || []) {
    const line = check.detail ? `${check.name} — ${check.detail}` : check.name;
    if (check.ok) clack.log.success(line);
    else clack.log.error(line);
  }
}

export { clack };
