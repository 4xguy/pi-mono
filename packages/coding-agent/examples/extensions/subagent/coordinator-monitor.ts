export type CoordinatorMode = "single" | "parallel" | "chain";
export type CoordinatorPhase = "starting" | "dispatch" | "running" | "finalizing" | "done" | "error";
export type AgentExecutionStatus = "pending" | "running" | "done" | "error";

export const COMPLETION_STATUS_WINDOW_MS = 5_000;

export interface AgentExecutionState {
	agent: string;
	task: string;
	status: AgentExecutionStatus;
	step?: number;
	error?: string;
}

export interface SmokeRemediationEntry {
	attempt: number;
	agent: string;
	outcome: "success" | "error";
	summary: string;
}

export interface CoordinatorGovernanceSnapshot {
	phaseName?: string;
	gateSummary: string;
	smokeAttempts: number;
	smokeFixAttempts: number;
	smokeMaxFixAttempts: number;
	remediation: SmokeRemediationEntry[];
}

export interface CoordinatorRunState {
	id: number;
	runId: string;
	mode: CoordinatorMode;
	phase: CoordinatorPhase;
	agentsTotal: number;
	parallelRunning: number;
	parallelMax: number;
	currentStep?: number;
	startedAtMs: number;
	finishedAtMs?: number;
	error?: string;
	governance?: CoordinatorGovernanceSnapshot;
	agents: AgentExecutionState[];
}

interface CoordinatorStartInput {
	runId: string;
	mode: CoordinatorMode;
	agents: Array<{ agent: string; task: string; step?: number }>;
	parallelMax: number;
}

export class CoordinatorMonitor {
	private nextId = 1;
	private runs: CoordinatorRunState[] = [];

	startRun(input: CoordinatorStartInput): number {
		const id = this.nextId++;
		const run: CoordinatorRunState = {
			id,
			runId: input.runId,
			mode: input.mode,
			phase: "starting",
			agentsTotal: input.agents.length,
			parallelRunning: 0,
			parallelMax: Math.max(0, input.parallelMax),
			startedAtMs: Date.now(),
			agents: input.agents.map((agent) => ({
				agent: agent.agent,
				task: agent.task,
				step: agent.step,
				status: "pending",
			})),
		};
		this.runs.push(run);
		return id;
	}

	setPhase(id: number, phase: CoordinatorPhase): void {
		const run = this.getRun(id);
		if (!run) return;
		run.phase = phase;
	}

	setCurrentStep(id: number, step: number | undefined): void {
		const run = this.getRun(id);
		if (!run) return;
		run.currentStep = step;
	}

	setParallelRunning(id: number, running: number): void {
		const run = this.getRun(id);
		if (!run) return;
		run.parallelRunning = Math.max(0, running);
	}

	markAgentRunning(id: number, index: number): void {
		const run = this.getRun(id);
		if (!run) return;
		const agent = run.agents[index];
		if (!agent) return;
		agent.status = "running";
	}

	markAgentDone(id: number, index: number): void {
		const run = this.getRun(id);
		if (!run) return;
		const agent = run.agents[index];
		if (!agent) return;
		agent.status = "done";
		agent.error = undefined;
	}

	markAgentError(id: number, index: number, error: string): void {
		const run = this.getRun(id);
		if (!run) return;
		const agent = run.agents[index];
		if (!agent) return;
		agent.status = "error";
		agent.error = error;
	}

	finishRun(id: number, success: boolean, error?: string): void {
		const run = this.getRun(id);
		if (!run) return;
		run.phase = success ? "done" : "error";
		run.error = error;
		run.finishedAtMs = Date.now();
		run.parallelRunning = 0;
	}

	setGovernance(id: number, snapshot: CoordinatorGovernanceSnapshot): void {
		const run = this.getRun(id);
		if (!run) return;
		run.governance = {
			...snapshot,
			remediation: snapshot.remediation.map((entry) => ({ ...entry })),
		};
	}

	getRuns(): CoordinatorRunState[] {
		return this.runs.map((run) => ({
			...run,
			governance: run.governance
				? {
						...run.governance,
						remediation: run.governance.remediation.map((entry) => ({ ...entry })),
					}
				: undefined,
			agents: run.agents.map((agent) => ({ ...agent })),
		}));
	}

	reset(): void {
		this.runs = [];
		this.nextId = 1;
	}

	cleanup(maxFinishedAgeMs = 120_000, maxRuns = 12): void {
		const now = Date.now();
		this.runs = this.runs.filter((run) => {
			if (!run.finishedAtMs) return true;
			return now - run.finishedAtMs <= maxFinishedAgeMs;
		});
		if (this.runs.length > maxRuns) {
			this.runs = this.runs.slice(this.runs.length - maxRuns);
		}
	}

	formatStatusSummary(maxCoordinators = 3): string | undefined {
		this.cleanup();
		if (this.runs.length === 0) return undefined;

		const max = Math.max(1, maxCoordinators);
		const active = this.runs.filter((run) => run.phase !== "done" && run.phase !== "error");
		if (active.length > 0) {
			const selected = active.slice(-max).sort((a, b) => a.id - b.id);
			return selected.map((run) => this.formatRunToken(run)).join(" | ");
		}

		const now = Date.now();
		const recentlyFinished = this.runs.filter(
			(run) =>
				(run.phase === "done" || run.phase === "error") &&
				typeof run.finishedAtMs === "number" &&
				now - run.finishedAtMs <= COMPLETION_STATUS_WINDOW_MS,
		);
		if (recentlyFinished.length === 0) return undefined;

		const selected = recentlyFinished.slice(-max).sort((a, b) => a.id - b.id);
		return selected.map((run) => this.formatCompletedRunToken(run)).join(" | ");
	}

	private formatRunToken(run: CoordinatorRunState): string {
		let text = `c${run.id}:a${run.agentsTotal}`;
		const runningAgents = run.agents.filter((agent) => agent.status === "running").length;
		const parallelRunning = Math.max(run.parallelRunning, runningAgents);
		if (parallelRunning > 0) text += `:p${parallelRunning}`;
		return text;
	}

	private formatCompletedRunToken(run: CoordinatorRunState): string {
		return run.phase === "error" ? `c${run.id}:err` : `c${run.id}:done`;
	}

	private getRun(id: number): CoordinatorRunState | undefined {
		return this.runs.find((run) => run.id === id);
	}
}
