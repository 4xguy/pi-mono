# Proposal: Goldilocks Master Coordinator System for pi-mono

Date: 2026-02-27
Status: Draft for review

## 1) Objective

Create a master-coordinator workflow that is:
- **Effective**: reliably ships correct changes with strong validation
- **Efficient**: avoids unnecessary agent fan-out and token burn
- **Controllable**: clear human approval points and transparent run state
- **Simple**: minimal moving parts, extension-first, no premature complexity

---

## 2) What your vision got right

Your vision is directionally correct on all core points:
- coordinator-led request understanding and planning
- phased decomposition
- adaptive use of agents and coordinators
- explicit user approval before implementation
- per-phase smoke testing and final end-to-end validation
- final "green app" handoff criteria

---

## 3) What was missing / should be tightened

### A. Explicit orchestration policy (decision rules)
Without policy, "always coordinate" becomes ambiguous and drifts into over-orchestration.

Add a deterministic decision function using inputs:
- complexity score (files/packages touched, uncertainty)
- risk score (auth/data migration/security/public API changes)
- coupling score (cross-package dependencies)
- confidence score (freshness of docs/tests/context)
- budget constraints (time/token/wall clock)

### B. Clear stop conditions and bounded loops
Any reflection/review loop must have hard limits:
- max review passes (usually 1–2)
- max retries per phase
- max wall time per phase

### C. Formal phase gates
Each phase should have an explicit gate contract:
- required checks
- pass/fail criterion
- rollback/remediation path

### D. Operational metrics
Need at least lightweight telemetry per run:
- duration
- token estimate
- task success rate
- rework/retry count
- test pass/fail breakdown

### E. Failure-mode playbook
Define behavior for:
- flaky tests
- dependency/type drift
- ambiguous requirements
- tool/model failure
- partial success across parallel branches

---

## 4) What is outdated in "always multi-agent" thinking

Current evidence suggests this update:
- **Not every task benefits from multi-agent orchestration**.
- For simple/sequential work, single-agent execution is often cheaper/faster and sometimes more reliable.
- Multi-agent should be reserved for high-complexity or naturally parallelizable work.

So the modern pattern is:
- **Always-on coordinator policy layer**
- **Adaptive worker topology** (single, parallel, hierarchical) based on scores

---

## 5) Recommended target architecture (Goldilocks)

## Layer 0: Master Coordinator (always present)
Responsibilities:
1. Understand request and constraints.
2. Build plan + phased task graph.
3. Choose execution topology.
4. Request user approval at gates.
5. Aggregate verification evidence and report final status.

No direct heavy implementation unless policy says "single-path low-risk".

## Layer 1: Execution Topology Selector
Policy output options:
- **Mode S (single worker)**: low complexity/risk
- **Mode P (parallel workers)**: independent subtasks
- **Mode H (hierarchical)**: cross-package/high-risk decomposition with sub-coordinators

Simple starting thresholds (tune later):
- Mode S: complexity <= 3 and risk <= 2
- Mode P: complexity 4–6 and low coupling
- Mode H: complexity >= 7 or high coupling/risk

## Layer 2: Phase Engine (mandatory)
Suggested phases:
1. **Discovery** (facts + constraints)
2. **Design/Plan** (phased plan + topology + test strategy)
3. **Implementation** (phase-by-phase execution)
4. **Stabilization** (fixes from phase checks)
5. **Final Validation** (repo-wide required checks + e2e)
6. **Handoff** (what changed, evidence, known caveats)

## Layer 3: Verification Engine
Per-phase required:
- targeted smoke tests for that phase
- lint/type checks relevant to changed scope
- no unresolved errors

Final required:
- all required project checks (for this repo: `npm run check`)
- e2e/smoke run representative of requested behavior
- summarized evidence report

---

## 6) Approval model

Two mandatory human approvals:
1. **Plan Approval Gate**
   - scope, topology, risk notes, expected tests
2. **Release Approval Gate**
   - all checks green, change summary, residual risks

Optional third approval for high-risk migrations/security changes.

---

## 7) Where "Ralph loop" fits

Recommendation:
- Do **not** make "Ralph loop" a hard dependency.
- Use its spirit as a bounded iterative pattern inside phases:
  - plan -> act -> verify -> adjust (max N attempts)

Equivalent robust implementation already achievable with your current guardrails + review loops.

---

## 8) Minimal implementation plan (incremental)

### Milestone 1 — Policy + UX clarity
- Add explicit topology decision log in coordinator output:
  - why S/P/H chosen
  - expected cost/latency tradeoff
- Status line + inspector already exist; add phase gate state labels.

### Milestone 2 — Phase gate contracts
- Formalize per-phase checklists and pass/fail semantics.
- Require smoke command list per phase before phase start.

### Milestone 3 — Verification hardening
- Add retry policy for flaky tests.
- Add fix-loop cap (e.g., max 2 fix attempts per failing gate).

### Milestone 4 — Metrics and run artifacts
- Write per-run summary artifact in `.context/runs/<runId>.md`:
  - topology decisions
  - task outcomes
  - test evidence
  - token/time estimate

### Milestone 5 — Adaptive tuning
- Tune S/P/H thresholds based on observed outcomes.
- Add lightweight eval set from recent real requests.

---

## 9) Concrete workflow (end-to-end)

1. User request received.
2. Coordinator performs discovery + risk/complexity scoring.
3. Coordinator drafts phased plan and recommended topology.
4. **User Plan Approval Gate**.
5. Execute Phase 1 -> phase smoke tests -> gate.
6. Execute Phase 2 -> phase smoke tests -> gate.
7. Continue until implementation complete.
8. Final stabilization pass.
9. Run final full validation (`npm run check` + e2e/smoke).
10. **User Release Approval Gate**.
11. Final handoff summary.

---

## 10) Definition of Done (DoD)

A request is done only if all are true:
- accepted scope implemented
- all phase gates passed
- final validation passed (`npm run check` required in this repo)
- e2e/smoke evidence attached
- unresolved risks explicitly documented
- user accepts final result

---

## 11) Why this is Goldilocks

- Not underengineered: has policy, gates, validation, visibility.
- Not overengineered: keeps one coordinator brain and adds agents only when useful.
- Compatible with current pi extension model and your existing subagent guardrails.

---

## 12) Recommended immediate next step

If approved, implement **Milestone 1 + 2 only** first:
- topology decision log
- formal phase gate contracts
- no additional deep framework changes yet

This gives the biggest reliability gain with the smallest complexity increase.
