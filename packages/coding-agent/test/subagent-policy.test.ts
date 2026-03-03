import { describe, expect, it } from "vitest";
import {
	deriveIsolation,
	isWriteCapable,
	normalizeWritePaths,
	schedulerTasksConflict,
	writePathsConflict,
} from "../examples/extensions/subagent/policy.js";

describe("subagent policy", () => {
	it("detects write-capable tasks", () => {
		expect(isWriteCapable("write", ["read"])).toBe(true);
		expect(isWriteCapable("read", ["write"])).toBe(false);
		expect(isWriteCapable("auto", ["read", "find"])).toBe(false);
		expect(isWriteCapable("auto", ["read", "edit"])).toBe(true);
		expect(isWriteCapable("auto", undefined)).toBe(true);
	});

	it("normalizes write paths and detects conflicts conservatively", () => {
		expect(normalizeWritePaths([" ./src/**/*.ts ", "src\\utils/*"])).toEqual(["src/**/*.ts", "src/utils/*"]);
		expect(writePathsConflict(["src/a.ts"], ["src/a.ts"])).toBe(true);
		expect(writePathsConflict(["src/**"], ["src/components/Button.tsx"])).toBe(true);
		expect(writePathsConflict(["src/a/**"], ["docs/**"])).toBe(false);
		expect(writePathsConflict(undefined, ["docs/**"])).toBe(true);
	});

	it("derives isolation defaults", () => {
		expect(deriveIsolation("read", false, undefined)).toBe("none");
		expect(deriveIsolation("write", true, undefined)).toBe("worktree");
		expect(deriveIsolation("auto", true, undefined)).toBe("worktree");
		expect(deriveIsolation("auto", false, undefined)).toBe("none");
		expect(deriveIsolation("write", true, "none")).toBe("none");
	});

	it("computes scheduler-level conflicts", () => {
		const readTask = { index: 0, isWriteTask: false, isolation: "none" as const, writePaths: undefined };
		const sharedWrite = { index: 1, isWriteTask: true, isolation: "none" as const, writePaths: ["src/**"] };
		const isolatedWriteA = { index: 2, isWriteTask: true, isolation: "worktree" as const, writePaths: ["src/a/**"] };
		const isolatedWriteB = { index: 3, isWriteTask: true, isolation: "worktree" as const, writePaths: ["src/b/**"] };

		expect(schedulerTasksConflict(readTask, isolatedWriteA)).toBe(false);
		expect(schedulerTasksConflict(readTask, sharedWrite)).toBe(true);
		expect(schedulerTasksConflict(sharedWrite, isolatedWriteA)).toBe(true);
		expect(schedulerTasksConflict(isolatedWriteA, isolatedWriteB)).toBe(false);
	});
});
