# Mongo Memory + Pi Agent Memory System Design Spec (Option B → C)

## Decision
We will implement **Option B (Structured Multi-Layer Memory)** first, then evolve incrementally into **Option C (Memory OS)**.

---

## 1) Objective
Create a context/memory system that makes multi-session work feel like an effectively unlimited context window by:
- Preserving continuity across sessions
- Injecting only high-value context per turn
- Reducing context bloat and token waste
- Improving long-horizon reasoning, consistency, and project continuity

---

## 2) Findings from `mongodb-mcp-memory`
Repo analyzed: `/Users/keith/mongodb-mcp-memory`

### What is already strong
- Good MCP tool surface (memory CRUD, graph traversal, recommendations, conversation storage/search)
- Strong schema foundation (UMC + lifecycle + relationships + conversation exchange model)
- Hybrid search stack exists (vector + text + graph + co-access pattern enrichment)
- Relationship and recommendation systems are present
- Lifecycle/retention services are implemented
- Security model and auth handling are extensive

### Key practical gaps for “unlimited context” quality
1. **Write-path quality risk**: some store paths use placeholder embeddings (all-zero vectors), reducing semantic retrieval quality
2. **Security filtering inconsistency**: some flows simplify to owner-only to avoid operator issues; shared/public logic is partially bypassed
3. **Conversation memory underused**: conversational tools exist but are not yet fully orchestrated as default recall+write pipeline
4. **Consolidation loop not fully operationalized end-to-end**: services exist, but runtime wiring for periodic memory hygiene is not clearly first-class
5. **Tool abstraction for LLM ergonomics**: current MCP tool names are low-level; needs task-oriented wrappers for robust agent behavior

---

## 3) External Research Synthesis (2024–2026)
High-confidence pattern across systems and benchmarks:
- Long context alone is insufficient
- Naive RAG alone is insufficient
- Best systems are **multi-layer memory + active memory management**

Influential directions:
- MemGPT/Letta-style hierarchical memory (core vs archival)
- Mem0-style practical memory layer and cost-efficient retrieval
- A-MEM/Agentic Memory style dynamic memory operations (add/update/delete/summarize/retrieve)
- LightMem-style sleep-time consolidation and compression
- MIRIX-style modular memory managers

Benchmarks indicating memory complexity beyond simple retrieval:
- LoCoMo
- LongMemEval
- MemoryAgentBench
- MemoryArena / AMA-Bench (long-horizon, inter-session behavior)

---

## 4) Target Architecture (Option B baseline)

## 4.1 Memory layers
### Layer A: Working Context (ephemeral, per turn/session)
- Active instruction/state for current turn
- Not persisted as raw transcript by default

### Layer B: Episodic Memory (conversation-turn memory)
- Persist structured conversation exchanges with project/session/turn metadata
- Purpose: recover recent narrative and decision chronology

### Layer C: Semantic Memory (facts/knowledge)
- Durable factual memory entries (preferences, architecture decisions, constraints, environment facts)
- Includes confidence and provenance metadata

### Layer D: Procedural Memory (how-to/patterns)
- Reusable workflows, runbooks, conventions, fix patterns

### Layer E: Relationship Graph
- Links among memories (supports, contradicts, references, updates)
- Enables graph traversal for multi-hop recall

## 4.2 Context packet composer (critical)
For each turn, compose a bounded “memory packet”:
- Recency slice (episodic)
- Relevance slice (semantic/procedural via search)
- Decision/constraint slice (high importance, project-level)
- Conflict warnings (if contradictory memories exist)

Output target: strict token budget by tier (see section 7).

---

## 5) Canonical write policy
Only write memory when one of these is true:
1. Durable user preference
2. Project convention or architectural decision
3. Reusable procedure/pattern
4. Persistent environment fact
5. Outcome of unresolved/important issue

Do not write:
- Secrets or tokens
- Verbose raw logs unless needed for episodic traceability
- Redundant restatements

Write flow:
1. Candidate extraction from turn end
2. Normalize into `memory candidates`
3. De-duplicate against recent/near-duplicate memories
4. Classify (domain + memoryType)
5. Persist + link to related items

---

## 6) Retrieval/ranking policy

## 6.1 Retrieval fan-out
- Primary semantic search (query embedding)
- Secondary lexical/text search
- Graph expansion from top seeds (depth 1–2)
- Optional recommendation augmentation

## 6.2 Score function (v1)
`final_score = 0.45*semantic + 0.20*text + 0.15*graph + 0.10*recency + 0.10*importance`

Then:
- Deduplicate near-similar entries
- Penalize stale or superseded items
- Promote decision/procedural items when task is implementation-heavy

## 6.3 Conflict handling
If memories conflict:
- Return both with contradiction marker
- Add “needs resolution” note
- Prefer newer item only when confidence/provenance thresholds are met

---

## 7) Context budget strategy (token discipline)
Default per-turn injected packet budget (adjustable by model window):
- 35%: task-relevant semantic/procedural memory
- 25%: recent episodic continuity (project/session)
- 20%: active plan and current branch state
- 10%: constraints/guardrails
- 10%: contingency (errors/conflicts)

Hard rules:
- Never inject full conversation history
- Always summarize before injecting if above slice cap
- Prefer pointers/IDs over full payload where possible

---

## 8) Pi integration design

## 8.1 Wrapper tools (LLM-friendly)
Build high-level tools on top of `mongo_memory_call`:
- `memory_recall(query, scope?, limit?)`
- `memory_store(facts[], decisions[], procedures[])`
- `memory_recent(projectPath?, limit?)`
- `memory_update(memoryId, patch)`
- `memory_stats()`

## 8.2 Runtime hooks
- `before_agent_start`: auto-recall and context packet injection
- `turn_end`/`agent_end`: candidate extraction and controlled writes
- Session start/resume: load project continuity memory profile

## 8.3 Modes
- `off`: no automatic memory ops
- `assist`: recall auto, write manual/low-frequency
- `auto`: recall + controlled write + consolidation enqueue
- `strict`: max filtering, no low-confidence writes

---

## 9) Consolidation pipeline (Option C evolution)
Background jobs:
1. Dedup cluster merge (semantic near-duplicates)
2. Promote/demote lifecycle stages
3. Summarize stale episodic chunks into compact semantic items
4. Decay/archival of weak low-value memories
5. Relationship integrity checks and contradiction detection

Sleep-time consolidation objective:
- Reduce memory noise
- Improve retrieval precision
- Lower token footprint over time

---

## 10) Security and trust controls
- Never persist secrets by default
- Store provenance (`source`, `sessionId`, `turn`, `timestamp`)
- Keep confidence per extracted item
- Enforce owner/project scoping on all recalls
- Log why a memory was injected (traceability)

---

## 11) Evaluation plan

## 11.1 Functional metrics
- Recall@k on known memory tasks
- Precision of injected context (manual rubric)
- Conflict detection accuracy
- Duplicate memory rate

## 11.2 Efficiency metrics
- Tokens injected per turn
- Retrieval latency p50/p95
- Memory store growth vs useful recall ratio

## 11.3 Outcome metrics
- Continuation quality across fresh sessions
- Rework reduction on resumed projects
- Task success on long-horizon coding workflows

---

## 12) Incremental implementation phases

### Phase 0: Instrumentation + wrappers
- Add wrapper tools and structured result payloads
- Add retrieval trace metadata (`why selected`)

### Phase 1: Auto-recall context packet
- Implement `before_agent_start` packet composer
- Enforce token budget and ranking policy

### Phase 2: Controlled write-back
- Turn-end candidate extraction
- Dedupe + classify + persist

### Phase 3: Conversation continuity bridge
- Integrate `storeConversationExchange` and `searchConversations`
- Add project/session continuity recalls

### Phase 4: Consolidation jobs
- Dedupe merge, summarization, lifecycle hygiene

### Phase 5: Conflict engine + trust scoring
- Contradiction tagging and confidence-aware preference

### Phase 6: Benchmark harness
- Long-horizon eval suite modeled on LoCoMo/LongMemEval concepts

---

## 13) Immediate implementation priority
1. Build wrapper tools + packet composer (Phase 0–1)
2. Add strict write policy with dedupe (Phase 2)
3. Add continuity bridge using conversation tools (Phase 3)

This sequence gives the fastest practical jump toward “unlimited-context behavior” with manageable complexity.
