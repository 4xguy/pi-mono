# Research Notes: Master Coordinator + Multi-Agent Coding Workflow

Date: 2026-02-27
Project: `pi-mono`
Goal: Determine best-practice architecture for an always-available master coordinator that adaptively uses agents/sub-coordinators.

## 1) What current guidance says

### A. Start simple; escalate only when needed
- Multiple practitioner and platform guides converge on this pattern:
  - default to a strong single agent for most requests
  - add planner/reviewer/specialists only when task complexity/risk justifies overhead
- Why: multi-agent coordination overhead is real (latency, token usage, failure surfaces).

References:
- Anthropic — Building Effective AI Agents: https://www.anthropic.com/research/building-effective-agents
- Google Cloud Architecture — Choose design pattern for agentic AI system: https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system
- Azure Architecture — AI Agent Orchestration Patterns: https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns

### B. Use explicit harnesses and checkpoints for long-running work
- Long-running autonomy works better with harness-level controls:
  - bounded loops
  - clear stop/approval conditions
  - retries and fallback behavior
  - progress visibility and eval hooks

References:
- Anthropic Engineering — Effective harnesses for long-running agents: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic Engineering — Demystifying evals for AI agents: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

### C. Multi-agent is not universally superior
- Evidence indicates MAS (multi-agent systems) can help on harder/parallelizable tasks, but may underperform on simpler tasks.
- Reported tradeoff: significantly higher token/cost overhead in many setups.

References:
- "Do Multi-Agent Systems Really Add Value in LLM Workflows?" (arXiv 2505.18286): https://arxiv.org/pdf/2505.18286
- Google Research — Towards a science of scaling agent systems: https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/

### D. Evaluation quality matters as much as architecture
- Benchmark design and mutation robustness are active concerns.
- Practical implication: maintain project-specific eval harnesses and regression suites; do not rely only on generic benchmark claims.

References:
- OpenAI — Introducing SWE-bench Verified: https://openai.com/index/introducing-swe-bench-verified/
- Selected benchmark-analysis papers (recent):
  - https://arxiv.org/html/2510.08996v3
  - https://arxiv.org/html/2602.02262v1
  - https://arxiv.org/html/2507.02825v5

## 2) "Ralph loop" status

Observed in ecosystem content as an emerging iterative agent loop framing (plan/act/check/iterate), but currently less standardized than established patterns (ReAct/Reflexion + bounded execution harnesses).

References found:
- Ralph project/repo: https://github.com/snarktank/ralph
- Discussion article: https://www.alibabacloud.com/blog/from-react-to-ralph-loop-a-continuous-iteration-paradigm-for-ai-agents_602799

Takeaway:
- Treat "Ralph loop" as an optional implementation style, not a required architectural foundation.
- Prefer explicit bounded loops with measurable gates regardless of naming.

## 3) Implications for pi-mono

For this repo and current subagent extension maturity:
1. Keep extension-first orchestration (already aligned).
2. Add adaptive orchestration policy rather than always spawning.
3. Enforce stage gates (plan approval, phase smoke tests, final e2e checks).
4. Keep operator visibility (status line + inspector + reason codes for orchestration decisions).
5. Add evaluation telemetry per task/phase (success/fail, retries, token/cost, duration, regressions).

## 4) Practical anti-patterns to avoid

- Always-on parallelism for every request.
- Unlimited recursive delegation.
- "Loop until success" without max attempts/time budget.
- Testing only at the end (no per-phase smoke).
- No human approval on high-impact operations.
- Using benchmark headline numbers as a substitute for repo-specific regression signal.

## 5) Goldilocks direction (summary)

- Single coordinator always present conceptually.
- Worker orchestration is adaptive and policy-driven.
- Two approval gates by default:
  1) before implementation starts (plan/phase gate)
  2) before merge-like finalization after full validation
- Mandatory per-phase smoke validation + final e2e validation.
- Bounded reflection/review loops (1–2 passes max by policy).
