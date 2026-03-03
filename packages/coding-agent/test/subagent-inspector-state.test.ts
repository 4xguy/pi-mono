import { describe, expect, it } from "vitest";
import {
	type CoordinatorInspectorState,
	normalizeCoordinatorInspectorState,
	reduceCoordinatorInspectorState,
} from "../examples/extensions/subagent/coordinator-inspector-state.js";
import type { CoordinatorRunState } from "../examples/extensions/subagent/coordinator-monitor.js";

function makeRuns(): CoordinatorRunState[] {
	return [
		{
			id: 1,
			runId: "r1",
			mode: "chain",
			phase: "running",
			agentsTotal: 2,
			parallelRunning: 0,
			parallelMax: 0,
			startedAtMs: 1,
			agents: [
				{ agent: "scout", task: "scan", status: "done", step: 1 },
				{ agent: "worker", task: "build", status: "running", step: 2 },
			],
		},
		{
			id: 2,
			runId: "r2",
			mode: "parallel",
			phase: "running",
			agentsTotal: 3,
			parallelRunning: 2,
			parallelMax: 3,
			startedAtMs: 2,
			agents: [
				{ agent: "planner", task: "plan", status: "running" },
				{ agent: "reviewer", task: "review", status: "pending" },
				{ agent: "worker", task: "implement", status: "pending" },
			],
		},
	];
}

describe("subagent inspector state", () => {
	it("normalizes out-of-range selections", () => {
		const initial: CoordinatorInspectorState = {
			selectedCoordinator: 9,
			selectedAgent: 9,
			showAgentDetails: true,
		};
		const state = normalizeCoordinatorInspectorState(initial, makeRuns());
		expect(state.selectedCoordinator).toBe(1);
		expect(state.selectedAgent).toBe(2);
		expect(state.showAgentDetails).toBe(true);
	});

	it("moves between coordinators and resets agent selection", () => {
		const runs = makeRuns();
		let state: CoordinatorInspectorState = {
			selectedCoordinator: 0,
			selectedAgent: 1,
			showAgentDetails: true,
		};

		state = reduceCoordinatorInspectorState(state, runs, "right");
		expect(state.selectedCoordinator).toBe(1);
		expect(state.selectedAgent).toBe(0);
		expect(state.showAgentDetails).toBe(false);

		state = reduceCoordinatorInspectorState(state, runs, "left");
		expect(state.selectedCoordinator).toBe(0);
		expect(state.selectedAgent).toBe(0);
	});

	it("moves agent selection within coordinator bounds", () => {
		const runs = makeRuns();
		let state: CoordinatorInspectorState = {
			selectedCoordinator: 1,
			selectedAgent: 0,
			showAgentDetails: false,
		};

		state = reduceCoordinatorInspectorState(state, runs, "down");
		state = reduceCoordinatorInspectorState(state, runs, "down");
		state = reduceCoordinatorInspectorState(state, runs, "down");
		expect(state.selectedAgent).toBe(2);

		state = reduceCoordinatorInspectorState(state, runs, "up");
		state = reduceCoordinatorInspectorState(state, runs, "up");
		state = reduceCoordinatorInspectorState(state, runs, "up");
		expect(state.selectedAgent).toBe(0);
	});

	it("toggles details visibility", () => {
		const runs = makeRuns();
		let state: CoordinatorInspectorState = {
			selectedCoordinator: 0,
			selectedAgent: 0,
			showAgentDetails: false,
		};

		state = reduceCoordinatorInspectorState(state, runs, "toggleDetails");
		expect(state.showAgentDetails).toBe(true);
		state = reduceCoordinatorInspectorState(state, runs, "toggleDetails");
		expect(state.showAgentDetails).toBe(false);
	});
});
