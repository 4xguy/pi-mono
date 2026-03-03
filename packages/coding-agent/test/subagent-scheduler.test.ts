import { describe, expect, it } from "vitest";
import { buildSchedulerWaves } from "../examples/extensions/subagent/scheduler.js";
import type { SchedulerTask } from "../examples/extensions/subagent/types.js";

describe("subagent scheduler", () => {
	it("groups safe tasks into shared waves", () => {
		const tasks: SchedulerTask[] = [
			{ index: 0, isWriteTask: false, isolation: "none", writePaths: undefined },
			{ index: 1, isWriteTask: false, isolation: "none", writePaths: undefined },
			{ index: 2, isWriteTask: true, isolation: "worktree", writePaths: ["src/a/**"] },
			{ index: 3, isWriteTask: true, isolation: "worktree", writePaths: ["src/b/**"] },
		];

		const schedule = buildSchedulerWaves(tasks);
		expect(schedule.waves).toEqual([{ taskIndexes: [0, 1, 2, 3] }]);
		expect(schedule.conflicts).toEqual([]);
	});

	it("serializes conflicting writes into multiple waves", () => {
		const tasks: SchedulerTask[] = [
			{ index: 0, isWriteTask: true, isolation: "worktree", writePaths: ["src/shared/**"] },
			{ index: 1, isWriteTask: true, isolation: "worktree", writePaths: ["src/shared/file.ts"] },
			{ index: 2, isWriteTask: false, isolation: "none", writePaths: undefined },
		];

		const schedule = buildSchedulerWaves(tasks);
		expect(schedule.waves).toEqual([{ taskIndexes: [0, 2] }, { taskIndexes: [1] }]);
		expect(schedule.conflicts).toEqual([{ a: 0, b: 1 }]);
	});

	it("keeps main-cwd writers exclusive", () => {
		const tasks: SchedulerTask[] = [
			{ index: 0, isWriteTask: true, isolation: "none", writePaths: ["src/a/**"] },
			{ index: 1, isWriteTask: false, isolation: "none", writePaths: undefined },
			{ index: 2, isWriteTask: true, isolation: "worktree", writePaths: ["src/b/**"] },
		];

		const schedule = buildSchedulerWaves(tasks);
		expect(schedule.waves).toEqual([{ taskIndexes: [0] }, { taskIndexes: [1, 2] }]);
	});
});
