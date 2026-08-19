---
name: check-claim
description: Verify that a fix or change actually did what it was for, before reporting that it works. Use before any "it works", "verified", "fixed", "confirmed", or "done" about something that was previously broken — and whenever a hook or a reviewer asks you to re-check a claim. Catches the failure where you measure a proxy (a neighbouring count, an absence of errors, a ratio) instead of the property the change exists to produce.
---

# check-claim

Four questions. Answer them in order, in your head or out loud. If any answer is missing, you do not
yet have a verified claim — you have a hope.

## 1. What is this change FOR? One sentence.

Name the property in the world that should now be true and was not before.

Not "the PR is merged". Not "CI is green". The *property*: "Pulse's tasks tile shows a non-zero
count", "a fresh database produces a working demo", "chat threads appear in the timeline".

**If you cannot state it in one sentence, stop.** You do not know what you are verifying, and any
measurement you pick will be a coincidence.

## 2. What is the cheapest DIRECT measurement of that property?

Direct means: it reads the thing itself.

| Property | Direct | Proxy that will fool you |
|---|---|---|
| Pulse tiles populate | `select count(*) from tasks` | count of `items` |
| Extraction is running | episodes gaining `episode_uuid` | entity-table row count |
| The provider key works | an actual query returning an answer | the key round-trips through encryption |
| Retrieval finds the record | the citation list contains it | the query returned HTTP 200 |

If the direct measurement is expensive and you use a proxy anyway, **say so in the report** — "I
checked X, which implies Y but does not prove it."

## 3. Did I record the BEFORE value?

If you did not measure it before the change, you cannot claim it moved. Record it first, in the same
command where practical, so the comparison is in one place and cannot drift.

This is the one people skip. "Up from zero" is a claim about the past, and if you never looked at
the past you are inventing it.

## 4. If the change had SILENTLY failed, would my measurement look different?

The single most useful question. Apply it literally.

- Measuring "no new errors" right after moving where errors are recorded? **No** — silence is
  structural. Wrong measurement.
- Measuring `extracted/total` right after deleting rows? **No** — the ratio improves either way.
  Wrong measurement.
- Measuring item counts to prove task rows materialize? **No** — items load whether or not rows do.
  Wrong measurement.

If the answer is "no", go back to question 2.

---

## Reporting

State what you measured, not just the verdict:

> Verified: `tasks` = 9, `decisions` = 3 on the deployed database, matching local. Measured before
> (0/0) and after.

And when you could not verify something, say which part:

> Answering verified with a live query (20s, correct citations). The graph is *not* verified —
> episodes are queued but none confirmed.

## When a hook warns you

The `claim-check-guard` Stop hook (shipped with this workspace) flags claim language. It is a reminder, not an accusation, and it
cannot tell whether you measured the right thing — only you can. Re-run question 4. If your
measurement holds, say so and move on; the warning costs one sentence.

## When NOT to use this

Routine narration, plans, or restating something already verified in this session. This is for the
moment you assert that something broken is now working.
