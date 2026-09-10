# Project membership access — Brain API 1.24

Document revision: 1.26. Reconciled 2026-09-10 with Brain's existing PRET-4/PRET-6
implementation. This document corrects the pinned description; it changes no runtime
permissions, deployment, endpoint shape or API version. The API change policy in
[brain-api.md](../brain-api.md) still governs future behavior changes.

## What a person can see

1. The authenticated key identifies an active member and team. A mismatched team header,
   revoked/invalid key or unresolved posture fails authentication. The access resolver
   admits active human/agent principals, not connectors.
2. The person's group memberships determine accessible projects through project grants.
   The built-in group rows are explicit authority; a stored `members.tier` value alone
   is not a grant. The usual built-ins grant General to `everyone`, and external-shared
   to `everyone` and `external`; custom groups can grant a particular initiative.
3. An item is membership-visible when an accessible project includes an active item
   context unit through a current `include` membership. Expired or excluded edges do
   not authorize it. A source project slug and an access label alone do not authorize it.
4. A delegated token can only narrow access: intersect launcher visibility, the represented
   person's visibility when different, and the explicit project scope. An empty scope
   means no projects. Only the items collection and natural-language query accept these
   tokens; the other member API routes reject their credential format. The current
   delegated-token implementation still reads the stored member tier for eligibility and
   refuses external stored-tier delegation. This is a retained exception: it does not
   resolve ordinary member posture from the `everyone` group.
5. People and organizational structure are intentionally shared with authenticated
   members of the team. The roster, identity resolver and company graph do not require
   team posture or project grants. They do not grant access to project content.

`GET /me.tier` and ordinary member-key handler `memberTier` retain the wire words `team`/`external`, but now
represent **posture**: membership in the built-in `everyone` group yields `team`, otherwise
`external`. Roster and identity payloads retain the stored tier as metadata. Role
(`admin`/`lead`/`member`), posture, project membership, and document `access` are distinct.
Delegated-token `memberTier` is the retained stored-tier result, not this posture resolver.
For example, an active agent with stored tier `team`, custom project grants and no
`everyone` membership can pass delegated eligibility even though its ordinary member
posture is external; the project intersection still prevents wider access. Conversely,
stored tier `external` blocks delegation even when ordinary member posture is team.

Workspace publication rules are unchanged: `admin`/`private` content never syncs, missing
access is denied, and aliases normalize to canonical `admin`, `team`, `external`. An
external collaborator granted a project can nevertheless read that project's team-labeled
content on the membership-only collection/retrieval paths. Placement in an accessible
project is the sharing act.

## Explicit endpoint rules

These are the implemented exceptions and additional conditions. Do not infer one endpoint's
permissions from another endpoint's status code.

| Surface | Implemented rule |
| --- | --- |
| `GET /items` | Membership-visible item set; no extra external-posture audience ceiling. Delegated scope may only narrow it. |
| `GET /items/<id>` | Membership **and** posture ceiling; external posture still cannot fetch a team item here. Missing/denied both404. |
| `POST /query` | Membership/provenance-grounded retrieval. Delegated scope may only narrow it. A project selector filters, never grants. Delegated queries are stateless; conversation IDs are422. Stored turns are not reused as grounding until visibility can be revalidated. |
| `POST /graph-query` | Accessible projects' stored partition pointers scope Graphiti. Legitimate empty scope returns empty facts; a visible system project with no partition fails500. |
| `GET /tasks`, `GET /decisions` | Sourced rows require a visible source item; source-less rows require a recorded author and team-posture member. External posture additionally requires external audience. Filters run before the row limit. |
| `GET /timeline` | Member-specific membership/provenance view and cache variant; team posture does not permit every stored item. The structured-row authored exception applies. |
| `GET /okf-bundle` | Membership and effective posture ceiling both apply to returned items and existing link targets. Dangling links remain; existing inaccessible targets are redacted. |
| `GET /projects` | Team posture required, plus row visibility from a grant or visible content. System access containers are omitted from the registrable-project feed. |
| `GET /members`, `GET /identities/resolve`, `GET /company-graph` | All authenticated members in the team may read people/identity/structure information; no tier403 or project filter. |
| `GET /me` | Own authenticated identity and derived posture. |
| `GET /conversations`, `GET /conversations/<id>` | Own team/member conversations; not a shared transcript inventory. |
| `GET /integrations` | Authenticated team's enabled integration selections. This does not confer execution permission for their tools. |
| `GET`, `POST`, `DELETE /me/slack-token` | Authenticated member's own stored token; no cross-member secret read. |
| `POST /items` | Existing publishing/admission rules remain: reject admin content, enforce external-pusher restrictions, and require lead/admin role for blueprint publication. Project-read grants do not authorize arbitrary writes. |
| `GET /pm-sync/health`; `POST /codebases`, `/metrics`, `/costs`, `/subscriptions`, `/work-events` | Team posture still required. These are separate operational/write surfaces. |
| `GET /attribution`, `POST /members/invite` | Team posture **and** admin role required. |
| `POST /actions` | Policy engine decides using the authenticated actor and posture, with policy role `member`; group access does not bypass action policy. |

For structured rows, source-less plus no recorded author is denied. The member authored-row
exception is team-scoped, not a claim that every row with a project slug is grant-filtered.
Delegated retrieval has a separate project-scoped authored-row arm and must not inherit
the member-wide exception. Existing endpoint schemas, rate limits and error envelopes
remain specified in the main contract.

## Examples for review

| Person and grant | Expected result |
| --- | --- |
| External collaborator granted Project A containing an included team-labeled item | The items collection/query may return that item; Project B without a grant remains inaccessible. |
| Same collaborator uses item-by-ID or OKF bundle for that team item | Retained posture exception denies/omits it even though the collection can serve it. |
| Member has team posture but no access to a restricted project's content | Team posture alone does not make that content visible. |
| Active external collaborator requests roster, identity resolution or company graph | May see team people/structure, including the roster's documented identity metadata. |
| Agent token names an inaccessible project or impersonates a person with broader access | The intersection cannot add access beyond the launcher. |

## Workspace client compatibility

The current `aios stakeholders` client retains its own team-posture precheck, including
meeting mode. It therefore refuses external callers before reaching the now all-member
company graph. This release documents that narrower client behavior; it does not silently
remove the precheck or claim feature parity for external collaborators. Skill/deliverable
pulls use the collection's path-prefix query, not item-by-ID. Task/decision writebacks must
continue treating missing/denied rows as absence, never permission to overwrite unrelated
local content. A404 fallback for older servers is not evidence that access was granted.

## Verification sources

Brain implementations: `lib/access/oracle.ts`, `lib/access/enforce.ts`,
`lib/access/posture.ts`, `lib/access/provenance-sql.ts`, `lib/access/structured-windows.ts`,
`lib/api/auth.ts`, and the corresponding `app/api/v1/**/route.ts` handlers. Governance:
`docs/design/retire-permissive-model.md`, `docs/design/pret4-tier-wall-teardown.md`,
`docs/design/pret6-retirement.md`, and `docs/ARCHITECTURE.md` in the Brain repository.

Behavioral verification uses the existing real-Postgres suites for posture cutover,
enforcing wall removal, access isolation, agent tokens, graph-query partitions,
in-query provenance and timeline enforcement. The release evidence records their exact
candidate refs and outcomes. Fixture equality alone covers shared vocabulary/wire fixtures,
not these permissions. No deployed service or final Chetan sign-off is implied.
