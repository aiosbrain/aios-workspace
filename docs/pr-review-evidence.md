# The per-PR review-evidence gate

**Status:** blocking. **Protected context:** `review-evidence` (a commit status, not a job name).
**Task:** AIO-777.

## The failure this exists for

Two pull requests merged while their adversarial review was still running. Both reviews came
back BLOCKED with High findings, which were then live on `main` and had to be fixed forward.

- **#533** merged at its reviewed head while the review of that head was still being acted on.
- **#546** merged six minutes after a fix push, mid-review. That review returned two High
  findings, both reproduced by execution. #546 existed *because* #533 did this, and its own
  description criticised it — then the same thing happened to it.

The shared cause is not "nobody reviewed it". It is **evidence outliving the commit it
described**. So the unit of evidence here is not "a review happened" — it is "a review names
*this* 40-character head SHA". A push produces a new SHA with no status, the gate goes red, and
the PR is unmergeable until the new head is re-attested. The staleness *is* the mechanism.

## What the gate checks

A PR passes when **one** of these is true:

1. A comment (issue comment or PR review body) on the PR:
   - was posted by a user with **write access** to this repo, and
   - parses as a valid attestation (below), and
   - names the **current head SHA** in its `## Verification` section — exactly once, with no
     other 40-hex token in that section.
2. The PR carries the **`review-evidence-exempt`** label, and that label is attributable to a
   `labeled` timeline event.

Everything else is a failure, including every case where the gate cannot tell.

### The attestation format

```
## Findings
- <what you looked for and what you found; "no reportable findings" is a legitimate line>
## Mergeability
- Ready to merge
## Open Questions
- none
## Verification
- Reviewed at <the 40-char head SHA>

MERGE_READY
```

Enforced, and worth knowing before you write one:

- The four `##` sections must be present exactly once, in that order, and none may be empty.
- The body must end with a bare `MERGE_READY` line.
- `## Mergeability` must be exactly `- Ready to merge`.
- **No `Critical` or `High` anywhere** in the governed text. A `Medium` is allowed only as
  `- [RESOLVED] Medium …` and only if the line does not also say it is still open.
- `## Verification` must contain the head SHA and nothing else that looks like a SHA.
- Severity words are read *after* HTML-entity decoding, zero-width stripping, NFKC
  normalisation and emphasis stripping, so `Crit&#8203;ical` and `Crit*ical*` still block.
- Fenced code and whole-line HTML comments are treated as invisible; raw HTML, link reference
  definitions, and ambiguous fences are **rejected**, because the validator must never see an
  approval that a human reading the comment cannot.

This is an *attestation*, not the review itself. Post the full review however you like — the
gate needs one comment in this shape. The gate cannot verify that the attestation is true; it
can only guarantee that somebody with write access signed their name against **this exact
commit**, after that commit existed. (Nobody can name a SHA before it is created, so the SHA
binding gives the ordering for free.)

## The three decisions

### 1. Block, not warn

**Blocking from day one.** A warning would not have prevented either incident: both merges
happened with the relevant information already visible and simply not acted on. A gate whose
output is another line of log is a gate that has already failed in exactly the way that
produced #533 and #546. The escape hatches below exist so that blocking does not mean stuck.

### 2. Exemptions: one label, no path filters

**`review-evidence-exempt`.** A Dependabot bump or a typo fix should not need an adversarial
review, but an exemption that is easy and invisible turns the gate into theatre. So:

- It is a **label**, which appears in the PR timeline with the actor and the timestamp. Anyone
  auditing later can see exactly who exempted what and when.
- GitHub already restricts labelling to users with write access, so the label carries its own
  authorisation — no separate permission check, no separate secret.
- The gate **refuses an exemption it cannot attribute** to a `labeled` event. An anonymous
  exemption is a hole, not an exemption.
- **A push clears it.** On `synchronize`, the workflow removes the label and reports red. That
  keeps exactly one invariant across both paths — nothing survives a new commit — and closes
  the obvious abuse (label a docs typo, then push real code into it). The removal is itself a
  timeline event, so the reset is auditable too.

Deliberately **not** implemented: path filters (`docs/**`, `*.md`), author allowlists, and
auto-exempting bots. All three are invisible at review time and drift silently — a PR that is
90% docs and 10% auth code is exactly the PR a path filter waves through.

### 3. Override authority

There is **no bypass inside the gate**. Two documented routes out, in order of preference:

1. **The label**, by anyone with write access. Cheap, visible, self-attributing. This is the
   routine answer for trivial PRs.
2. **Repo admin override** at merge time ("merge without waiting for requirements"). GitHub
   records this on the PR timeline and in the organisation audit log, so it is attributable
   without any work on our side. Reserve it for gate outages — a GitHub API incident, an
   expired dependency — not for "the review is taking a while".

Anything that would let the gate be turned off quietly (a magic commit-message token, a
skip-CI string, an env var) is out of scope on purpose.

## Why the validator is vendored

The body-validation logic already existed, tested, in the hub repo `johnellison/aios` at
`scripts/validate-adversarial-review.mjs` — but wired only into the release gate. This gate
reuses it by **copying it into this repo** (`scripts/review-evidence.mjs`), keeping the copied
region a line-for-line copy and recording the source commit in the file header.

The alternatives and why they lost:

| Route | Why not |
| --- | --- |
| Check the hub out in the workflow at a pinned SHA | Puts a cross-repo dependency inside a **required** check. When the pin rots — history rewrite, repo rename or transfer, a rotated cross-repo token, the hub going private — *every* PR in this repo becomes unmergeable at once, and the only way to land the fix is the admin override this gate is meant to make rare. A required check must not be able to be broken by a repo it does not control. |
| Publish it as a package | The cleanest end state, but it makes the required check depend on a registry fetch and a release cycle, and there is no published home for it today. |
| Reimplement the minimum | Throws away the parts that were learned the hard way — the `BENIGN_SEVERITY_COMPOUNDS` allowlist exists because suppressing severity words on mere hyphen adjacency was a fail-open. A second, weaker implementation is worse than a duplicated strong one. |

**The trade-off accepted:** duplication, which drifts. **What breaks it:** somebody changes the
severity or visibility logic in the hub copy and does not port it here, so the release gate and
the PR gate disagree about what a clean review looks like.

**Mitigations, and the exit:**

- `npm run check:review-evidence-parity -- --hub <path-to-hub-checkout>` runs a shared corpus
  through both implementations and fails on any behavioural disagreement. It is a local /
  on-demand check, not a CI job, because the hub is not available to this repo's CI — which is
  the same fact that ruled out the cross-repo checkout.
- The file header names the exact source commit, so "has it drifted?" is a `git log` away.
- **Convergence:** the shared surface belongs in `@aiosbrain/foundation` (this repo's existing
  shared-module seam, already published). The follow-up is to move it there and have the hub
  consume it, at which point this copy is deleted. Until then this is one duplicate, recorded,
  not an unbounded fan-out.

## Operating it

**Activation.** The workflow is inert as a *gate* until an admin adds `review-evidence` to the
required status checks on `main`. Until then it still runs and still shows red or green on the
PR; it just does not block. Adding the context is the one step this PR cannot do for itself.

**Triggers.** `pull_request` (opened, synchronize, reopened, ready_for_review, labeled,
unlabeled), `pull_request_review`, and `issue_comment`. The last one is why the verdict is a
commit status: `issue_comment` runs are attributed to the default branch, so their check runs
never land on the PR, but a status posted against `head.sha` does.

**Locally**, against a real PR, without posting anything:

```bash
GH_TOKEN=$(gh auth token) node scripts/validate-pr-review-evidence.mjs \
  --repo aiosbrain/aios-workspace --pr <n> --no-status
```

## Known limits — stated, not hidden

- **The gate checks that a review was signed, not that it was good.** It cannot tell a careful
  adversarial pass from a rubber stamp. What it makes impossible is the specific accident that
  caused both incidents: merging on evidence that describes an older commit.
- **Fork PRs cannot pass.** `GITHUB_TOKEN` is read-only for fork pull requests, so no status
  can be posted and the required context stays pending. That is fail-closed, and correct for
  now, but a maintainer has to intervene on any external contribution.
- **The PR that introduces the gate judges itself.** The workflow checks the validator out from
  the base branch precisely so a PR cannot edit its own judge; while the gate is not yet on
  `main` there is nothing to check out, so it falls back to the PR's copy and prints a loud
  warning. After this lands, that fallback cannot fire again.
- **The workflow file itself** is read from the PR head under the `pull_request` trigger. A PR
  that edits `.github/workflows/pr-review-evidence.yml` is therefore judged partly by its own
  version — visible in the diff, but not mechanically prevented. Moving to `pull_request_target`
  closes this and is only possible once the workflow exists on `main`.
- **Two runs for the same head can finish out of order**, and the later status write wins. Runs
  are serialised per PR and never cancelled (cancelling would let a `synchronize` run die before
  it cleared a stale exemption), but they are not ordered. Any subsequent event re-evaluates,
  and the likely direction of the race is a stale *red*, not a stale green.
