import type { AgentToolResult, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig, AgentScope } from "./agents.js";

export type SubagentExecutionMode = "single" | "parallel" | "chain";
export type TaskMode = "read" | "write" | "auto";
export type IsolationMode = "none" | "worktree";
export type WriteConflictPolicy = "serialize" | "fail";
export type SubagentDelegationMode = "off" | "assist" | "orchestrate";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	index?: number;
	isWriteTask?: boolean;
	writePaths?: string[];
	isolation?: IsolationMode;
	worktreePath?: string;
	patchBytes?: number;
	patchApplied?: boolean;
	integrationError?: string;
	retried?: boolean;
}

export interface SubagentDetails {
	mode: SubagentExecutionMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	policy: {
		onWriteConflict: WriteConflictPolicy;
	};
	artifactsPath?: string;
}

export type SubagentToolResult = AgentToolResult<SubagentDetails>;

export interface SubagentTaskInput {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	mode?: TaskMode;
	writePaths?: string[];
	isolation?: IsolationMode;
	timeoutMs?: number;
}

export interface ResolvedTaskExecution {
	index: number;
	input: SubagentTaskInput;
	agent: AgentConfig;
	cwd: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	mode: TaskMode;
	writePaths?: string[];
	isWriteTask: boolean;
	isolation: IsolationMode;
	timeoutMs?: number;
}

export interface SchedulerTask {
	index: number;
	isWriteTask: boolean;
	writePaths?: string[];
	isolation: IsolationMode;
}

export interface SchedulerWave {
	taskIndexes: number[];
}

export interface SchedulerResult {
	waves: SchedulerWave[];
	conflicts: Array<{ a: number; b: number }>;
}

export interface WorktreeHandle {
	repoRoot: string;
	path: string;
	branch: string;
	baseRef: string;
}

export interface TaskExecutionArtifacts {
	result: SingleResult;
	patch?: string;
	worktree?: WorktreeHandle;
}
