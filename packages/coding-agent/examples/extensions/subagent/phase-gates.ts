export type PhaseGateStatus = "pending" | "passed" | "failed" | "skipped";

export interface SmokeCommandResult {
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface SmokeFixAttemptRecord {
	attempt: number;
	agent: string;
	outcome: "success" | "error";
	summary: string;
}

export interface PhaseGate {
	key: "topology" | "smoke";
	label: string;
	required: boolean;
	status: PhaseGateStatus;
	detail?: string;
}

export interface PhaseGateState {
	phaseName?: string;
	requireSmoke: boolean;
	smokeCommands: string[];
	smokeMaxRetries: number;
	smokeMaxFixAttempts: number;
	smokeAttempts: number;
	smokeFixAttempts: number;
	smokeFixHistory: SmokeFixAttemptRecord[];
	gates: PhaseGate[];
	smokeResults: SmokeCommandResult[];
}

export interface PhaseGateInit {
	phaseName?: string;
	requireSmoke?: boolean;
	smokeCommands?: string[];
	topologySummary: string;
	smokeMaxRetries?: number;
	smokeMaxFixAttempts?: number;
}

export function createPhaseGateState(init: PhaseGateInit): PhaseGateState {
	const smokeCommands = (init.smokeCommands ?? [])
		.map((command) => command.trim())
		.filter((command) => command.length > 0);
	const requireSmoke = Boolean(init.requireSmoke);
	const smokeRequired = requireSmoke || smokeCommands.length > 0;
	const smokeMaxRetries = Math.max(0, init.smokeMaxRetries ?? 1);
	const smokeMaxFixAttempts = Math.max(0, init.smokeMaxFixAttempts ?? 2);

	return {
		phaseName: init.phaseName,
		requireSmoke,
		smokeCommands,
		smokeMaxRetries,
		smokeMaxFixAttempts,
		smokeAttempts: 0,
		smokeFixAttempts: 0,
		smokeFixHistory: [],
		smokeResults: [],
		gates: [
			{
				key: "topology",
				label: "Topology decision",
				required: true,
				status: "passed",
				detail: init.topologySummary,
			},
			{
				key: "smoke",
				label: "Phase smoke",
				required: smokeRequired,
				status: smokeRequired ? "pending" : "skipped",
				detail: smokeRequired ? `${smokeCommands.length} command(s)` : "not configured",
			},
		],
	};
}

export function validatePhaseGateState(state: PhaseGateState): string | undefined {
	if (state.requireSmoke && state.smokeCommands.length === 0) {
		return "Phase smoke gate requires at least one smoke command (phaseSmokeCommands).";
	}
	if (state.smokeMaxRetries < 0) return "phaseSmokeRetries must be >= 0.";
	if (state.smokeMaxFixAttempts < 0) return "phaseMaxFixAttempts must be >= 0.";
	return undefined;
}

export function applySmokeResults(state: PhaseGateState, smokeResults: SmokeCommandResult[]): PhaseGateState {
	const failedResult = smokeResults.find((result) => result.exitCode !== 0);
	const attemptsLabel = `attempt ${state.smokeAttempts}`;
	const fixLabel = `fixes ${state.smokeFixAttempts}/${state.smokeMaxFixAttempts}`;
	return {
		...state,
		smokeResults,
		gates: state.gates.map((gate) => {
			if (gate.key !== "smoke") return gate;
			if (gate.required || smokeResults.length > 0) {
				if (failedResult) {
					return {
						...gate,
						status: "failed",
						detail: `${failedResult.command} (exit ${failedResult.exitCode}, ${attemptsLabel}, ${fixLabel})`,
					};
				}
				return {
					...gate,
					status: "passed",
					detail: `${smokeResults.length} command(s) passed (${attemptsLabel}, ${fixLabel})`,
				};
			}
			return gate;
		}),
	};
}

export function markSmokeSkipped(state: PhaseGateState): PhaseGateState {
	return {
		...state,
		gates: state.gates.map((gate) => {
			if (gate.key !== "smoke") return gate;
			if (!gate.required) {
				return {
					...gate,
					status: "skipped",
					detail: "not required",
				};
			}
			return gate;
		}),
	};
}

export function recordSmokeFixAttempt(state: PhaseGateState, entry: SmokeFixAttemptRecord): PhaseGateState {
	return {
		...state,
		smokeFixAttempts: Math.max(state.smokeFixAttempts, entry.attempt),
		smokeFixHistory: [...state.smokeFixHistory, entry],
	};
}

export function formatPhaseGateSummary(state: PhaseGateState): string {
	const parts = state.gates.map((gate) => {
		const marker = gate.status === "passed" ? "ok" : gate.status === "failed" ? "fail" : gate.status;
		return `${gate.key}:${marker}`;
	});
	return parts.join(" ");
}
