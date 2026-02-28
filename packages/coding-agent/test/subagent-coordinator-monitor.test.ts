import { describe, expect, it, vi } from "vitest";
import {
	COMPLETION_STATUS_WINDOW_MS,
	CoordinatorMonitor,
} from "../examples/extensions/subagent/coordinator-monitor.js";

describe("subagent coordinator monitor", () => {
	it("formats compact status summary with parallel counters", () => {
		const monitor = new CoordinatorMonitor();
		const first = monitor.startRun({
			runId: "run-1",
			mode: "parallel",
			agents: [
				{ agent: "scout", task: "scan auth" },
				{ agent: "planner", task: "plan change" },
				{ agent: "worker", task: "implement" },
			],
			parallelMax: 3,
		});
		monitor.setPhase(first, "running");
		monitor.markAgentRunning(first, 0);
		monitor.markAgentRunning(first, 1);

		expect(monitor.formatStatusSummary()).toBe("c1:a3:p2");
	});

	it("shows active coordinators only when work is still running", () => {
		const monitor = new CoordinatorMonitor();
		const c1 = monitor.startRun({
			runId: "run-1",
			mode: "single",
			agents: [{ agent: "scout", task: "scan" }],
			parallelMax: 0,
		});
		monitor.finishRun(c1, true);

		const c2 = monitor.startRun({
			runId: "run-2",
			mode: "chain",
			agents: [
				{ agent: "planner", task: "plan", step: 1 },
				{ agent: "worker", task: "build", step: 2 },
			],
			parallelMax: 0,
		});
		monitor.setPhase(c2, "running");

		expect(monitor.formatStatusSummary()).toBe("c2:a2");
	});

	it("shows only most recent active coordinators when active exceeds summary limit", () => {
		const monitor = new CoordinatorMonitor();
		const c1 = monitor.startRun({
			runId: "run-1",
			mode: "single",
			agents: [{ agent: "scout", task: "scan" }],
			parallelMax: 0,
		});
		monitor.setPhase(c1, "running");
		const c2 = monitor.startRun({
			runId: "run-2",
			mode: "single",
			agents: [{ agent: "planner", task: "plan" }],
			parallelMax: 0,
		});
		monitor.setPhase(c2, "running");
		const c3 = monitor.startRun({
			runId: "run-3",
			mode: "single",
			agents: [{ agent: "worker", task: "build" }],
			parallelMax: 0,
		});
		monitor.setPhase(c3, "running");
		const c4 = monitor.startRun({
			runId: "run-4",
			mode: "single",
			agents: [{ agent: "reviewer", task: "review" }],
			parallelMax: 0,
		});
		monitor.setPhase(c4, "running");

		expect(monitor.formatStatusSummary()).toBe("c2:a1 | c3:a1 | c4:a1");
	});

	it("shows a short completion status when idle", () => {
		vi.useFakeTimers();
		const monitor = new CoordinatorMonitor();
		const c1 = monitor.startRun({
			runId: "run-1",
			mode: "single",
			agents: [{ agent: "scout", task: "scan" }],
			parallelMax: 0,
		});
		monitor.finishRun(c1, true);

		expect(monitor.formatStatusSummary()).toBe("c1:done");
		vi.useRealTimers();
	});

	it("clears completion status after the completion window", () => {
		vi.useFakeTimers();
		const monitor = new CoordinatorMonitor();
		const c1 = monitor.startRun({
			runId: "run-1",
			mode: "single",
			agents: [{ agent: "scout", task: "scan" }],
			parallelMax: 0,
		});
		monitor.finishRun(c1, true);
		vi.advanceTimersByTime(COMPLETION_STATUS_WINDOW_MS + 1);

		expect(monitor.formatStatusSummary()).toBeUndefined();
		vi.useRealTimers();
	});

	it("stores governance snapshot and returns cloned remediation entries", () => {
		const monitor = new CoordinatorMonitor();
		const c1 = monitor.startRun({
			runId: "run-1",
			mode: "single",
			agents: [{ agent: "scout", task: "scan" }],
			parallelMax: 0,
		});
		monitor.setGovernance(c1, {
			phaseName: "phase-1",
			gateSummary: "topology:ok smoke:fail",
			smokeAttempts: 2,
			smokeFixAttempts: 1,
			smokeMaxFixAttempts: 2,
			remediation: [{ attempt: 1, agent: "worker", outcome: "error", summary: "smoke still failing" }],
		});

		const runs = monitor.getRuns();
		expect(runs[0]?.governance?.gateSummary).toBe("topology:ok smoke:fail");
		expect(runs[0]?.governance?.remediation).toHaveLength(1);

		if (runs[0]?.governance?.remediation) {
			runs[0].governance.remediation[0].summary = "mutated";
		}
		const rerun = monitor.getRuns();
		expect(rerun[0]?.governance?.remediation[0]?.summary).toBe("smoke still failing");
	});
});
