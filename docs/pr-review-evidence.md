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

## Threat model — what this does and does not defend against

> **This gate answers "has anything reviewed this exact commit?" — not "is that review
> honest?". Every actor with write access is trusted; the failure it prevents is a merge
> racing a review that is still running.**

That is a deliberate scope call by the repo owner, not an oversight. All the code here is
AI-generated, and the reviewer, the attester and the merger are **the same account by design**
— reviews are posted under the maintainer's account by an agent running the harness locally. A
gate demanding an independent human reviewer would break the workflow on day one and still
would not stop a determined forger. It defends against an agent merging too fast. Nothing more.

Neither incident involved anyone faking anything. Nobody checked.

### Accepted and documented — these satisfy the gate, on purpose

| It passes when… | Why that is accepted |
| --- | --- |
| **The PR author attests to their own PR** | This is how the workflow works. There is no author/attester comparison anywhere in the gate. |
| **The head SHA arrives via a commit URL, a quotation inside the Verification section, or a comment edited long after posting** | The binding is "this text names this SHA". GitHub exposes no "was this edited" signal the gate consults, and tightening the shape would reject legitimate reviews without stopping anyone who wanted to get around it. |
| **Anything with `statuses: write` posts the `review-evidence` status directly** | The status is the protected context, so the workflow is a *producer* of it, not a guard on it. Closing this would mean not using commit statuses, and statuses are what make the `issue_comment` trigger work at all. |
| **A write-authorised bot or machine user attests** | Same trust boundary as a human with write access. |

Each row is pinned by a test in `test/review-evidence.test.mjs` ("accepted under the stated
threat model") so the acceptance stays a recorded decision with an expected value, not a
paragraph that quietly stops being true. One neighbouring case is pinned as *not* accepted:
quoting an attestation wholesale does not attest, because a blockquote breaks the `## ` headings.

What the gate *does* guarantee is narrow and worth having: **no commit merges unless something
with write access put its name against that 40-character SHA, after the SHA existed.**

## What the gate checks

A PR passes when **one** of these is true:

1. A comment (issue comment or PR review body) on the PR:
   - was posted by a user with **write access** to this repo, and
   - parses as a valid attestation (below), and
   - names the **current head SHA** in its `## Verification` section — exactly once, with no
     other 40-hex token in that section.
2. A comment on the PR, again by a user with **write access**, declares the commit **exempt**
   and names the same current head SHA (`REVIEW_EXEMPT` instead of `MERGE_READY`).

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
- **The `- Reviewed at` wording is ergonomics, not a rule.** The binding is the SHA: the section
  must contain the head SHA exactly once and no other SHA-shaped token, and how you phrase the
  line around it is up to you — a bare SHA or a commit URL satisfies it just as well. This is
  intended. Requiring the phrase too would add a second, weaker rule that a reviewer could
  satisfy while naming the wrong commit, and would reject correct evidence over wording. The same
  applies to `- Exempt at` in an exemption.
- Severity words are read *after* HTML-entity decoding, zero-width stripping, NFKC
  normalisation and emphasis stripping, so `Crit&#8203;ical` and `Crit*ical*` still block.
- Fenced code and whole-line HTML comments are treated as invisible; raw HTML, link reference
  definitions, and ambiguous fences are **rejected**, because the validator must never see an
  approval that a human reading the comment cannot.

This is an *attestation*, not the review itself. Post the full review however you like — the
gate needs one comment in this shape. It cannot verify that the attestation is true (see the
threat model above); it guarantees only that somebody with write access signed their name
against **this exact commit**, after that commit existed. Nobody can name a SHA before it is
created, so the SHA binding gives the ordering for free.

## The three decisions

### 1. Block, not warn

**Blocking from day one.** A warning would not have prevented either incident: both merges
happened with the relevant information already visible and simply not acted on. A gate whose
output is another line of log is a gate that has already failed in exactly the way that
produced #533 and #546. The escape hatches below exist so that blocking does not mean stuck.

### 2. Exemptions: the same binding, a different token

A Dependabot bump or a typo fix should not need an adversarial review, but an exemption that is
easy and invisible turns the gate into theatre. An exemption is therefore a **comment** in a
minimal fixed shape, posted by someone with write access, naming the current head:

```
## Exemption
- dependabot lockfile bump, no source change
## Verification
- Exempt at <the 40-char head SHA>

REVIEW_EXEMPT
```

It is bound to the head exactly as review evidence is, validated by the same visibility rules
(no raw HTML, no link reference definitions, no ambiguous fences) and the same exact-SHA binding —
and, as above, the `- Exempt at` phrasing is ergonomics: the SHA is what binds.

**A reason is required, and the requirement is deliberately trivial: the section must not be
blank.** `String.trim()` on the raw text once a leading list marker (`-`, `*`, `+`, `1.`, `1)`) is
stripped, and nothing else — no normalisation, no entity decoding, no character classes.

**What that buys, stated plainly: the gate records that a reason was written. It does not verify
the reason is meaningful, or even that it renders to anything.** `&nbsp;` passes. So does `x`.
Both are equally uninformative, and neither is a security property. The security property is the
SHA binding; none of this touches it.

That is a retreat, and a deliberate one. Two earlier versions tried to compute whether the reason
*renders as something a reader can see*: first `trim()` alone, which let a bare `- ` through; then
a normalised letter-or-digit scan, which caught bare bullets but wrongly accepted Hangul fillers
(`U+3164`, `U+115F`), `&ensp;`/`&zwnj;`/`&lrm;`/`&Tab;`, an empty inline link and a transparent
image — and wrongly **rejected** `- 📝` and `- ✅!`. The second failure is the one that matters: a
sole emoji is a real reason for a docs-only exemption, and blocking it is how a gate teaches people
to route around it.

The space of "ways to be invisible in Markdown, HTML entities and Unicode" is unbounded and owned
by someone else; a rule enumerating it is always one round behind. Under the threat model the
requirement was never load-bearing anyway — every actor with write access is already trusted to
exempt, and anyone skipping the reason just types `x`. It is an audit-trail nicety, so it gets a
trivial check and an honest promise instead of a fourth attempt at deciding what renders.

Dropping the field entirely was considered. It is kept because a blank check still catches the one
realistic accident — posting the template without filling it in — at the cost of one line, and
because a section that is structurally required but may be empty is a stranger contract than one
that must simply have something in it.

This also removes a live coupling hazard: the previous version leaned on `normalizeForScan`, which
exists to normalise *severity-search source text*, decodes only a small named-entity allowlist and
does not model rendering at all. A future severity-driven edit to it could have silently changed
what counts as an exemption reason. Nothing in the exemption path depends on the vendored module
now.

Beyond "not blank" the gate has **no opinion on what a reason says** — no minimum length, no word
count, no format, no taxonomy.

A comment carrying both tokens is rejected.

**This started as a label, and the label was wrong — twice.** It is worth recording why, because
the second attempt looked correct:

1. *Label, cleared on push.* The workflow removed the label on `synchronize`. The answer depended
   on that deletion having happened, so one transient API failure left the stale label and its
   stale timeline event in place and the next head went green attributed to whoever labelled the
   PR before the push. Cleanup-on-failure is the wrong shape.
2. *Label, re-validated against the head commit's timestamp.* Deriving the answer from data was
   the right instinct, but the clock was wrong. **A commit's committer date is arbitrary** — it
   can be old, it can be in the future, and it never says *when this became the head*. A label
   applied at 10:00 could still exempt a head pushed at 12:00 carrying an older committer date.

A label cannot carry a SHA, so no amount of care makes a label-only exemption non-stale. Naming
the commit removes the question instead of answering it: an exemption either names the current
head or it does not. No clocks, no timeline ordering, no page-two event, no equal-timestamp edge,
no force-push confusion — and the gate collapses to one idea instead of two:

> **Something on this PR, posted by someone with write access, names this exact commit.**

**What the label gave up, and why that is acceptable.** A label was filterable
(`is:pr label:review-evidence-exempt`) and carried its own authorisation, since GitHub restricts
labelling to write access. The comment form keeps the authorisation (the author's write access is
checked the same way an attester's is) and keeps timeline visibility with actor and timestamp; it
loses the one-query PR-list filter. Searching for `REVIEW_EXEMPT` across the repo's PRs is the
replacement. That is a real, small cost, paid to delete an entire class of staleness bug — and
the label path is gone from the code, so the `labeled`-event ordering and the label-name predicate
cannot regress.

Deliberately **not** implemented: path filters (`docs/**`, `*.md`), author allowlists, and
auto-exempting bots. All three are invisible at review time and drift silently — a PR that is
90% docs and 10% auth code is exactly the PR a path filter waves through.

### 3. Override authority

There is **no bypass inside the gate**. Two documented routes out, in order of preference:

1. **The exemption comment**, by anyone with write access. Cheap, visible, self-attributing, and
   bound to the commit it exempts. This is the routine answer for trivial PRs.
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

**The parity harness is a spot check, not a mitigation.** `npm run check:review-evidence-parity
-- --hub <path-to-hub-checkout>` runs a 17-case corpus through both implementations and fails on
disagreement, and it is worth running — but do not call it drift protection:

- **CI never compares the two repos.** It only runs where somebody remembers to run it.
- **It needs a hub checkout** on the machine, which may simply not exist.
- **It cannot detect a defect the two copies share.** They agreed on exactly the severity
  behaviour that adversarial probes later defeated — agreement between two copies of the same
  mistake is not evidence of correctness.

It catches one copy being edited and the other not. That is all it catches.

**The real answer is the exit:** the shared surface belongs in `@aiosbrain/foundation` (this
repo's existing shared-module seam, already published). Move it there, have the hub consume it,
delete this copy. Until that lands, this is one recorded duplicate and the file header names the
exact source commit, so "has it drifted?" is a `git log` away.

## Operating it

**Activation.** The workflow is inert as a *gate* until an admin adds `review-evidence` to the
required status checks on `main`. Until then it still runs and still shows red or green on the
PR; it just does not block. Adding the context is the one step this PR cannot do for itself —
doing it before the gate is on `main` would leave every open PR pending forever, because a
required context that no workflow can produce never resolves.

The admin step, once this is merged (read the current rule first; the write replaces the whole
list of contexts, so it must be re-sent with `review-evidence` appended):

```bash
gh api repos/aiosbrain/aios-workspace/branches/main/protection/required_status_checks \
  --jq '{strict, contexts}'
gh api -X PATCH repos/aiosbrain/aios-workspace/branches/main/protection/required_status_checks \
  -f 'contexts[]=unit tests (npm test)' \
  -f 'contexts[]=lint + format' \
  -f 'contexts[]=leak-gate + secrets + harness checks' \
  -f 'contexts[]=review-evidence'
```

Removing it again is the same call without the last line — a deliberate, attributable act, which
is the point. There is no way to disable the gate from inside a pull request.

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

- **The gate checks that a review was signed, not that it was good**, and does not defend
  against forged evidence at all — see the threat model at the top, which lists exactly what
  passes on purpose. What it makes impossible is the specific accident that caused both
  incidents: merging on evidence that describes an older commit.
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
- **If GitHub refuses our status write, the last status stands.** The status *is* the protected
  context, so a run that decides red and then cannot publish it leaves whatever was published
  last in place — and if an earlier attestation went green on this same SHA, branch protection
  still sees green. We cannot publish red when publishing is what failed, so this is narrowed
  rather than closed: the write is retried four times with doubling backoff, and if it still
  fails the run emits a titled `::error::` annotation naming the SHA, the verdict it could not
  publish, and "do not merge on the strength of a green `review-evidence`", plus a matching block
  in the job summary. The run is red and loud; the context may not be. Re-run the workflow — and
  if it keeps failing, the branch rule is protecting a context nobody can currently write.
- **Two runs for the same head can finish out of order**, and the later status write wins. Runs
  are serialised per PR and never cancelled (cancelling would let a `synchronize` run die before
  it cleared a stale exemption), but they are not ordered. Any subsequent event re-evaluates,
  and the likely direction of the race is a stale *red*, not a stale green.
