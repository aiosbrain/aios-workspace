/**
 * Read-only Gmail invoice discovery for the local Costs panel.
 *
 * The scanner shells out to `gog` with an argv array (never a shell), only for
 * Gmail accounts already configured in gog. Search is restricted to known
 * provider sender domains and one calendar month. Message fetches use Gmail's
 * metadata format, which returns headers + snippet without downloading the
 * message body or attachments. The API response deliberately excludes the
 * snippet and all body content: the GUI receives only bounded invoice metadata
 * and a best-effort USD amount for the owner to review.
 *
 * Scanning NEVER writes cost config. The existing validated config endpoint is
 * the sole write path after the owner explicitly selects candidates.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_ACCOUNTS = 5;
const MAX_RESULTS_PER_PROVIDER = 6;
const MAX_CANDIDATES = 60;

export const INVOICE_PROVIDERS = [
  {
    key: "claude",
    label: "Claude",
    domains: ["anthropic.com", "claude.ai"],
    kind: "subscription",
  },
  { key: "cursor", label: "Cursor", domains: ["cursor.com"], kind: "subscription" },
  {
    key: "codex",
    label: "Codex",
    domains: ["openai.com", "tm.openai.com", "email.openai.com"],
    kind: "subscription",
  },
  {
    key: "opencode",
    label: "OpenCode",
    domains: ["opencode.ai"],
    kind: "subscription",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    domains: ["openrouter.ai"],
    kind: "metered",
  },
  { key: "zai", label: "Z.ai", domains: ["z.ai", "bigmodel.cn"], kind: "subscription" },
];

const LABELS = {
  ...Object.fromEntries(INVOICE_PROVIDERS.map((provider) => [provider.key, provider.label])),
  anthropic: "Anthropic API",
  openai: "OpenAI API",
};

async function defaultRunGog(args) {
  const { stdout } = await execFileAsync("gog", args, {
    timeout: 20_000,
    maxBuffer: 5 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

function parseJson(stdout, context) {
  try {
    return JSON.parse(stdout || "null");
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

function monthBounds(period) {
  if (!PERIOD_RE.test(period)) throw new Error("period must use YYYY-MM");
  const [year, month] = period.split("-").map(Number);
  const next = month === 12 ? [year + 1, 1] : [year, month + 1];
  const slash = (y, m) => `${y}/${String(m).padStart(2, "0")}/01`;
  return { after: slash(year, month), before: slash(next[0], next[1]) };
}

function searchQuery(provider, period) {
  const { after, before } = monthBounds(period);
  const senders = provider.domains.map((domain) => `from:${domain}`).join(" ");
  const billingSubjects = [
    "invoice",
    "receipt",
    "payment",
    "subscription",
    "renewal",
    "charged",
    "billing",
    "funded",
  ]
    .map((term) => `subject:${term}`)
    .join(" ");
  return `after:${after} before:${before} {${senders}} {${billingSubjects}}`;
}

function senderDomain(from) {
  const match = String(from ?? "")
    .toLowerCase()
    .match(/@([a-z0-9.-]+)(?:>|\s|$)/);
  return match?.[1] ?? "";
}

function trustedSender(from, domains) {
  const sender = senderDomain(from);
  return domains.some((domain) => {
    if (sender === domain) return true;
    const boundary = sender.length - domain.length - 1;
    return boundary >= 0 && sender[boundary] === "." && sender.slice(boundary + 1) === domain;
  });
}

function bounded(value, max = 160) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function usdNumber(raw) {
  const amount = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000 ? amount : null;
}

/** Best-effort USD extraction; ambiguous multiple amounts stay unresolved. */
export function extractUsd(text) {
  const source = String(text ?? "").replace(/\s+/g, " ");
  const phrase =
    /\b(?:charged|paid|payment(?:\s+of)?|total(?:\s+due)?|amount(?:\s+paid)?|funded|renewal(?:\s+of)?)[^$]{0,45}(?:USD\s*|US\$\s*|\$\s*)(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)/i.exec(
      source
    );
  if (phrase) return usdNumber(phrase[1]);

  const matches = [
    ...source.matchAll(/(?:USD\s*|US\$\s*|\$\s*)(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)/gi),
    ...source.matchAll(/(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)\s*USD\b/gi),
  ]
    .map((match) => usdNumber(match[1]))
    .filter((amount) => amount != null);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

function classify(provider, text) {
  const lower = text.toLowerCase();
  if (provider.key === "codex" && /\b(api|credit balance|funded|usage credits?)\b/.test(lower)) {
    return { provider: "openai", label: LABELS.openai, kind: "metered" };
  }
  if (
    provider.key === "claude" &&
    /\b(api|console|usage credits?|prepaid credits?)\b/.test(lower)
  ) {
    return { provider: "anthropic", label: LABELS.anthropic, kind: "metered" };
  }
  if (provider.key === "cursor" && /\b(overage|usage-based|on-demand)\b/.test(lower)) {
    return { provider: provider.key, label: provider.label, kind: "metered" };
  }
  return { provider: provider.key, label: provider.label, kind: provider.kind };
}

function candidateFromMessage({ account, provider, result, detail }) {
  const headers = detail?.headers ?? {};
  const message = detail?.message ?? {};
  const from = headers.from || result.from;
  if (!trustedSender(from, provider.domains)) return null;

  const subject = bounded(headers.subject || result.subject);
  const snippet = bounded(message.snippet, 500);
  const classified = classify(provider, `${subject} ${snippet}`);
  const amount = extractUsd(`${subject} ${snippet}`);
  const rawDate = headers.date || result.date || message.internalDate;
  const parsedDate = new Date(
    /^\d+$/.test(String(rawDate)) ? Number(rawDate) : String(rawDate).replace(" ", "T")
  );
  const date = Number.isNaN(parsedDate.getTime())
    ? bounded(result.date, 10)
    : parsedDate.toISOString().slice(0, 10);

  return {
    id: `${account}:${message.id || result.id}`,
    message_id: String(message.id || result.id),
    account,
    provider: classified.provider,
    label: classified.label,
    kind: classified.kind,
    amount_usd: amount,
    date,
    subject,
    confidence: amount == null ? "medium" : "high",
    reason:
      amount == null
        ? "verified provider sender; enter the invoice total"
        : "verified provider sender and one USD amount",
  };
}

/** Return Gmail-capable accounts already configured in gog. */
export async function listGogGmailAccounts(runGog = defaultRunGog) {
  const raw = await runGog(["auth", "list", "--json", "--results-only", "--no-input"]);
  const rows = parseJson(raw, "gog auth list");
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row) =>
        typeof row?.email === "string" &&
        (row.services?.includes("gmail") || row.scopes?.some((scope) => scope.includes("gmail")))
    )
    .map((row) => row.email)
    .slice(0, MAX_ACCOUNTS);
}

/**
 * Scan a period across configured Gmail accounts. Provider-level failures are
 * warnings so one missing grant or malformed message never hides other bills.
 */
export async function scanInvoiceEmails({ period, accounts, runGog = defaultRunGog }) {
  monthBounds(period); // validate before invoking an external command
  const configured = await listGogGmailAccounts(runGog);
  const requested = accounts == null ? configured : accounts;
  if (!Array.isArray(requested) || requested.some((account) => typeof account !== "string")) {
    throw new Error("accounts must be an array of configured email addresses");
  }
  const selected = [...new Set(requested)].slice(0, MAX_ACCOUNTS);
  const unknown = selected.filter((account) => !configured.includes(account));
  if (unknown.length) throw new Error("one or more requested Gmail accounts are not configured");

  const warnings = [];
  const hits = [];
  const searches = selected.flatMap((account) =>
    INVOICE_PROVIDERS.map(async (provider) => {
      try {
        const stdout = await runGog([
          "gmail",
          "messages",
          "search",
          searchQuery(provider, period),
          "--account",
          account,
          "--max",
          String(MAX_RESULTS_PER_PROVIDER),
          "--json",
          "--results-only",
          "--no-input",
        ]);
        const results = parseJson(stdout, `${provider.label} Gmail search`);
        if (!Array.isArray(results)) return;
        for (const result of results.slice(0, MAX_RESULTS_PER_PROVIDER)) {
          if (result?.id) hits.push({ account, provider, result });
        }
      } catch {
        warnings.push(`${provider.label}: Gmail search failed for ${account}`);
      }
    })
  );
  await Promise.all(searches);

  const uniqueHits = [
    ...new Map(hits.map((hit) => [`${hit.account}:${hit.result.id}`, hit])).values(),
  ].slice(0, MAX_CANDIDATES);
  const candidates = [];
  await Promise.all(
    uniqueHits.map(async (hit) => {
      try {
        const stdout = await runGog([
          "gmail",
          "get",
          String(hit.result.id),
          "--account",
          hit.account,
          "--format=metadata",
          "--headers=From,Subject,Date",
          "--json",
          "--results-only",
          "--no-input",
        ]);
        const detail = parseJson(stdout, `${hit.provider.label} message metadata`);
        const candidate = candidateFromMessage({ ...hit, detail });
        if (candidate) candidates.push(candidate);
      } catch {
        warnings.push(`${hit.provider.label}: couldn’t inspect one invoice candidate`);
      }
    })
  );

  candidates.sort((a, b) => b.date.localeCompare(a.date) || a.label.localeCompare(b.label));
  return { ok: true, period, accounts: configured, candidates, warnings };
}
