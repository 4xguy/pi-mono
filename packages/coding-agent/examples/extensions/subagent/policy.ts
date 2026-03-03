import type { IsolationMode, ResolvedTaskExecution, SchedulerTask, TaskMode, WriteConflictPolicy } from "./types.js";

const GLOB_CHARS = /[*?{}[\]!]/;

function getPatternBase(pattern: string): string {
	const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
	const firstGlobIndex = normalized.search(GLOB_CHARS);
	if (firstGlobIndex === -1) return normalized;
	return normalized.slice(0, firstGlobIndex);
}

function normalizePathPattern(pattern: string): string {
	return pattern.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

export function isWriteCapable(mode: TaskMode, tools: string[] | undefined): boolean {
	if (mode === "write") return true;
	if (mode === "read") return false;
	if (!tools || tools.length === 0) return true;

	const lowerTools = new Set(tools.map((tool) => tool.toLowerCase()));
	if (lowerTools.has("write") || lowerTools.has("edit")) return true;
	if (lowerTools.has("bash")) return true;
	return false;
}

export function normalizeWritePaths(writePaths: string[] | undefined): string[] | undefined {
	if (!writePaths || writePaths.length === 0) return undefined;
	const normalized = writePaths.map(normalizePathPattern).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

export function writePathsConflict(a: string[] | undefined, b: string[] | undefined): boolean {
	if (!a || !b) return true;

	for (const left of a) {
		for (const right of b) {
			if (left === right) return true;
			const leftBase = getPatternBase(left);
			const rightBase = getPatternBase(right);
			if (!leftBase || !rightBase) return true;
			if (leftBase.startsWith(rightBase) || rightBase.startsWith(leftBase)) return true;
		}
	}
	return false;
}

export function schedulerTasksConflict(a: SchedulerTask, b: SchedulerTask): boolean {
	if (!a.isWriteTask && !b.isWriteTask) return false;

	if (a.isWriteTask && b.isWriteTask) {
		if (a.isolation !== "worktree" || b.isolation !== "worktree") return true;
		return writePathsConflict(a.writePaths, b.writePaths);
	}

	const writer = a.isWriteTask ? a : b;
	return writer.isolation !== "worktree";
}

export function detectWriteConflicts(tasks: SchedulerTask[]): Array<{ a: number; b: number }> {
	const conflicts: Array<{ a: number; b: number }> = [];
	for (let i = 0; i < tasks.length; i++) {
		for (let j = i + 1; j < tasks.length; j++) {
			if (schedulerTasksConflict(tasks[i], tasks[j])) {
				conflicts.push({ a: tasks[i].index, b: tasks[j].index });
			}
		}
	}
	return conflicts;
}

export function shouldFailOnConflicts(policy: WriteConflictPolicy): boolean {
	return policy === "fail";
}

export function deriveIsolation(
	mode: TaskMode,
	isWriteTask: boolean,
	requested: IsolationMode | undefined,
): IsolationMode {
	if (requested) return requested;
	if (mode === "read") return "none";
	if (mode === "write") return "worktree";
	return isWriteTask ? "worktree" : "none";
}

export function toSchedulerTask(task: ResolvedTaskExecution): SchedulerTask {
	return {
		index: task.index,
		isWriteTask: task.isWriteTask,
		writePaths: task.writePaths,
		isolation: task.isolation,
	};
}
