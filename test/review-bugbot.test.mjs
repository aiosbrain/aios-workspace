#!/usr/bin/env node
import {
  detectBugbotClear,
  buildBugbotPrompt,
  hasCriticalOrHighFindings,
  SEVERITY_RANK,
  BUGBOT_CLEAR_TOKEN,
  retryReviewOnRetriable,
} from "../scripts/review-bugbot.mjs";

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

console.log("detectBugbotClear");
{
  check("exact CLEAR token passes", detectBugbotClear(BUGBOT_CLEAR_TOKEN));
  check("surrounding whitespace passes", detectBugbotClear(`\n${BUGBOT_CLEAR_TOKEN}\n`));
  check("High finding blocks", detectBugbotClear("## Findings\n\n- High: bad thing\n") === false);
  check("no-findings prose plus token blocks", !detectBugbotClear(`None.\n${BUGBOT_CLEAR_TOKEN}`));
  check(
    "contradictory finding plus token blocks",
    !detectBugbotClear(`High: bug\n${BUGBOT_CLEAR_TOKEN}`)
  );
  // AIO-472 — tolerate the composer-2.5 streaming artifact (pure repeated tokens) while still
  // rejecting any prose alongside the token.
  check("doubled/concatenated token passes", detectBugbotClear("BUGBOT_CLEARBUGBOT_CLEAR"));
  check(
    "repeated token on separate lines passes",
    detectBugbotClear(`${BUGBOT_CLEAR_TOKEN}\n${BUGBOT_CLEAR_TOKEN}`)
  );
  check(
    'token followed by prose ("not appropriate here") blocks',
    !detectBugbotClear(`${BUGBOT_CLEAR_TOKEN} is not appropriate here`)
  );
  check(
    "token glued to a trailing word blocks",
    !detectBugbotClear(`${BUGBOT_CLEAR_TOKEN}Reviewing the diff`)
  );
  check("empty response blocks", !detectBugbotClear(""));
}

console.log("retryReviewOnRetriable (AIO-472)");
{
  const run = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      return { threw: e };
    } finally {
      void label;
    }
  };

  // retries a transient resource_exhausted, then succeeds
  {
    let calls = 0;
    const result = await run("retriable-then-ok", () =>
      retryReviewOnRetriable(
        () => {
          calls++;
          if (calls === 1) throw new Error("RetriableError: [resource_exhausted] slow down");
          return "OK";
        },
        { attempts: 3, baseDelayMs: 1 }
      )
    );
    check("retriable error retried then succeeds", result === "OK" && calls === 2);
  }

  // a non-retriable error rethrows immediately without retrying
  {
    let calls = 0;
    const result = await run("non-retriable", () =>
      retryReviewOnRetriable(
        () => {
          calls++;
          throw new Error("bad prompt — hard failure");
        },
        { attempts: 3, baseDelayMs: 1 }
      )
    );
    check(
      "non-retriable error rethrows without retry",
      result?.threw?.message?.includes("hard failure") && calls === 1
    );
  }

  // a timeout is NOT retriable here — that path is owned by retryReviewTimeoutOnce
  {
    let calls = 0;
    const result = await run("timeout-not-retried", () =>
      retryReviewOnRetriable(
        () => {
          calls++;
          throw new Error("cursor timed out after 400s");
        },
        { attempts: 3, baseDelayMs: 1 }
      )
    );
    check("timeout error is not retried by retriable-retry", result?.threw && calls === 1);
  }

  // exhausts all attempts on a persistent retriable error, throwing the last one
  {
    let calls = 0;
    const result = await run("exhausted", () =>
      retryReviewOnRetriable(
        () => {
          calls++;
          throw new Error("429 rate limit");
        },
        { attempts: 2, baseDelayMs: 1 }
      )
    );
    check(
      "persistent retriable error throws after attempts exhausted",
      result?.threw?.message?.includes("429") && calls === 2
    );
  }
}

console.log("buildBugbotPrompt");
{
  const p = buildBugbotPrompt({
    skill: "/review-bugbot",
    branch: "feat/x",
    baseSha: "abc123",
    diffStat: " a | 1 +",
    diff: "+line",
    logOneline: "abc feat",
  });
  check("includes skill", p.startsWith("/review-bugbot"));
  check("includes diff", p.includes("+line"));
  check("asks for CLEAR token", p.includes(BUGBOT_CLEAR_TOKEN));
  check("requires an exact clear-only response", /entire response MUST be exactly/.test(p));
}

console.log("hasCriticalOrHighFindings — one dialect (bullet, table, bracket)");
{
  // Bracket form (the consolidated findings report) — the new case.
  check(
    "[High] file:line bracket blocks",
    hasCriticalOrHighFindings("[High] scripts/x.mjs:42 — bad") === true
  );
  check("[Critical] bracket blocks", hasCriticalOrHighFindings("[Critical] a:1 — leak") === true);
  // Still matches the original bullet + table forms.
  check("bullet form still matches", hasCriticalOrHighFindings("- High: something") === true);
  check(
    "table form still matches",
    hasCriticalOrHighFindings("| Critical | file | desc |") === true
  );
  // Prose / lower severities do NOT match.
  check(
    "prose 'no Critical or High' ignored",
    hasCriticalOrHighFindings("There are no Critical or High findings.") === false
  );
  check(
    "[Medium]/[Low] brackets ignored",
    hasCriticalOrHighFindings("[Medium] x — nit\n[Low] y — typo") === false
  );
  check(
    "SEVERITY_RANK ordering",
    SEVERITY_RANK.Critical > SEVERITY_RANK.High &&
      SEVERITY_RANK.High > SEVERITY_RANK.Medium &&
      SEVERITY_RANK.Medium > SEVERITY_RANK.Low
  );
}

// AIO-239: severity matchers must tolerate markdown emphasis — the consolidator model bolds
// findings (`**[High]**`), and a decoration-blind matcher silently downgraded BLOCKED to CLEAR.
console.log("hasCriticalOrHighFindings: markdown-decorated severities still match");
{
  check("bold bracket **[High]**", hasCriticalOrHighFindings("**[High]** `f.mjs`: bypass"));
  check("bold bracket **[Critical]**", hasCriticalOrHighFindings("**[Critical]** boom"));
  check("bold bullet - **High**:", hasCriticalOrHighFindings("- **High**: bad thing"));
  check("bold table | **High** |", hasCriticalOrHighFindings("| **High** | f | desc |"));
  check("plain forms still match", hasCriticalOrHighFindings("[High] plain"));
  check(
    "prose about severities still does NOT match",
    !hasCriticalOrHighFindings("There are no Critical or High findings.")
  );
  check("bold Medium does NOT match", !hasCriticalOrHighFindings("**[Medium]** meh"));
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
