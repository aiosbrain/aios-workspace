#!/usr/bin/env node
// CodeRabbit-only selector and evidence contract. No live gh/network.

import {
  BOT_CONFIG,
  checkBotReady,
  hasVisibleReviewText,
  isSubstantive,
  selectBots,
} from "../scripts/wait-for-bots.mjs";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

const BOT = "coderabbitai[bot]";
const config = BOT_CONFIG[BOT];
const headTime = new Date("2026-07-01T00:00:00Z");
const substantive =
  "CodeRabbit reviewed the current head and found a correctness risk in the retry path. " +
  "The loop needs an explicit terminal condition and a regression test for the exhausted case.";

console.log("selectBots — CodeRabbit only");
{
  check(
    "default selects CodeRabbit",
    JSON.stringify(selectBots(BOT_CONFIG)) === JSON.stringify([BOT])
  );
  check(
    "explicit CodeRabbit is accepted",
    JSON.stringify(selectBots(BOT_CONFIG, BOT)) === JSON.stringify([BOT])
  );
  let threw = false;
  try {
    selectBots(BOT_CONFIG, "cursor[bot]");
  } catch (error) {
    threw = /unknown bot/.test(error.message);
  }
  check("Cursor bot is no longer selectable", threw);
}

console.log("substantive current-head evidence");
{
  check("long review text is substantive", isSubstantive(substantive));
  check("HTML-only text is not substantive", !isSubstantive("<!-- internal status only -->"));
  check("short inline finding has visible review text", hasVisibleReviewText("Handle null here."));
  check(
    "HTML-only inline text has no visible review text",
    !hasVisibleReviewText("<!-- internal status only -->")
  );

  const fresh = checkBotReady(
    BOT,
    config,
    [{ user: BOT, body: substantive, created_at: "2026-07-01T00:00:01Z" }],
    [],
    [],
    headTime
  );
  check("fresh issue comment satisfies the gate", fresh.ready && fresh.signal === "issue-comment");

  const stale = checkBotReady(
    BOT,
    config,
    [{ user: BOT, body: substantive, created_at: "2026-06-30T23:59:59Z" }],
    [],
    [],
    headTime
  );
  check("stale pre-push evidence is rejected", stale.ready === false);

  const stub = checkBotReady(
    BOT,
    config,
    [
      {
        user: BOT,
        body: `Review limit reached. ${substantive}`,
        created_at: "2026-07-01T00:00:01Z",
      },
    ],
    [],
    [],
    headTime
  );
  check("rate-limit/review-limit stubs are rejected", stub.ready === false);

  const commandAcknowledgment = checkBotReady(
    BOT,
    config,
    [
      {
        user: BOT,
        body: [
          "<details>",
          "<summary>Action performed</summary>",
          "Review triggered.",
          "> Note: CodeRabbit is an incremental review system and will review the latest changes.",
          "</details>",
        ].join("\n"),
        created_at: "2026-07-01T00:00:01Z",
      },
    ],
    [],
    [],
    headTime
  );
  check("review-command acknowledgments are rejected", commandAcknowledgment.ready === false);

  const review = checkBotReady(
    BOT,
    config,
    [],
    [],
    [{ user: BOT, body: substantive, submitted_at: "2026-07-01T00:00:01Z" }],
    headTime
  );
  check("fresh submitted review satisfies the gate", review.ready && review.signal === "review");

  const shortInline = checkBotReady(
    BOT,
    config,
    [],
    [{ user: BOT, body: "Handle null here.", created_at: "2026-07-01T00:00:01Z" }],
    [],
    headTime
  );
  check(
    "fresh short inline finding satisfies the gate",
    shortInline.ready && shortInline.signal === "inline-comment"
  );

  const shortIssue = checkBotReady(
    BOT,
    config,
    [{ user: BOT, body: "Review started.", created_at: "2026-07-01T00:00:01Z" }],
    [],
    [],
    headTime
  );
  check("short top-level status text does not satisfy the gate", shortIssue.ready === false);

  const noText = checkBotReady(BOT, config, [], [], [], headTime);
  check("a successful check run alone cannot satisfy the gate", noText.ready === false);
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
