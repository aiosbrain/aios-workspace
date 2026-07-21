import { test } from "node:test";
import assert from "node:assert/strict";

import { extractUsd, listGogGmailAccounts, scanInvoiceEmails } from "./cost-email-scan.mjs";

test("extractUsd handles billing phrases and refuses ambiguous totals", () => {
  assert.equal(extractUsd("We charged $10.00 to fund your account"), 10);
  assert.equal(extractUsd("Amount paid: USD 1,234.50"), 1234.5);
  assert.equal(extractUsd("Receipt: $20.00"), 20);
  assert.equal(extractUsd("Subtotal $20.00, total $22.00"), 22);
  assert.equal(extractUsd("$20.00 or $25.00"), null);
  assert.equal(extractUsd("card ending 5857"), null);
});

test("listGogGmailAccounts only returns Gmail-capable accounts", async () => {
  const runGog = async () =>
    JSON.stringify([
      { email: "one@example.com", services: ["gmail", "drive"] },
      { email: "two@example.com", services: ["drive"] },
    ]);
  assert.deepEqual(await listGogGmailAccounts(runGog), ["one@example.com"]);
});

test("scanner is read-only, bounds output, verifies sender, and classifies OpenAI API funding", async () => {
  const calls = [];
  const runGog = async (args) => {
    calls.push(args);
    if (args[0] === "auth") {
      return JSON.stringify([{ email: "owner@example.com", services: ["gmail"] }]);
    }
    if (args[0] === "gmail" && args[1] === "messages") {
      const query = args[3];
      if (query.includes("from:openai.com")) {
        return JSON.stringify([
          {
            id: "m-openai",
            from: "OpenAI <noreply@tm.openai.com>",
            subject: "Your OpenAI API account has been funded",
            date: "2026-07-03 10:00",
          },
        ]);
      }
      if (query.includes("from:cursor.com")) {
        return JSON.stringify([
          {
            id: "m-spoof",
            from: "Cursor billing <billing@evil.example>",
            subject: "Cursor receipt $999.00",
            date: "2026-07-02 10:00",
          },
          {
            id: "m-lookalike",
            from: "Cursor billing <billing@notcursor.com>",
            subject: "Cursor receipt $888.00",
            date: "2026-07-02 11:00",
          },
        ]);
      }
      return "[]";
    }
    if (args[0] === "gmail" && args[1] === "get" && args[2] === "m-openai") {
      return JSON.stringify({
        headers: {
          from: "OpenAI <noreply@tm.openai.com>",
          subject: "Your OpenAI API account has been funded",
          date: "Fri, 03 Jul 2026 03:00:00 +0000",
        },
        message: {
          id: "m-openai",
          snippet: "We charged $10.00 to fund your OpenAI API credit balance. PRIVATE BODY OMITTED",
        },
      });
    }
    if (args[0] === "gmail" && args[1] === "get" && args[2] === "m-spoof") {
      return JSON.stringify({
        headers: { from: "billing@evil.example", subject: "Cursor receipt $999.00" },
        message: { id: "m-spoof", snippet: "not a trusted sender" },
      });
    }
    if (args[0] === "gmail" && args[1] === "get" && args[2] === "m-lookalike") {
      return JSON.stringify({
        headers: { from: "billing@notcursor.com", subject: "Cursor receipt $888.00" },
        message: { id: "m-lookalike", snippet: "lookalike apex is not a trusted subdomain" },
      });
    }
    throw new Error(`unexpected gog call: ${args.join(" ")}`);
  };

  const result = await scanInvoiceEmails({ period: "2026-07", runGog });
  assert.deepEqual(result.accounts, ["owner@example.com"]);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(
    {
      provider: result.candidates[0].provider,
      label: result.candidates[0].label,
      kind: result.candidates[0].kind,
      amount_usd: result.candidates[0].amount_usd,
      date: result.candidates[0].date,
    },
    { provider: "openai", label: "OpenAI API", kind: "metered", amount_usd: 10, date: "2026-07-03" }
  );
  assert.ok(!JSON.stringify(result).includes("PRIVATE BODY OMITTED"));
  assert.ok(calls.every((args) => !args.includes("--include-body")));
  assert.ok(calls.every((args) => !args.includes("--full")));
  assert.ok(calls.every((args) => !args.some((arg) => /send|modify|delete/.test(arg))));
});

test("scanner rejects invalid periods and unconfigured accounts before Gmail search", async () => {
  const runGog = async (args) => {
    if (args[0] === "auth") {
      return JSON.stringify([{ email: "owner@example.com", services: ["gmail"] }]);
    }
    throw new Error("should not search");
  };
  await assert.rejects(() => scanInvoiceEmails({ period: "July", runGog }), /YYYY-MM/);
  await assert.rejects(
    () => scanInvoiceEmails({ period: "2026-07", accounts: ["other@example.com"], runGog }),
    /not configured/
  );
});
