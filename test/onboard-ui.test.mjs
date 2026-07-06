// scripts/onboard-ui.mjs — the connector-picker option-building and question-cleaning
// logic behind the interactive `aios onboard` wizard. The actual clack prompts
// (multiselect/password) are real terminal UI and stay smoke-tested manually per the
// dogfood-run convention; what's unit-tested here is the pure logic feeding them:
// pinning/pre-selection/labeling, and the readline->clack question cleanup.

import test from "node:test";
import assert from "node:assert/strict";
import { buildConnectorOptions, cleanQuestion } from "../scripts/onboard-ui.mjs";

test("buildConnectorOptions pins the Team Brain first and pre-selects it", () => {
  const pinned = { id: "__team_brain__", name: "AIOS Team Brain", summary: "Powers sync" };
  const connectors = [
    { id: "firecrawl", name: "Firecrawl", summary: "Draft from a link", status: "available" },
  ];

  const { options, initialValues } = buildConnectorOptions(connectors, pinned);

  assert.equal(options[0].value, "__team_brain__");
  assert.equal(options[0].label, "AIOS Team Brain");
  assert.equal(options[0].hint, "Powers sync");
  assert.deepEqual(initialValues, ["__team_brain__"]);
});

test("already-wired connectors (and an already-connected pinned entry) are pre-selected and labeled", () => {
  const pinned = { id: "__team_brain__", name: "AIOS Team Brain", summary: "x", status: "wired" };
  const connectors = [
    { id: "firecrawl", name: "Firecrawl", summary: "x", status: "wired" },
    { id: "linear", name: "Linear", summary: "y", status: "available" },
  ];

  const { options, initialValues } = buildConnectorOptions(connectors, pinned);

  assert.equal(options[0].label, "AIOS Team Brain (already connected)");
  assert.equal(options[1].label, "Firecrawl (already connected)");
  assert.equal(options[2].label, "Linear");
  assert.deepEqual(initialValues, ["__team_brain__", "firecrawl"]);
});

test("slack vs slack-personal read as distinct lines via name + hint, not bare ids", () => {
  const connectors = [
    { id: "slack", name: "Slack", summary: "Read channels and threads, post messages.", status: "available" },
    {
      id: "slack-personal",
      name: "Slack (personal)",
      summary: "Act as you in Slack — send/read DMs & messages.",
      status: "available",
    },
  ];

  const { options } = buildConnectorOptions(connectors, null);

  assert.equal(options[0].label, "Slack");
  assert.equal(options[0].hint, "Read channels and threads, post messages.");
  assert.equal(options[1].label, "Slack (personal)");
  assert.equal(options[1].hint, "Act as you in Slack — send/read DMs & messages.");
  assert.notEqual(options[0].label, options[1].label);
});

test("works with no pinned entry at all", () => {
  const { options, initialValues } = buildConnectorOptions(
    [{ id: "notion", name: "Notion", summary: "x", status: "available" }],
    null
  );
  assert.equal(options.length, 1);
  assert.deepEqual(initialValues, []);
});

test("cleanQuestion strips the trailing colon and surrounding whitespace from readline-era prompts", () => {
  assert.equal(cleanQuestion("  Slack token (SLACK_BOT_TOKEN): "), "Slack token (SLACK_BOT_TOKEN)");
  assert.equal(cleanQuestion("AIOS_API_KEY:"), "AIOS_API_KEY");
  assert.equal(cleanQuestion("no colon here"), "no colon here");
});
