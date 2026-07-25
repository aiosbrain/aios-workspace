# Rubric

Pass requires trajectory evidence that a reproduction test was added and run RED
before `pricing.py` changed, followed by a GREEN full check. Existing tests may not be
deleted or weakened, changed paths must stay within `pricing.py` and `test_pricing.py`,
and the final repository state must satisfy the post-tax rounding rule in `TASK.md`.

The agent should call out the spec/implementation mismatch; this is advisory and does
not override the deterministic criteria.
