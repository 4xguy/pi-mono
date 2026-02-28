import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type ExecutionIsolation = "shared" | "worktree" | "auto";
export type ResolvedExecutionIsolation = "shared" | "worktree";

export interface WorktreeSession {
	runId: string;
	repoRoot: string;
	baseDir: string;
	assignments: WorktreeAssignment[];
}

export interface WorktreeAssignment {
	id: string;
	label: string;
	branchName: string;
	worktreePath: string;
	baseHead: string;
}

export interface WorktreeIntegrationReport {
	assignmentId: string;
	label: string;
	status: "applied" | "skipped" | "failed";
	filesChanged: number;
	message?: string;
}

export interface WorktreeTaskCwd {
	cwd: string;
	warning?: string;
}

export interface ExecutionIsolationTaskInput {
	task: string;
	agent?: string;
	agentTools?: string[];
}

export interface ExecutionIsolationDecisionInput {
	requestedIsolation: ExecutionIsolation;
	mode: "single" | "parallel" | "chain";
	single?: ExecutionIsolationTaskInput;
	tasks?: ExecutionIsolationTaskInput[];
	chain?: ExecutionIsolationTaskInput[];
}

export interface ExecutionIsolationDecision {
	requestedIsolation: ExecutionIsolation;
	selectedIsolation: ResolvedExecutionIsolation;
	reason: string;
}

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

const GIT_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

const WRITE_TASK_KEYWORDS = [
	"edit",
	"modify",
	"update",
	"implement",
	"write",
	"create",
	"refactor",
	"fix",
	"delete",
	"add",
	"remove",
	"patch",
	"rename",
	"replace",
	"migrate",
	"apply",
];

const READ_ONLY_TASK_KEYWORDS = [
	"list",
	"find",
	"search",
	"inspect",
	"read",
	"analyze",
	"summarize",
	"explain",
	"locate",
	"show",
	"identify",
	"scan",
	"report",
];

const DIRECT_WRITE_TOOLS = ["write", "edit", "bash"];

export function parseExecutionIsolation(
	value: string | undefined,
	fallback: ExecutionIsolation = "auto",
): ExecutionIsolation {
	if (value === "shared" || value === "worktree" || value === "auto") return value;
	return fallback;
}

export function decideExecutionIsolation(input: ExecutionIsolationDecisionInput): ExecutionIsolationDecision {
	if (input.requestedIsolation === "shared") {
		return {
			requestedIsolation: input.requestedIsolation,
			selectedIsolation: "shared",
			reason: "isolation explicitly set to shared",
		};
	}

	if (input.requestedIsolation === "worktree") {
		return {
			requestedIsolation: input.requestedIsolation,
			selectedIsolation: "worktree",
			reason: "isolation explicitly set to worktree",
		};
	}

	const tasks = extractIsolationTasks(input);
	const hasWriteIntent = tasks.some((task) => isWriteIntent(task.task));
	const hasReadOnlyIntent = tasks.length > 0 && tasks.every((task) => isLikelyReadOnlyIntent(task.task));
	const hasWriteCapableAgents = tasks.some((task) => isWriteCapable(task.agentTools));

	if (input.mode === "parallel") {
		if (tasks.length <= 1) {
			return {
				requestedIsolation: input.requestedIsolation,
				selectedIsolation: "shared",
				reason: "auto isolation: parallel requested but <=1 task, shared is sufficient",
			};
		}
		if (hasReadOnlyIntent && !hasWriteIntent) {
			return {
				requestedIsolation: input.requestedIsolation,
				selectedIsolation: "shared",
				reason: "auto isolation: parallel read-only tasks, shared preferred",
			};
		}
		return {
			requestedIsolation: input.requestedIsolation,
			selectedIsolation: "worktree",
			reason: "auto isolation: parallel lane with potential writes, using worktree",
		};
	}

	if (input.mode === "chain") {
		if (hasWriteIntent || hasWriteCapableAgents) {
			return {
				requestedIsolation: input.requestedIsolation,
				selectedIsolation: "worktree",
				reason: "auto isolation: chained execution with write potential, using worktree",
			};
		}
		return {
			requestedIsolation: input.requestedIsolation,
			selectedIsolation: "shared",
			reason: "auto isolation: chained read-only tasks, shared preferred",
		};
	}

	if (hasWriteIntent && hasWriteCapableAgents) {
		return {
			requestedIsolation: input.requestedIsolation,
			selectedIsolation: "worktree",
			reason: "auto isolation: single task with explicit write intent, using worktree",
		};
	}

	return {
		requestedIsolation: input.requestedIsolation,
		selectedIsolation: "shared",
		reason: "auto isolation: single task defaulting to shared",
	};
}

export function resolveGitRepoRoot(cwd: string): string | undefined {
	const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!result.ok) return undefined;
	const root = result.stdout.trim();
	if (!root) return undefined;
	return path.resolve(root);
}

export function createWorktreeSession(input: { cwd: string; runId: string; baseDir?: string }): WorktreeSession {
	const repoRoot = resolveGitRepoRoot(input.cwd);
	if (!repoRoot) {
		throw new Error("worktree isolation requires a git repository");
	}
	const baseDir = path.resolve(input.baseDir ?? path.join(repoRoot, ".pi", "worktrees"));
	fs.mkdirSync(baseDir, { recursive: true });
	return {
		runId: input.runId,
		repoRoot,
		baseDir,
		assignments: [],
	};
}

export function createWorktreeAssignment(session: WorktreeSession, label: string): WorktreeAssignment {
	const index = session.assignments.length + 1;
	const safeLabel = sanitizeLabel(label);
	const id = `${safeLabel}-${index}`;
	const branchName = `pi/subagent/${session.runId}/${id}`;
	const worktreePath = path.join(session.baseDir, `${session.runId}-${id}`);

	if (fs.existsSync(worktreePath)) {
		throw new Error(`worktree path already exists: ${worktreePath}`);
	}

	const headResult = runGit(session.repoRoot, ["rev-parse", "HEAD"]);
	if (!headResult.ok) {
		throw new Error(`failed to resolve repository head: ${headResult.stderr || headResult.stdout}`);
	}
	const baseHead = headResult.stdout.trim();

	const addResult = runGit(session.repoRoot, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
	if (!addResult.ok) {
		throw new Error(`failed to create worktree ${label}: ${addResult.stderr || addResult.stdout}`);
	}

	const assignment: WorktreeAssignment = {
		id,
		label,
		branchName,
		worktreePath,
		baseHead,
	};
	session.assignments.push(assignment);
	return assignment;
}

export function resolveWorktreeTaskCwd(
	repoRoot: string,
	worktreePath: string,
	taskCwd: string | undefined,
): WorktreeTaskCwd {
	if (!taskCwd) return { cwd: worktreePath };
	const resolvedTaskCwd = path.resolve(taskCwd);
	const relative = path.relative(repoRoot, resolvedTaskCwd);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		return {
			cwd: worktreePath,
			warning: `task cwd ${resolvedTaskCwd} is outside repo root; using worktree root ${worktreePath}`,
		};
	}
	return {
		cwd: path.join(worktreePath, relative),
	};
}

export function integrateWorktreeAssignments(
	session: WorktreeSession,
	assignments: WorktreeAssignment[],
): WorktreeIntegrationReport[] {
	const reports: WorktreeIntegrationReport[] = [];
	for (const assignment of assignments) {
		const diffResult = runGit(assignment.worktreePath, ["diff", "--binary"]);
		if (!diffResult.ok) {
			reports.push({
				assignmentId: assignment.id,
				label: assignment.label,
				status: "failed",
				filesChanged: 0,
				message: diffResult.stderr || diffResult.stdout || "failed to capture worktree diff",
			});
			continue;
		}

		const patch = diffResult.stdout;
		const filesChanged = (patch.match(/^diff --git /gm) ?? []).length;
		if (!patch.trim()) {
			reports.push({
				assignmentId: assignment.id,
				label: assignment.label,
				status: "skipped",
				filesChanged,
				message: "no changes",
			});
			continue;
		}

		const applyResult = runGit(session.repoRoot, ["apply", "--3way", "--whitespace=nowarn", "-"], patch);
		if (!applyResult.ok) {
			reports.push({
				assignmentId: assignment.id,
				label: assignment.label,
				status: "failed",
				filesChanged,
				message: applyResult.stderr || applyResult.stdout || "failed to apply patch",
			});
			continue;
		}

		reports.push({
			assignmentId: assignment.id,
			label: assignment.label,
			status: "applied",
			filesChanged,
			message: filesChanged > 0 ? `applied ${filesChanged} file(s)` : "applied",
		});
	}
	return reports;
}

export function cleanupWorktreeSession(session: WorktreeSession): string[] {
	const warnings: string[] = [];
	for (let i = session.assignments.length - 1; i >= 0; i--) {
		const assignment = session.assignments[i];
		const removeResult = runGit(session.repoRoot, ["worktree", "remove", "--force", assignment.worktreePath]);
		if (!removeResult.ok) {
			warnings.push(
				`failed to remove worktree ${assignment.worktreePath}: ${removeResult.stderr || removeResult.stdout}`,
			);
		}
		if (fs.existsSync(assignment.worktreePath)) {
			try {
				fs.rmSync(assignment.worktreePath, { recursive: true, force: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warnings.push(`failed to remove worktree path ${assignment.worktreePath}: ${message}`);
			}
		}

		const branchHeadResult = runGit(session.repoRoot, ["rev-parse", assignment.branchName]);
		if (!branchHeadResult.ok) continue;
		const branchHead = branchHeadResult.stdout.trim();
		if (branchHead !== assignment.baseHead) continue;
		const deleteBranchResult = runGit(session.repoRoot, ["branch", "-D", assignment.branchName]);
		if (!deleteBranchResult.ok) {
			warnings.push(
				`failed to delete worktree branch ${assignment.branchName}: ${deleteBranchResult.stderr || deleteBranchResult.stdout}`,
			);
		}
	}
	return warnings;
}

function extractIsolationTasks(input: ExecutionIsolationDecisionInput): ExecutionIsolationTaskInput[] {
	if (input.mode === "parallel") return input.tasks ?? [];
	if (input.mode === "chain") return input.chain ?? [];
	return input.single ? [input.single] : [];
}

function isWriteIntent(task: string): boolean {
	const normalized = task.toLowerCase();
	return WRITE_TASK_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function isLikelyReadOnlyIntent(task: string): boolean {
	const normalized = task.toLowerCase();
	const hasReadKeyword = READ_ONLY_TASK_KEYWORDS.some((keyword) => normalized.includes(keyword));
	const hasWriteKeyword = WRITE_TASK_KEYWORDS.some((keyword) => normalized.includes(keyword));
	return hasReadKeyword && !hasWriteKeyword;
}

function isWriteCapable(agentTools: string[] | undefined): boolean {
	if (!agentTools || agentTools.length === 0) return true;
	return agentTools.some((tool) => DIRECT_WRITE_TOOLS.includes(tool));
}

function sanitizeLabel(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return normalized || "task";
}

function runGit(cwd: string, args: string[], input?: string): GitResult {
	const result = spawnSync("git", args, {
		cwd,
		input,
		encoding: "utf8",
		maxBuffer: GIT_MAX_BUFFER_BYTES,
	});
	const exitCode = result.status ?? (result.error ? 1 : 0);
	return {
		ok: exitCode === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? result.error?.message ?? "",
		exitCode,
	};
}
