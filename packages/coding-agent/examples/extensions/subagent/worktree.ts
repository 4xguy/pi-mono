import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { WorktreeHandle } from "./types.js";

const execFileAsync = promisify(execFile);

export interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

export async function runCommand(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<CommandResult> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 50 * 1024 * 1024,
		});
		return {
			ok: true,
			stdout: String(stdout),
			stderr: String(stderr),
			exitCode: 0,
		};
	} catch (error) {
		const err = error as NodeJS.ErrnoException & {
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			code?: string | number;
		};
		return {
			ok: false,
			stdout:
				typeof err.stdout === "string"
					? err.stdout
					: err.stdout instanceof Buffer
						? err.stdout.toString("utf-8")
						: "",
			stderr:
				typeof err.stderr === "string"
					? err.stderr
					: err.stderr instanceof Buffer
						? err.stderr.toString("utf-8")
						: err.message,
			exitCode: typeof err.code === "number" ? err.code : 1,
		};
	}
}

export async function detectGitRepoRoot(cwd: string, timeoutMs: number): Promise<string | null> {
	const result = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd, timeoutMs);
	if (!result.ok) return null;
	const root = result.stdout.trim();
	return root.length > 0 ? root : null;
}

function createTempWorktreePath(): string {
	const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
	return path.join(os.tmpdir(), `pi-subagent-worktree-${unique}`);
}

function createTempBranchName(): string {
	const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
	return `pi-subagent/${unique}`;
}

export async function createWorktree(
	repoRoot: string,
	timeoutMs: number,
): Promise<{ handle?: WorktreeHandle; error?: string }> {
	const worktreePath = createTempWorktreePath();
	const branch = createTempBranchName();
	const baseRef = "HEAD";

	const addResult = await runCommand(
		"git",
		["worktree", "add", "--detach", worktreePath, baseRef],
		repoRoot,
		timeoutMs,
	);
	if (!addResult.ok) {
		return { error: addResult.stderr || addResult.stdout || "Failed to create worktree" };
	}

	const branchResult = await runCommand("git", ["checkout", "-b", branch], worktreePath, timeoutMs);
	if (!branchResult.ok) {
		await removeWorktree(repoRoot, worktreePath, timeoutMs);
		return { error: branchResult.stderr || branchResult.stdout || "Failed to create worktree branch" };
	}

	return {
		handle: {
			repoRoot,
			path: worktreePath,
			branch,
			baseRef,
		},
	};
}

export async function getWorktreePatch(
	worktreePath: string,
	timeoutMs: number,
): Promise<{ patch: string; error?: string }> {
	const result = await runCommand("git", ["diff", "--binary"], worktreePath, timeoutMs);
	if (!result.ok) {
		return { patch: "", error: result.stderr || result.stdout || "Failed to generate patch" };
	}
	return { patch: result.stdout };
}

export async function hasWorktreeChanges(worktreePath: string, timeoutMs: number): Promise<boolean> {
	const result = await runCommand("git", ["status", "--porcelain"], worktreePath, timeoutMs);
	if (!result.ok) return false;
	return result.stdout.trim().length > 0;
}

export async function removeWorktree(repoRoot: string, worktreePath: string, timeoutMs: number): Promise<void> {
	await runCommand("git", ["worktree", "remove", "--force", worktreePath], repoRoot, timeoutMs);
	if (fs.existsSync(worktreePath)) {
		try {
			fs.rmSync(worktreePath, { recursive: true, force: true });
		} catch {
			// ignore cleanup failure
		}
	}
}

export async function pruneWorktrees(repoRoot: string, timeoutMs: number): Promise<void> {
	await runCommand("git", ["worktree", "prune"], repoRoot, timeoutMs);
}
