import { detectWriteConflicts, schedulerTasksConflict } from "./policy.js";
import type { SchedulerResult, SchedulerTask, SchedulerWave } from "./types.js";

function canPlaceInWave(candidate: SchedulerTask, waveTasks: SchedulerTask[]): boolean {
	for (const task of waveTasks) {
		if (schedulerTasksConflict(candidate, task)) {
			return false;
		}
	}
	return true;
}

export function buildSchedulerWaves(tasks: SchedulerTask[]): SchedulerResult {
	const waves: SchedulerWave[] = [];
	const waveTasks: SchedulerTask[][] = [];

	for (const task of tasks) {
		let placed = false;
		for (let i = 0; i < waveTasks.length; i++) {
			if (canPlaceInWave(task, waveTasks[i])) {
				waveTasks[i].push(task);
				waves[i].taskIndexes.push(task.index);
				placed = true;
				break;
			}
		}

		if (!placed) {
			waveTasks.push([task]);
			waves.push({ taskIndexes: [task.index] });
		}
	}

	return {
		waves,
		conflicts: detectWriteConflicts(tasks),
	};
}
