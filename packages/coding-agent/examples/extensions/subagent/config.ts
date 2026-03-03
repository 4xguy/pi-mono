import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { SubagentDelegationMode, WriteConflictPolicy } from "./types.js";

export interface SubagentRuntimeConfig {
	maxParallelTasks: number;
	maxConcurrency: number;
	collapsedItemCount: number;
	contentMaxChars: number;
	onWriteConflict: WriteConflictPolicy;
	taskTimeoutMs: number;
	cleanupWorktreesOnSuccess: boolean;
	keepFailedWorktrees: boolean;
	pruneWorktreesOnFinish: boolean;
	autoDelegationDefault: SubagentDelegationMode;
	confirmProjectAgents: boolean;
	artifactDir: string;
}

interface SubagentPartialConfig {
	maxParallelTasks?: number;
	maxConcurrency?: number;
	collapsedItemCount?: number;
	contentMaxChars?: number;
	onWriteConflict?: WriteConflictPolicy;
	taskTimeoutMs?: number;
	cleanupWorktreesOnSuccess?: boolean;
	keepFailedWorktrees?: boolean;
	pruneWorktreesOnFinish?: boolean;
	autoDelegationDefault?: SubagentDelegationMode;
	confirmProjectAgents?: boolean;
	artifactDir?: string;
}

const DEFAULT_CONFIG: SubagentRuntimeConfig = {
	maxParallelTasks: 8,
	maxConcurrency: 4,
	collapsedItemCount: 10,
	contentMaxChars: 1800,
	onWriteConflict: "serialize",
	taskTimeoutMs: 10 * 60_000,
	cleanupWorktreesOnSuccess: true,
	keepFailedWorktrees: true,
	pruneWorktreesOnFinish: true,
	autoDelegationDefault: "off",
	confirmProjectAgents: true,
	artifactDir: ".pi/subagent-runs",
};

function findNearestProjectConfig(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi", "subagents.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function readConfigFile(configPath: string | null): SubagentPartialConfig {
	if (!configPath || !fs.existsSync(configPath)) return {};
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			maxParallelTasks:
				typeof parsed.maxParallelTasks === "number" && Number.isFinite(parsed.maxParallelTasks)
					? parsed.maxParallelTasks
					: undefined,
			maxConcurrency:
				typeof parsed.maxConcurrency === "number" && Number.isFinite(parsed.maxConcurrency)
					? parsed.maxConcurrency
					: undefined,
			collapsedItemCount:
				typeof parsed.collapsedItemCount === "number" && Number.isFinite(parsed.collapsedItemCount)
					? parsed.collapsedItemCount
					: undefined,
			contentMaxChars:
				typeof parsed.contentMaxChars === "number" && Number.isFinite(parsed.contentMaxChars)
					? parsed.contentMaxChars
					: undefined,
			onWriteConflict:
				parsed.onWriteConflict === "fail" || parsed.onWriteConflict === "serialize"
					? parsed.onWriteConflict
					: undefined,
			taskTimeoutMs:
				typeof parsed.taskTimeoutMs === "number" && Number.isFinite(parsed.taskTimeoutMs)
					? parsed.taskTimeoutMs
					: undefined,
			cleanupWorktreesOnSuccess:
				typeof parsed.cleanupWorktreesOnSuccess === "boolean" ? parsed.cleanupWorktreesOnSuccess : undefined,
			keepFailedWorktrees: typeof parsed.keepFailedWorktrees === "boolean" ? parsed.keepFailedWorktrees : undefined,
			pruneWorktreesOnFinish:
				typeof parsed.pruneWorktreesOnFinish === "boolean" ? parsed.pruneWorktreesOnFinish : undefined,
			autoDelegationDefault:
				parsed.autoDelegationDefault === "off" ||
				parsed.autoDelegationDefault === "assist" ||
				parsed.autoDelegationDefault === "orchestrate"
					? parsed.autoDelegationDefault
					: undefined,
			confirmProjectAgents:
				typeof parsed.confirmProjectAgents === "boolean" ? parsed.confirmProjectAgents : undefined,
			artifactDir: typeof parsed.artifactDir === "string" ? parsed.artifactDir : undefined,
		};
	} catch {
		return {};
	}
}

function mergeConfig(base: SubagentRuntimeConfig, override: SubagentPartialConfig): SubagentRuntimeConfig {
	return {
		...base,
		...override,
	};
}

function sanitize(config: SubagentRuntimeConfig): SubagentRuntimeConfig {
	return {
		...config,
		maxParallelTasks: Math.max(1, Math.floor(config.maxParallelTasks)),
		maxConcurrency: Math.max(1, Math.floor(config.maxConcurrency)),
		collapsedItemCount: Math.max(1, Math.floor(config.collapsedItemCount)),
		contentMaxChars: Math.max(200, Math.floor(config.contentMaxChars)),
		taskTimeoutMs: Math.max(1000, Math.floor(config.taskTimeoutMs)),
	};
}

export function loadSubagentConfig(cwd: string): SubagentRuntimeConfig {
	const globalPath = path.join(getAgentDir(), "subagents.json");
	const projectPath = findNearestProjectConfig(cwd);
	const globalConfig = readConfigFile(globalPath);
	const projectConfig = readConfigFile(projectPath);
	return sanitize(mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig));
}
