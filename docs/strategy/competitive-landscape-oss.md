---
access: shared
owner: john
status: draft
created: 2026-06-05
type: competitive-landscape
domain: oss-product-strategy
sources: [github-mcp-search, websearch, three-agent-deep-research]
---

# Open-Source Landscape: The Three Pillars
**Date:** June 5, 2026
**Purpose:** Map the competitive landscape across the three open-source repositories Vibrana is considering building out of its enterprise transformation work — so we know what exists, where it's saturated, where the white space is, and what to fork vs. build. Doubles as credibility-building input for the AI Transformation studio.

The three pillars (matching the [productized-tools thesis](../../) — Company Graphs, AI Team Ops, Learning Journeys):

1. **Company Graph / Company Brain** — machine-readable org representation supplying *static* context into *dynamic* AI apps.
2. **Team Agentic Operating System** — one shared repo where multiple humans + agents collaborate with shared skills, harnessing, and tool integrations.
3. **AI-Native Enterprise Learning Platform** — personalized, department-specific curricula across an org.

---

## TL;DR — The Strategic Read

The three pillars are **not equally contested**, and that asymmetry is the whole story:

| Pillar | Commercial side | OSS side | Our move |
|--------|----------------|----------|----------|
| **Company Graph** | Crowded & funded (Glean $7.2B, Sana, Dust, Stardog) | Primitives crowded (GraphRAG, Graphiti, Mem0, Cognee); **the curated org-ontology niche is empty** | **Build the schema/governance layer; fork Graphiti for the engine** |
| **Team Agentic OS** | Coding side saturated ($26B Devin, $1.5B Factory); Anthropic Cowork is the looming threat | Coding orchestration saturated; **governed knowledge-work team-ops is empty** (only <600★ 2026 repos) | **Build the governance-first, multi-client team-ops repo; fork orchestration plumbing** |
| **Learning Platform** | Heavily saturated & funded (Multiverse $2.1B, Degreed $1.4B, Sana→Workday, Uplimit) | Split into *legacy LMS* and *consumer AI tutors* — **the enterprise AI-native intersection is empty** | **Fork DeepTutor as base; differentiate on org-context + multi-dept + governance. Watch, don't race.** |

**The connecting insight:** all three commercial leaders (Glean, Sana, Dust) bundle the static context layer *inside* a closed runtime. Nobody ships the **org context as a portable, version-controlled, access-aware standard** that feeds *both* an agent OS *and* a learning platform. That seam — the Company Graph as the shared substrate — is our most defensible, most ownable position, and it's the one we already have a working prototype of (this back-office's `entities/` + numbered spine + `kb_search max_tier`).

**One recurring moat across all three: governance.** Access tiers, leak prevention, NDA/legal chains, approval gates, PII audits, client-surface promotion, hub-and-spoke multi-client isolation. No OSS competitor in any of the three categories treats this as first-class. It is the hardest thing to copy and the thing a *consultancy* is uniquely credible shipping.

> **Data caveat:** GitHub star counts below are approximate and were partly gathered via an environment index that appears to mirror/fork some repos (a few inflated or mislabeled entries were caught and corrected). Treat OSS star counts as directional. Commercial funding figures are web-verified and more reliable; figures marked *unverified* (notably Disco) conflict across sources — do not cite without checking.

---

## Pillar 1 — Company Graph / Company Brain

**Scope:** structured, machine-readable org context (people, teams, roles, projects, processes, systems, relationships) feeding static org knowledge into dynamic agents/apps.

The field splits into (A) graph/RAG/memory **primitives**, (B) enterprise knowledge/search & agent **platforms**, and (C) graph-DB / KG-construction **infra**.

### Landscape

| Name | Type | Stars / Funding | Activity | What it does | Fit / Overlap |
|---|---|---|---|---|---|
| [microsoft/graphrag](https://github.com/microsoft/graphrag) | Company OSS (MIT) | ~33k★ | Active | Extracts entities/relationships + community summaries from docs into a graph for RAG | Auto-populates a graph *from text*; not an org ontology. Use to populate, not as schema |
| [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | Academic OSS (MIT) | ~36k★ | Very active | Lighter/faster GraphRAG alternative | Same primitive; leaner base for auto-population |
| [getzep/graphiti](https://github.com/getzep/graphiti) | Company OSS (Apache-2.0) | ~27k★ | Very active | **Temporal** KG for agents: bi-temporal edges, custom entity/edge types, entity resolution | **Closest fork candidate for the runtime engine.** Lacks curated org spec + access tiers |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | Commercial OSS (Apache-2.0) | ~18k★ / **$7.5M seed** | Very active | "Memory control plane": ECL pipeline from 38+ sources → graph+vector store; Agent SDK integrations | Strong mechanism overlap; generic memory, not org ontology. Watch if they verticalize |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | Commercial OSS (Apache-2.0) | ~58k★ / **$24M** | Very active | Universal memory layer, optional graph mode; AWS Agent SDK memory provider | Episodic/personal memory, not static org model. Big mindshare |
| [letta-ai/letta](https://github.com/letta-ai/letta) (ex-MemGPT) | Commercial OSS (Apache-2.0) | ~23k★ / Felicis seed | Very active | Stateful agents w/ self-editing memory blocks | Agent runtime + memory; adjacent |
| [Canner/WrenAI](https://github.com/Canner/WrenAI) | Commercial OSS | ~15k★ | Very active | "Open context layer": governed text-to-SQL semantic layer over 20+ sources | Interesting "governed context for agents" framing, but DB-centric not people/process |
| [onyx-dot-app/onyx](https://github.com/onyx-dot-app/onyx) (ex-Danswer) | Commercial OSS (YC) | ~30k★ | Very active | Self-hostable enterprise search + chat over connectors | Most credible OSS "Glean-lite"; search not structured graph |
| [run-llama/llama_index](https://github.com/run-llama/llama_index) | Commercial OSS (MIT) | ~50k★ | Very active | Data framework incl. `PropertyGraphIndex` / KG modules | Toolkit to build with; no org model |
| [neo4j-labs/llm-graph-builder](https://github.com/neo4j-labs/llm-graph-builder) | Company OSS (Apache-2.0) | ~5k★ | Very active | Neo4j LLM pipeline to build KGs from unstructured data | KG-construction infra |
| [FalkorDB/FalkorDB](https://github.com/FalkorDB/FalkorDB) | Commercial OSS (SSPL) | ~5k★ / VC | Very active | Fast graph DB positioned as "the KG for LLM/GraphRAG" | Storage primitive only |
| [neuml/txtai](https://github.com/neuml/txtai) | Community OSS (Apache-2.0) | ~13k★ | Very active | Embeddings DB + semantic graph + LLM workflows | Primitive; you supply structure |
| **Glean** | Commercial (closed) | **$7.2B val, $150M Series F; ~$200M ARR** | Active | Enterprise search + "**Enterprise Knowledge Graph**" of content/people/activity; agent platform | **The flagship commercial "company graph."** Our angle = the anti-Glean (portable, versioned, not a black box) |
| **Sana** | Commercial (closed) | **$130M total; $500M val; → acquired by Workday Sep 2025** | Active | Enterprise AI knowledge + learning platform | Bridges pillars 1 & 3; now a Workday-backed incumbent |
| **Dust** ([dust-tt/dust](https://github.com/dust-tt/dust)) | Source-available + commercial | **$60M+; $40M Series B (Sequoia)**; 3,000 orgs | Very active | "Multiplayer" enterprise agent OS over company data | Closest to "agentic OS"; product is the moat, not the repo |
| **Stardog** | Commercial (closed) | ~$30M raised | Active | Enterprise KG + semantic layer; pivoting to "agentic AI + KG" | Incumbent enterprise-KG vendor; heavy/IT-led |

### White space & saturation
- **Saturated — do not build:** GraphRAG-family (graph-from-text), "memory layer for agents" (Mem0/Cognee/Letta/Zep — a VC-funded knife fight), Glean-alternative search (Onyx/DocsGPT/Quivr), graph DBs.
- **Empty — the gap:** A **standardized, human-authored, version-controlled org ontology** (people/teams/roles/projects/processes/decisions/access tiers as git-tracked YAML/MD/JSON-LD). Every search for "organizational knowledge graph / company brain / org graph for agents" returned **zero notable repos.** The field auto-*extracts* graphs; nobody ships a curated, declarative org spec as the static substrate for agents. There is no "schema.org for companies/agents." None treat **per-node access tiers as a retrieval-time filter** (our `kb_search max_tier` is genuinely novel).

### Fork shortlist
1. **getzep/graphiti** — fork for the runtime engine; add the org ontology + access-tier layer it lacks.
2. **topoteretes/cognee** — study ingestion (ECL) + Agent SDK integration; primary verticalization-risk competitor to watch.
3. **microsoft/graphrag** / **LightRAG** — embed as the auto-population layer over raw intake (emails, transcripts), reconciled into the curated ontology.
4. **onyx** — reference architecture for the OSS-Glean positioning; sit *upstream* of it, don't compete on search.
5. **Glean + Sana** — study only; define our wedge as the open, declarative, governed, portable *spec/standard* layer they'll never open-source.

---

## Pillar 2 — Team Agentic Operating System

**Scope:** one shared repo where multiple humans + agents collaborate, with shared skills, orchestration/harnessing, shared rules, and third-party integrations (Jira, Confluence, Slack/Mattermost, Toggl, Google Workspace, GitHub) — for AI transformation and product-building.

### Landscape

| Name | Type | Stars / Funding | Activity | What it does | Fit / Overlap |
|---|---|---|---|---|---|
| **CrewAI** ([repo](https://github.com/crewAIInc/crewAI)) | Framework (company OSS, MIT) | ~53k★ / **$18M** | Very active | Orchestrate role-playing agents into "crews" | Library, not a shared repo. Dependency-tier |
| **AutoGen / Agent Framework** ([repo](https://github.com/microsoft/autogen)) | Framework (MS, MIT) | ~59k / ~11k★ | Very active | Conversational/agentic framework (Py + .NET); merging w/ Semantic Kernel | Library; no team-workspace concept |
| **LangGraph / LangChain** ([repo](https://github.com/langchain-ai/langgraph)) | Framework (commercial OSS) | ~34k★ / **$125M @ $1.25B** | Very active | Durable graph-based agent orchestration + LangSmith | For engineers building agent apps; adjacent infra |
| **MetaGPT** ([repo](https://github.com/FoundationAgents/MetaGPT)) | Framework (research OSS) | ~69k★ | Active | "AI software company" — agents as PM/architect/engineer | Simulates a team *inside one process*; code-gen, not multi-human repo |
| **ChatDev** ([repo](https://github.com/OpenBMB/ChatDev)) | Research OSS | ~33k★ | Active | LLM virtual software company | Virtual-team metaphor, code focus |
| **OpenAI Swarm → Agents SDK** ([repo](https://github.com/openai/openai-agents-python)) | Framework (MIT) | ~27k★ | Active | Handoff-based multi-agent orchestration | Library; no team layer |
| **OpenHands** (ex-OpenDevin) ([repo](https://github.com/OpenHands/OpenHands)) | Coding agent (company OSS) | ~76k★ / **$18.8M A** | Very active | Autonomous dev agent (writes/runs/tests code) | Solo-dev coding agent |
| **Aider** ([aider.chat](https://aider.chat)) | CLI coding agent (OSS) | ~40k★ | Very active | Git-native terminal pair programmer | Solo-dev, single-threaded |
| **Cline** ([repo](https://github.com/cline/cline)) | Coding agent (commercial OSS) | ~63k★ / 5M+ installs | Very active | Autonomous coding agent (IDE/CLI/SDK), parallel + CI mode | Solo→fleet, IDE-centric |
| **Goose (Block)** ([repo](https://github.com/block/goose)) | Coding agent (Big Tech OSS) | ~47k★ / → Linux Foundation AAIF | Very active | Local-first MCP-native agent | Could be an *engine* under a team-ops layer |
| **Devin / Cognition** ([cognition.ai](https://cognition.ai)) | Closed commercial | **$1B @ $26B; ~$492M ARR**; acquired Windsurf | Shipping fast | "AI software engineer," fleets of cloud Devins | Closed, code-focused. Scale reference |
| **Factory** ([factory.ai](https://factory.ai)) | Closed commercial | **$150M Series C @ $1.5B** | Shipping fast | "Droids" — parallel self-directed software agents | Closest commercial "agents-as-team," but dev-only, proprietary |
| **Dify** ([repo](https://github.com/langgenius/dify)) | App platform (commercial OSS) | ~144k★ | Very active | Low/no-code agentic workflow/app builder | Builder, not workspace |
| **Flowise** ([repo](https://github.com/FlowiseAI/Flowise)) | Visual builder (commercial OSS) | ~53k★ | Very active | Drag-drop agent/workflow builder | Builder, not workspace |
| **n8n / Activepieces** | Workflow automation (fair-code/OSS) + agent nodes | n8n ~100k★+ | Very active | Automation w/ AI-agent nodes + broad connectors | **Closest on integrations breadth**, but flow-canvas not git-repo + skills/rules + human-collab |
| **Anthropic Claude Code + Cowork / plugin marketplace** ([claude-plugins-official](https://github.com/anthropics/claude-plugins-official)) | Platform + closed product | n/a; enterprise marketplace Feb 2026 | Shipping fast | Skills/hooks/subagents/MCP; Cowork = dept-specific plugins (finance/legal/HR), private marketplaces, admin customize | **The platform we build ON *and* the biggest strategic threat.** Hosted/closed, plugin-shaped — not an open, forkable, git-native team-ops repo |
| **wshobson/agents** ([repo](https://github.com/wshobson/agents)) | Skills marketplace (OSS) | ~36k★ | Very active | Multi-harness plugin/agent marketplace | Shared skills library; consume it |
| **Composio agent-orchestrator** ([repo](https://github.com/ComposioHQ/agent-orchestrator)), **emdash** (YC W26) ([repo](https://github.com/generalaction/emdash)), orca, golutra | Parallel-agent orchestration (mixed OSS/VC) | ~7k / ~5k / low-k★ | Very active (2026) | Run fleets of coding agents in parallel (git worktrees, Jira/Linear hooks, UIs) | Orchestration UIs for *coding-agent fleets*; one human → many code agents |
| **zubair-trabzada** ai-sales-team / ai-marketing / ai-legal; **coreyhaines31/marketingskills** | Non-coding business skill packs (OSS) | ~1–2k / ~32k★ | Very active (2026) | Department "teams" (sales/marketing/legal) as Claude Code skills → client-ready PDFs | **Most directly adjacent to a consulting team-ops play** — but solo-operator, single-domain, no collaboration/governance |
| **"Agent OS for teams" micro-cluster:** [wecode-ai/Wegent](https://github.com/wecode-ai/Wegent), [multica-ai/multica](https://github.com/multica-ai/multica), + many | Team agentic OS (community OSS) | Wegent ~570★; rest single-digit→low-hundreds | New (2026) | Self-described "OS for human+agent teams": roles, shared task state, squads | **The white-space frontier — nascent & fragmented.** Dev/code-leaning, tiny, no governance/business integrations |

### White space & saturation
- **Saturated — avoid:** multi-agent frameworks (CrewAI/AutoGen/LangGraph/Swarm), solo-dev coding agents (Aider/Cline/Goose/OpenHands/Devin/Factory), parallel coding-agent runners (Composio/emdash/orca), app builders (Dify/Flowise/n8n).
- **Empty — the gap:** (1) genuine **multi-human + multi-agent in a shared repo** (only Wegent/Multica gesture at it, both tiny); (2) **non-coding / knowledge-work** team ops; (3) **governance as first-class** (access tiers, NDA/legal chains, approval gates, PII audit, client-surface promotion) — no OSS competitor has this; (4) **hub-and-spoke multi-client isolation** for a consultancy; (5) a **coherent real-business integration set** (Jira+Confluence+Mattermost+Toggl+Workspace+bookkeeping).
- **Looming threat:** Anthropic **Cowork** is moving toward exactly "department agents for knowledge-work teams." Hosted/closed/plugin-shaped → an **open, forkable, governance-heavy, git-native alternative is a defensible wedge, but the window is ~6–12 months.**

### Fork shortlist
1. **multica-ai/multica** — study the "agents as teammates" model (issue claiming, squads, compound skills); leave its governance + non-coding gap for us.
2. **wecode-ai/Wegent** — the only explicitly multi-human + multi-agent repo; study collaboration primitives.
3. **Composio agent-orchestrator + emdash** — fork the orchestration plumbing (git-worktree isolation, parallel spawn, CI/merge, Jira/Linear hooks) under our governance/human-collab layer.
4. **zubair-trabzada business packs + wshobson/agents** — study skill packaging/distribution; differentiate by bundling into a governed, multi-human, multi-client repo.
5. **Anthropic Cowork** — study as the incumbent to position against: forkable, you-own-the-data, governance-first, multi-client consulting ops vs. hosted closed per-seat plugins.

---

## Pillar 3 — AI-Native Enterprise Learning Platform

**Scope:** software generating personalized, department-specific, org-context-aware curricula with agentic tutoring. Not a MOOC; an AI-native corporate L&D engine.

### Landscape

| Name | Type | Stars / Funding | Activity | What it does | Fit / Overlap |
|---|---|---|---|---|---|
| **Sana Labs** ([sanalabs.com](https://sanalabs.com)) | Commercial (closed) | ~$137M; $500M val; **→ Workday Sep 2025** | Active | AI-first enterprise LMS + knowledge assistant; generative authoring, personalized paths | **Closest commercial analog**; now a heavyweight incumbent |
| **Uplimit** ([uplimit.com](https://uplimit.com)) | Commercial (closed) | **$11M Series A** (Salesforce/Greylock/Workday Ventures) | Active | AI agents for cohort mgmt, support, authoring at scale | **Direct overlap.** GE Healthcare, Kraft Heinz, Databricks |
| **Disco** ([disco.co](https://disco.co)) | Commercial (closed) | *Unverified* ($20M–$234M reported) | Active | "AI-native social learning"; course creation + community + AI agents | Direct overlap; content/community angle. Funding conflicts — verify |
| **Arist** ([arist.com](https://arist.com)) | Commercial (closed) | $23.6M total (YC, SAP.iO) | Active | AI microlearning via Slack/Teams/SMS/WhatsApp | Partial — delivery-channel focused. 20+ F500 |
| **Multiverse** ([multiverse.io](https://multiverse.io)) | Commercial (closed) | $70M; **$2.1B val**; acquired StackFuel | Active | Apprenticeship AI/data upskilling + human coaching + "Atlas" coach | Partial — heavy human-coaching model |
| **Section (Section AI)** ([sectionai.com](https://sectionai.com)) | Commercial (closed) | Undisclosed | Active | AI-first "business school"; functional courses | Adjacent — human-authored, content/cohort-led |
| **360Learning** ([360learning.com](https://360learning.com)) | Commercial (closed) | $240M total | Active | LMS+LXP; AI recommends by role/skill | Legacy LXP adding AI (recommendation, not generative) |
| **Docebo** ([docebo.com](https://docebo.com)) | Public (DCBO) | Public | Active | "AI-first" LMS; Creator generates content/plans | Legacy LMS bolting on GenAI |
| **Cornerstone** ([cornerstoneondemand.com](https://www.cornerstoneondemand.com)) | PE-owned | Acquired EdCast | Active | "Galaxy": learning+performance+skills engine | Legacy talent suite; skills engine ~ closest legacy org-context analog |
| **Degreed** ([degreed.com](https://degreed.com)) | Commercial (closed) | $367M; **$1.4B val** | Active | LXP / skills platform; content aggregation | Content marketplace + skills tracking; light on generative |
| **Workera** ([workera.ai](https://workera.ai)) | Commercial (closed) | ~$45M (Andrew Ng / AI Fund) | Active | AI skills assessment & verification | Adjacent — measurement layer, complementary |
| **Khanmigo (Khan Academy)** ([khanmigo.ai](https://khanmigo.ai)) | Consumer/edu (closed) | Nonprofit; MS/OpenAI | Active | AI Socratic tutor (K-12) | Consumer tutor, not enterprise. Core closed (Perseus renderer is OSS) |
| **[HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor)** | Academic OSS | ~24.5k★ | Very active | "Agent-native, open-sourced personalized tutoring"; multi-agent + RAG | **Most credible OSS AI-native tutor & best technical base.** Individual-learner framing; lacks enterprise/org-context |
| **[Mr.-Ranedeer-AI-Tutor](https://github.com/JushBJJ/Mr.-Ranedeer-AI-Tutor)** | Community OSS | ~29.6k★ | Active | A GPT-4 prompt for personalized tutoring | Just a prompt; no platform/org context |
| **[human-skill-tree](https://github.com/24kchengYe/human-skill-tree)** | Community OSS | ~551★ | Active | AI skill tree (30+ skills) + MCP server | OSS **skills-taxonomy/graph** primitive — composable building block |
| **[Skill-Anything](https://github.com/SYuan03/Skill-Anything)** | Community OSS | ~271★ | Active | Any source (PDF/video/web) → interactive courseware | OSS content-to-courseware generator primitive |
| **[frappe/lms](https://github.com/frappe/lms)** / **[Open edX](https://github.com/openedx/openedx-platform)** / **[Moodle](https://github.com/moodle/moodle)** / **ClassroomIO** | Legacy OSS LMS | 2.9k / 8.1k / 7.1k / 1.6k★ | Active | Open-source course-delivery platforms | Pre-AI paradigm; AI is bolt-on plugins. (EdCast was built on Open edX) |
| **"AI curriculum generator" repos** (Curriculum-Twin-AI, LearnPath-AI, learnmap, CourseMatrix…) | Community OSS | **0–1★ each** | Sporadic | Streamlit/React + Gemini/Groq → learning roadmap | **Confirms the white space** — the exact concept exists only as hobby toys |

### White space & saturation
- **Commercial side = crowded & richly funded:** Multiverse $2.1B, Degreed $1.4B, Sana→Workday, Docebo public, Cornerstone PE, Uplimit/Arist/Workera funded. Differentiation thinning (everyone claims "AI-first"). Competing commercially = fighting billion-dollar balance sheets and entrenched enterprise sales.
- **OSS side = genuinely thin (verified zero results for "OSS AI-native enterprise learning platform").** Two non-overlapping buckets: *legacy OSS LMS* (Moodle/Open edX/frappe — pre-AI) and *AI-native OSS tutors* (DeepTutor/Mr.-Ranedeer/etc. — consumer/academic, individual-learner). 
- **The unoccupied intersection:** open-source, AI-native, **org-context-aware, multi-department personalized corporate L&D**. Nobody sits there. For a consultancy whose IP is org-context modeling (Pillar 1), this is the natural extension — the Company Graph feeds department-specific personalization no consumer tutor can do.

### Shortlist (fork / watch)
1. **HKUDS/DeepTutor** — fork/study; best OSS agent-native + RAG foundation. Gap to fill: org-context ingestion, multi-dept curricula, governance.
2. **Sana (Workday)** — benchmark; the incumbent ceiling and threat via Workday install base.
3. **Uplimit** — watch; best proxy for "what good looks like" and buyer expectations in AI-native upskilling.
4. **human-skill-tree** — study/compose; OSS skills-graph + MCP server, exactly the layer dept-specific curricula need.
5. **Skill-Anything** — study/compose; content-transformation building block to wrap in org-context + governance.

---

## Cross-Cutting Positioning — Where Vibrana Fits

### The thesis the data supports
The three pillars are **one system, not three products.** The Company Graph is the static substrate; the Team Agentic OS and the Learning Platform are dynamic consumers of it. Every commercial leader bundles the substrate inside a closed runtime — so the **portable, governed, open context layer is the wedge nobody can easily counter**, and it's the one we already prototype internally.

### Our three durable differentiators (true across all pillars)
1. **Governance-first.** Access tiers, NDA/legal chains, approval gates, PII audit, client-surface promotion, hub-and-spoke multi-client isolation. **No OSS competitor in any pillar has this.** A consultancy is uniquely credible shipping it.
2. **Curated + declarative, not auto-extracted.** Everyone else extracts graphs from documents or bundles black-box runtimes. We ship a human-authored, version-controlled, git-native source of truth.
3. **Consulting/knowledge-work native, not code-native.** The entire high-traction agent ecosystem is for coders. The business-function demand is proven (32k★ marketing skill packs) but unserved by anything collaborative or governed.

### Build vs. fork — recommendation
| Pillar | Build (our IP) | Fork / compose | Don't build |
|--------|---------------|----------------|-------------|
| Company Graph | Org ontology schema + access-tier governance + static↔dynamic contract | Graphiti (engine), GraphRAG/LightRAG (auto-populate) | Graph DBs, memory layers, Glean-style search |
| Team Agentic OS | Governance + multi-client hub-and-spoke + business integrations + human-collab layer | Composio/emdash (orchestration), Multica/Wegent (teammate model), skill packs | Agent frameworks, coding agents, app builders |
| Learning Platform | Org-context-aware multi-dept curriculum gen + governance | DeepTutor (base), human-skill-tree / Skill-Anything (primitives) | Legacy LMS, consumer tutors |

### Sequencing read
- **Lead with the Company Graph** as the open standard/spec — smallest surface, emptiest niche, hardest to counter, and the substrate the other two depend on. Strongest credibility play for the studio.
- **Team Agentic OS second** — biggest looming-threat urgency (Anthropic Cowork, ~6–12 month window). Open-source the governance-first knowledge-work team-ops repo to plant the flag before the category commoditizes.
- **Learning Platform third / watch** — most saturated and capital-intensive commercially; only attractive *because* we'd uniquely feed it from the Company Graph. Fork DeepTutor when the first two are landing; don't race the funded incumbents head-on.

---

*Companion machine-readable graph: `2026-06-05-oss-three-pillars-graph.yaml` (repos → category → maturity → overlap → recommendation).*
