---
description: Process a bank statement through the workspace bookkeeping ledger.
---

Process a bank statement through the workspace bookkeeping ledger.

**Arguments:** $ARGUMENTS (optional CSV path under `bookkeeping/statements/` or date range)

## Prerequisites

- `bookkeeping/` exists and `.claude/rules/bookkeeping.md` applies.
- Run validation after posting: `validation/check-ledger.sh` (or workspace copy).

## Steps

1. Read `.claude/rules/bookkeeping.md` and account watermarks in `bookkeeping/accounts/`.
2. Import new transactions; deduplicate by statement ID.
3. Categorize per the rules table — flag unknown merchants for review.
4. Append to monthly ledgers; update AR/AP if present.
5. **Gate:** run the ledger validator until exit 0 before advancing watermarks.
6. Report flagged items first, then summary counts.

Never declare success before the validator passes.
