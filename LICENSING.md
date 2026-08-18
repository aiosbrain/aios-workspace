# Licensing

AIOS Workspace is open source. The workspace itself is under the **GNU Affero General
Public License v3.0 only** (`AGPL-3.0-only`); the two directories meant to end up inside
other people's repositories — `packages/integration-sdk/` and `.harness/` — are under the
**Apache License 2.0**.

Both are OSI-approved, and both are listed by the FSF as free software licenses.

Copyright (C) 2026 Chetan Nandakumar and John Ellison.

---

## What is under which license

| Path | License | Why |
| --- | --- | --- |
| `src/`, `scripts/`, `bin/`, `packages/foundation/`, `evals/`, `test/`, and everything else not listed below | `AGPL-3.0-only` | The workspace application and its library. |
| `packages/integration-sdk/` | `Apache-2.0` | The normative integration contracts — JSON schemas, capability and compatibility declarations, invariants, fixtures. A contract an integration author writes against has to be freely implementable by anyone, including in closed-source software. |
| `.harness/` | `Apache-2.0` | A vendored copy of [`aios-engineering-harness`](https://github.com/aiosbrain/aios-engineering-harness), which is Apache-2.0 upstream, and which `aios repo-bootstrap` stamps into **target repositories** as their own `.harness`. See below. |

**Why `.harness/` is Apache-2.0 and not AGPL.** `aios repo-bootstrap` copies that
directory into a consuming repository as that repo's own harness. If it were copyleft,
bootstrapping a workspace would attach the AGPL to the repository being bootstrapped — which
would make the harness unadoptable and is the exact opposite of what a drop-in harness is
for. Keeping it aligned with its upstream license also keeps the two copies syncable in both
directions, rather than making every sync a licensing question.

This directory was initially held back from the relicense: its LICENSE named **Pravos LLC
(Vibrana / AIOS)**, a legal entity rather than the individual authors, and relicensing code
an entity holds is that entity's decision rather than an assumption to make. The copyright
holders have since authorised it. The prior MIT notice is preserved verbatim in
`.harness/LICENSE-MIT`, naming Pravos LLC, as the MIT License requires. This does not weaken anything: MIT is
permissive, it composes into an AGPL work without friction, and it satisfies the
dependency-direction rule below for the same reason Apache-2.0 would.

Prior releases were published under the MIT License. **They remain MIT** — the change is
going-forward only and takes nothing away. That text is preserved verbatim in
[`LICENSE-MIT`](LICENSE-MIT), including the original copyright notice, as the MIT License
requires.

---

## What this means for you

**Running the workspace is unrestricted.** The AGPL places no obligation on internal use,
however many people use it, however much you modify it. A workspace is plain files in a git
repository you already own.

**Bootstrapping your repo with the harness does not license your repo.** `.harness/` is
Apache-2.0, which guarantees exactly that.

**Writing an integration against the contracts does not license your integration.**
`packages/integration-sdk/` is Apache-2.0 for the same reason.

**If your company's policy bans AGPL**, there is a free-of-charge commercial license for
internal use. See [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md). An AGPL ban should never
be the reason someone can't try AIOS.

Longer answers: [`docs/LICENSING-FAQ.md`](docs/LICENSING-FAQ.md).

---

## The dependency-direction rule

Two licenses in one organization means one rule, and it only runs one way:

> **An Apache-2.0 package must never import from an AGPL-3.0 package.**
> Apache → AGPL is fine. AGPL → Apache is a license violation.

The reason is that the AGPL is contagious across a combined program and Apache-2.0 is not.
An AGPL module pulled into an Apache-2.0 package makes that package's Apache grant
undeliverable — we would be promising permissions on code we cannot grant them for. The
reverse is harmless: AGPL code may absorb Apache-2.0 code, and the result is AGPL.

The same rule holds across repositories in the `aiosbrain` organization. An Apache-2.0
repo may not depend on an AGPL-3.0 one.

In practice, for this repository:

- `packages/integration-sdk/` and `.harness/`, both Apache-2.0, **must not** import from
  `src/`, `scripts/`, `bin/`, or `packages/foundation/`. Neither does today: the integration
  SDK is JSON data with nothing to import from, and the harness is shell and markdown that
  shells out to user-installed CLIs.
- The traffic runs the permitted way round: `scripts/integration-contracts*.mjs` (AGPL)
  **reads** the Apache-2.0 contracts. AGPL absorbing Apache-2.0 is fine.
- `packages/foundation` is AGPL, so **anything depending on it must also be AGPL.** That is
  why [`aios-devtools`](https://github.com/aiosbrain/aios-devtools) is AGPL-3.0-only rather
  than permissive: it takes a direct dependency on `@aiosbrain/foundation`. If we ever want
  that package permissive, `packages/foundation` has to be carved out to Apache-2.0 first.

---

## Third-party components

[`NOTICE`](NOTICE) records the components carrying an attribution obligation.

---

## Contributing

Contributions are accepted under `AGPL-3.0-only`, or `Apache-2.0` for
`packages/integration-sdk/` and `.harness/`. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
