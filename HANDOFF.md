# Handoff: Mongo Memory + Pi Context System

## Session Goal
Prepare research + design plan for a robust memory/context architecture that minimizes context-window limitations across sessions.

## Decision Locked
Proceed with **Option B (Structured Multi-Layer Memory)** first, then evolve to **Option C (Memory OS)** incrementally.

## Main Design Document
- `.pi/research/mongo-memory-agent-memory-design-spec.md`

This includes:
- current-state findings from local `mongodb-mcp-memory`
- gaps to address
- target architecture
- write/retrieval/consolidation policies
- context budgeting
- pi integration model
- phased implementation roadmap

## Key Research Inputs Used
- Local repo deep-dive: `/Users/keith/mongodb-mcp-memory`
- Live MCP tool/schema inspection on `https://mem.icvida.com/mcp`
- External memory-system references: MemGPT/Letta, Mem0, A-MEM, LightMem, MIRIX, Agentic Memory/AgeMem
- Benchmarks: LoCoMo, LongMemEval, MemoryAgentBench, MemoryArena, AMA-Bench

## Important Current Repo State (`/Users/keith/AI/pi-mono`)
Untracked files currently present:
- `.pi/extensions/perplexity-search.ts`
- `.pi/extensions/exa-search.ts`
- `.pi/extensions/mcp-memory-http.ts`

## Next Session: Exact Plan
1. Read design spec:
   - `.pi/research/mongo-memory-agent-memory-design-spec.md`
2. Implement Phase 0:
   - Add LLM-friendly wrapper tools (recall/store/recent/update/stats) on top of `mongo_memory_call`
3. Implement Phase 1:
   - `before_agent_start` context packet composer with token budgets + score-based selection
4. Implement Phase 2:
   - `turn_end` controlled write-back (candidate extraction, dedupe, classify, persist)
5. Validate with manual scenarios:
   - fresh session continuation
   - project resume after context reset
   - contradiction handling behavior

## Notes for Fresh Session Prompt
Suggested opener in fresh session:

"Read `HANDOFF.md` and `.pi/research/mongo-memory-agent-memory-design-spec.md`. Start implementing Phase 0 and Phase 1 for the mongo-memory autopilot extension."