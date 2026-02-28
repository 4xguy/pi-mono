import { describe, expect, it } from "vitest";
import {
	buildExecutionPlan,
	buildTopologyDecision,
	parseTopologyPolicy,
} from "../examples/extensions/subagent/policy.js";

describe("subagent topology policy", () => {
	it("recommends single mode for simple requests", () => {
		const decision = buildTopologyDecision({
			requestedMode: "single",
			singleTask: "List top-level files",
		});

		expect(decision.recommendedMode).toBe("single");
		expect(decision.selectedMode).toBe("single");
	});

	it("recommends parallel mode for independent medium work", () => {
		const decision = buildTopologyDecision({
			requestedMode: "parallel",
			tasks: [{ task: "Find model resolver usage" }, { task: "Find keybinding defaults" }],
		});

		expect(decision.recommendedMode).toBe("parallel");
		expect(decision.estimatedAgentCount).toBe(2);
	});

	it("recommends chain mode for high-risk changes", () => {
		const decision = buildTopologyDecision({
			requestedMode: "single",
			singleTask: "Plan and apply database migration for auth schema in production",
		});

		expect(decision.recommendedMode).toBe("chain");
		expect(decision.riskScore).toBeGreaterThanOrEqual(7);
	});

	it("keeps requested topology in advisory mode", () => {
		const plan = buildExecutionPlan({
			requestedMode: "parallel",
			policy: "advisory",
			recommendedMode: "chain",
			tasks: [
				{ agent: "scout", task: "collect references" },
				{ agent: "planner", task: "draft approach" },
			],
		});

		expect(plan.mode).toBe("parallel");
		expect(plan.tasks).toHaveLength(2);
		expect(plan.notes[0]).toContain("advisory mode");
	});

	it("auto mode switches parallel to chain when policy recommends chain", () => {
		const plan = buildExecutionPlan({
			requestedMode: "parallel",
			policy: "auto",
			recommendedMode: "chain",
			tasks: [
				{ agent: "worker", task: "touch risky auth schema" },
				{ agent: "reviewer", task: "verify migration plan" },
			],
		});

		expect(plan.mode).toBe("chain");
		expect(plan.chain).toHaveLength(2);
		expect(plan.notes[0]).toContain("switched parallel -> chain");
	});

	it("auto mode does not switch chain to parallel when {previous} dependencies exist", () => {
		const plan = buildExecutionPlan({
			requestedMode: "chain",
			policy: "auto",
			recommendedMode: "parallel",
			chain: [
				{ agent: "scout", task: "Collect facts" },
				{ agent: "worker", task: "Implement using {previous}" },
			],
		});

		expect(plan.mode).toBe("chain");
		expect(plan.notes[0]).toContain("no safe topology conversion");
	});

	it("parses topology policy with fallback", () => {
		expect(parseTopologyPolicy(undefined, "auto")).toBe("auto");
		expect(parseTopologyPolicy("advisory", "auto")).toBe("advisory");
		expect(parseTopologyPolicy("unknown", "auto")).toBe("auto");
	});
});
