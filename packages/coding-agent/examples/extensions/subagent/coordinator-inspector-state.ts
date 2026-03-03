import type { CoordinatorRunState } from "./coordinator-monitor.js";

export interface CoordinatorInspectorState {
	selectedCoordinator: number;
	selectedAgent: number;
	showAgentDetails: boolean;
}

export type CoordinatorInspectorAction = "left" | "right" | "up" | "down" | "toggleDetails";

export function normalizeCoordinatorInspectorState(
	state: CoordinatorInspectorState,
	runs: CoordinatorRunState[],
): CoordinatorInspectorState {
	if (runs.length === 0) {
		return {
			selectedCoordinator: 0,
			selectedAgent: 0,
			showAgentDetails: false,
		};
	}

	const selectedCoordinator = clamp(state.selectedCoordinator, 0, runs.length - 1);
	const agentCount = runs[selectedCoordinator].agents.length;
	const selectedAgent = clamp(state.selectedAgent, 0, Math.max(0, agentCount - 1));

	return {
		selectedCoordinator,
		selectedAgent,
		showAgentDetails: state.showAgentDetails,
	};
}

export function reduceCoordinatorInspectorState(
	state: CoordinatorInspectorState,
	runs: CoordinatorRunState[],
	action: CoordinatorInspectorAction,
): CoordinatorInspectorState {
	const normalized = normalizeCoordinatorInspectorState(state, runs);
	if (runs.length === 0) return normalized;

	switch (action) {
		case "left":
			return {
				selectedCoordinator: clamp(normalized.selectedCoordinator - 1, 0, runs.length - 1),
				selectedAgent: 0,
				showAgentDetails: false,
			};
		case "right":
			return {
				selectedCoordinator: clamp(normalized.selectedCoordinator + 1, 0, runs.length - 1),
				selectedAgent: 0,
				showAgentDetails: false,
			};
		case "up": {
			const maxAgent = Math.max(0, runs[normalized.selectedCoordinator].agents.length - 1);
			return {
				...normalized,
				selectedAgent: clamp(normalized.selectedAgent - 1, 0, maxAgent),
			};
		}
		case "down": {
			const maxAgent = Math.max(0, runs[normalized.selectedCoordinator].agents.length - 1);
			return {
				...normalized,
				selectedAgent: clamp(normalized.selectedAgent + 1, 0, maxAgent),
			};
		}
		case "toggleDetails":
			return {
				...normalized,
				showAgentDetails: !normalized.showAgentDetails,
			};
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
