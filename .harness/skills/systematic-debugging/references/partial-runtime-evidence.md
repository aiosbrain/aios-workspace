# Partial runtime evidence — when you cannot run the real operation

The debugging invariant is "runtime state is the only source of truth." But sometimes the only state
you can produce is a *partial* observation — the real call needs paid credits, a device you don't
have, a production secret, a customer dataset, or network access you lack. **Partial runtime evidence
is still runtime evidence.** This page tells you which partial signals to harvest and how to combine
them so the conclusion is defensible. Ported from oh-my-opencode `debugging`.

Use it when all three hold: (1) the question needs runtime confirmation; (2) the obvious "just run
it" path failed for reasons unrelated to the bug (401/402/403, device-not-found, prod-only creds,
network isolation, quota); (3) mocking the whole system would defeat the point — you need evidence
about how the *real* code behaves. If you can mock cleanly and that still answers the question, just mock.

## The hierarchy of partial evidence (strongest first)

- **Tier 1 — pre-send / post-receive logs.** If the code logs the assembled request *before*
  transmitting (`Building request: …`, `payload: {…}`), that's strong evidence for request
  *content* — though not for wire-level bytes, and only for what that logger actually emitted.
  Turn up debug logging (`APP_DEBUG=1 APP_LOG_LEVEL=debug …`) and read it — but treat those logs
  as sensitive: they can capture Authorization headers, API keys, cookies, and customer data.
  Redact before sharing or storing them, keep them out of commits, and don't enable broad debug
  logging in shared/production environments.
- **Tier 2 — local interception (proxy/shim).** Run the real binary against `mitmproxy`
  (`HTTPS_PROXY=… SSL_CERT_FILE=…`) or an `LD_PRELOAD`/`DYLD_INSERT_LIBRARIES` shim that logs the
  payload and returns a canned response. Wire-level ground truth, if the target honors the proxy.
- **Tier 3 — static extraction × runtime fingerprint cross-check.** Can't send at all? Cross-check
  static reading against what the binary *does* do offline: the request it builds (Tier 1), a state
  file it writes, its User-Agent / `--version` build metadata. Two disjoint signals that agree
  substantially raise confidence — but still fall short of a direct observation; say so.
- **Tier 4 — contrastive runtime under different inputs.** If input A runs (free tier) but B doesn't
  (paid), run A, capture its logs, and verify B shares A's request-building path with only the
  model/endpoint differing.
- **Tier 5 — vendor dashboard / audit log.** If it succeeded earlier, the vendor's log may show
  status codes / token counts (rarely payload bodies). Real but summarized.
- **Tier 6 — pure code reading + skeptical peer review.** Weakest. Read carefully and hand it to one
  fresh-context skeptical reviewer (the `code-review` skill; reviewer ≠ author). Mark conclusions "unverified."

## Combining signals

Prefer **two independent signals from different tiers**. Exception: a complete Tier 2 wire-level
capture stands alone for *request-shape* claims (the bytes are exactly what the remote received) —
but for *behavioural* claims (what the system does next, what it stores) still add a second signal.

| Evidence | Defensibility |
|---|---|
| Tier 1 + Tier 1 (same source) | weak |
| Tier 1 + Tier 2, or Tier 1 + Tier 3 | **strong** — independent / disjoint |
| Tier 2 alone | strong for request-shape only |
| Tier 3 + Tier 4 | medium |
| Tier 6 alone | **insufficient** — escalate or mark unverified |

Record the question, each signal (tier + source), an independence assessment, and the conclusion in
your debug journal. If you can't reach a full Tier 2 capture or two independent non-Tier-6 signals,
write an explicit ⚠️ partial-evidence note in the deliverable naming what's missing and what a future
verification should attempt.

## Anti-patterns

| Anti-pattern | Why it fails | Replace with |
|---|---|---|
| "Looks right in the code, so it works" | Tier 6 alone | add a Tier 1–3 signal |
| "Ran once, didn't error, so it's correct" | absence of error ≠ correctness | capture and verify the actual output |
| "The mock returns what I wrote, so it's fine" | tautology — loops your assumption back | Tier 2 proxy, or Tier 3 cross-check |
| "The dashboard shows it worked" | often only a status code | combine with Tier 1 |

Clean up when done: kill the proxy by the PID you captured when starting it
(`mitmproxy … & PROXY_PID=$!` → `kill "$PROXY_PID"` — never `pkill -f`, which can hit unrelated
processes), remove debug logs and shim libs, and
`unset` any `HTTPS_PROXY`/`APP_DEBUG`/… you exported so nothing persists into later runs.
