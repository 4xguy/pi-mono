import { describe, expect, it } from "vitest";
import {
	canNestAgent,
	DEFAULT_GUARDRAIL_DEFAULTS,
	initializeExecutionBudget,
	makeFingerprint,
	normalizeTask,
	parseContextMode,
	reserveChildBudget,
	SUBAGENT_ENV_CAN_SPAWN_CHILDREN,
	SUBAGENT_ENV_DEADLINE_AT,
	SUBAGENT_ENV_DEPTH,
	SUBAGENT_ENV_FINGERPRINTS,
	SUBAGENT_ENV_MAX_DEPTH,
	SUBAGENT_ENV_REMAINING_TOKENS,
	SUBAGENT_ENV_ROOT_STARTED_AT,
	SUBAGENT_ENV_RUN_ID,
} from "../examples/extensions/subagent/guardrails.js";

describe("subagent guardrails", () => {
	it("normalizeTask compacts whitespace and lowercases", () => {
		expect(normalizeTask("  Hello   WORLD\n  test  ")).toBe("hello world test");
	});

	it("makeFingerprint combines normalized agent and task", () => {
		expect(makeFingerprint(" Worker ", "  Build   Plan ")).toBe("worker::build plan");
	});

	it("parseContextMode falls back on invalid values", () => {
		expect(parseContextMode("shared-write", "shared-read")).toBe("shared-write");
		expect(parseContextMode("invalid", "shared-read")).toBe("shared-read");
	});

	it("initializeExecutionBudget uses defaults for missing env vars", () => {
		const env: NodeJS.ProcessEnv = {};
		const nowMs = 1_000_000;
		const budget = initializeExecutionBudget(env, nowMs);

		expect(typeof budget.runId).toBe("string");
		expect(budget.runId.length).toBeGreaterThan(0);
		expect(budget.depth).toBe(0);
		expect(budget.maxDepth).toBe(DEFAULT_GUARDRAIL_DEFAULTS.maxDepth);
		expect(budget.rootStartedAtMs).toBe(nowMs);
		expect(budget.deadlineAtMs).toBe(nowMs + DEFAULT_GUARDRAIL_DEFAULTS.maxWallTimeMs);
		expect(budget.remainingTokens).toBe(DEFAULT_GUARDRAIL_DEFAULTS.maxTotalAgents);
		expect(budget.canSpawnChildren).toBe(true);
		expect(budget.fingerprints.size).toBe(0);
	});

	it("initializeExecutionBudget respects provided env vars", () => {
		const env: NodeJS.ProcessEnv = {
			[SUBAGENT_ENV_RUN_ID]: "run-123",
			[SUBAGENT_ENV_DEPTH]: "1",
			[SUBAGENT_ENV_MAX_DEPTH]: "5",
			[SUBAGENT_ENV_ROOT_STARTED_AT]: "100",
			[SUBAGENT_ENV_DEADLINE_AT]: "900",
			[SUBAGENT_ENV_REMAINING_TOKENS]: "7",
			[SUBAGENT_ENV_FINGERPRINTS]: JSON.stringify(["a::b"]),
			[SUBAGENT_ENV_CAN_SPAWN_CHILDREN]: "0",
		};
		const budget = initializeExecutionBudget(env, 5000);

		expect(budget.runId).toBe("run-123");
		expect(budget.depth).toBe(1);
		expect(budget.maxDepth).toBe(5);
		expect(budget.rootStartedAtMs).toBe(100);
		expect(budget.deadlineAtMs).toBe(900);
		expect(budget.remainingTokens).toBe(7);
		expect(budget.canSpawnChildren).toBe(false);
		expect(budget.fingerprints.has("a::b")).toBe(true);
	});

	it("reserveChildBudget decrements tokens and tracks fingerprint", () => {
		const budget = initializeExecutionBudget({}, 1000, {
			maxDepth: 2,
			maxTotalAgents: 4,
			maxWallTimeMs: 60_000,
		});

		const childBudget = reserveChildBudget(budget, "worker", "analyze api", 2, true);

		expect(childBudget.nextDepth).toBe(1);
		expect(childBudget.remainingTokens).toBe(2);
		expect(childBudget.canSpawnChildren).toBe(true);
		expect(childBudget.fingerprints).toContain("worker::analyze api");
		expect(budget.remainingTokens).toBe(1);
		expect(budget.fingerprints.has("worker::analyze api")).toBe(true);
	});

	it("reserveChildBudget throws on duplicate fingerprint loop", () => {
		const budget = initializeExecutionBudget({}, 1000, {
			maxDepth: 2,
			maxTotalAgents: 4,
			maxWallTimeMs: 60_000,
		});
		reserveChildBudget(budget, "worker", "repeat task", 0, true);

		expect(() => reserveChildBudget(budget, "worker", "  repeat   task ", 0, true)).toThrow("Blocked recursive loop");
	});

	it("reserveChildBudget throws when token budget is insufficient", () => {
		const budget = initializeExecutionBudget({}, 1000, {
			maxDepth: 2,
			maxTotalAgents: 1,
			maxWallTimeMs: 60_000,
		});

		expect(() => reserveChildBudget(budget, "worker", "needs two", 1, true)).toThrow("Subagent budget exceeded");
	});

	it("canNestAgent requires explicit subagent tool declaration", () => {
		expect(
			canNestAgent({
				name: "coordinator",
				description: "Coordinator",
				systemPrompt: "prompt",
				source: "project",
				filePath: "coordinator.md",
				tools: ["subagent", "read"],
			}),
		).toBe(true);

		expect(
			canNestAgent({
				name: "worker",
				description: "Worker",
				systemPrompt: "prompt",
				source: "project",
				filePath: "worker.md",
				tools: ["read", "grep"],
			}),
		).toBe(false);
	});
});
