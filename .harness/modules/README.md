# Optional modules

The core pack (contracts, skills, hooks, agents, rubrics, routing) is deliberately
**portable and dependency-free** — markdown + POSIX shell, no ecosystem lock-in.
Modules are the opt-in layer above that: heavier capabilities a team installs
deliberately, one at a time, when the rung they're on justifies it.

Rules for modules (and for contributing new ones):

1. **Core never depends on a module.** Removing every module leaves a fully working
   harness.
2. **A module states its coupling.** If it ties you to a service, CLI, or ecosystem,
   the README says so in the first paragraph.
3. **By reference, not by fork.** Where a capability lives in an upstream project
   (e.g. the AIOS CLI), the module documents the integration and pins a version — it
   does not vendor a copy that will drift.

| Module | What it adds | Coupling |
|---|---|---|
| [`aios-cli/`](aios-cli/) | Loop engineering (scheduled operator loops) + Team Brain connection (share tier-tagged work, query team context) + the gated ship pipeline | AIOS toolkit (`aiosbrain/aios-workspace`), optional Team Brain deployment |
| [`agentic-maturity/`](agentic-maturity/) | Self-assessment against the AM model → placement + a prescribed practice plan per engineer | None (standalone skill); richer signal-based scoring via `aios-cli` |
| [`cost-monitor/`](cost-monitor/) | Token/cost visibility per engineer and per lane; the data behind the routing table's cost claims | `ccusage` (local); team-level rollup via `aios-cli` |
| [`context-monitor/`](context-monitor/) | Context-hygiene audit: contract bloat, utilization discipline, skill misfires, MCP tool sprawl | None (standalone skill) |

Suggested adoption order: `agentic-maturity` first (it tells you which rung each
engineer is on — see [docs/autonomy-ladder.md](../docs/autonomy-ladder.md)), then
`cost-monitor` when lanes go live, `context-monitor` when sessions get long, and
`aios-cli` when the team wants loops and a shared brain rather than per-repo harnessing.
