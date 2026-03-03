import { describe, expect, it } from "vitest";
import {
	applySmokeResults,
	createPhaseGateState,
	formatPhaseGateSummary,
	markSmokeSkipped,
	recordSmokeFixAttempt,
	validatePhaseGateState,
} from "../examples/extensions/subagent/phase-gates.js";

describe("subagent phase gates", () => {
	it("validates required smoke gate inputs", () => {
		const state = createPhaseGateState({
			requireSmoke: true,
			smokeCommands: [],
			topologySummary: "single",
		});
		expect(validatePhaseGateState(state)).toBe(
			"Phase smoke gate requires at least one smoke command (phaseSmokeCommands).",
		);
	});

	it("tracks retry and fix configuration defaults", () => {
		const state = createPhaseGateState({
			requireSmoke: true,
			smokeCommands: ["echo ok"],
			topologySummary: "parallel",
		});
		expect(state.smokeMaxRetries).toBe(1);
		expect(state.smokeMaxFixAttempts).toBe(2);
		expect(state.smokeAttempts).toBe(0);
		expect(state.smokeFixAttempts).toBe(0);
		expect(state.smokeFixHistory).toEqual([]);
	});

	it("marks smoke gate passed when commands succeed", () => {
		let state = createPhaseGateState({
			requireSmoke: true,
			smokeCommands: ["echo ok"],
			topologySummary: "parallel",
		});
		state = { ...state, smokeAttempts: 2, smokeFixAttempts: 1 };
		state = applySmokeResults(state, [{ command: "echo ok", exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 }]);

		expect(formatPhaseGateSummary(state)).toContain("smoke:ok");
		const smokeGate = state.gates.find((gate) => gate.key === "smoke");
		expect(smokeGate?.detail).toContain("attempt 2");
		expect(smokeGate?.detail).toContain("fixes 1/2");
	});

	it("marks smoke gate failed when a command fails", () => {
		let state = createPhaseGateState({
			requireSmoke: true,
			smokeCommands: ["npm run check"],
			topologySummary: "chain",
		});
		state = { ...state, smokeAttempts: 1 };
		state = applySmokeResults(state, [
			{ command: "npm run check", exitCode: 1, stdout: "", stderr: "failed", durationMs: 200 },
		]);

		expect(formatPhaseGateSummary(state)).toContain("smoke:fail");
	});

	it("records smoke fix attempt history entries", () => {
		let state = createPhaseGateState({
			requireSmoke: true,
			smokeCommands: ["npm run check"],
			topologySummary: "chain",
		});

		state = recordSmokeFixAttempt(state, {
			attempt: 1,
			agent: "worker",
			outcome: "error",
			summary: "smoke still failing",
		});
		state = recordSmokeFixAttempt(state, {
			attempt: 2,
			agent: "worker",
			outcome: "success",
			summary: "fixed and passed",
		});

		expect(state.smokeFixAttempts).toBe(2);
		expect(state.smokeFixHistory).toHaveLength(2);
		expect(state.smokeFixHistory[0]?.outcome).toBe("error");
		expect(state.smokeFixHistory[1]?.outcome).toBe("success");
	});

	it("marks non-required smoke gate as skipped", () => {
		const state = markSmokeSkipped(
			createPhaseGateState({
				requireSmoke: false,
				smokeCommands: [],
				topologySummary: "single",
			}),
		);
		expect(formatPhaseGateSummary(state)).toContain("smoke:skipped");
	});
});
