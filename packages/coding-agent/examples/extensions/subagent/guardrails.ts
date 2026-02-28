import { randomBytes } from "node:crypto";
import type { AgentConfig } from "./agents.js";
import type { SharedContextMode } from "./context-memory.js";

export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_MAX_TOTAL_AGENTS = 16;
export const DEFAULT_MAX_WALL_TIME_MS = 10 * 60 * 1000;

export const SUBAGENT_ENV_RUN_ID = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_ENV_DEPTH = "PI_SUBAGENT_DEPTH";
export const SUBAGENT_ENV_MAX_DEPTH = "PI_SUBAGENT_MAX_DEPTH";
export const SUBAGENT_ENV_ROOT_STARTED_AT = "PI_SUBAGENT_ROOT_STARTED_AT";
export const SUBAGENT_ENV_DEADLINE_AT = "PI_SUBAGENT_DEADLINE_AT";
export const SUBAGENT_ENV_REMAINING_TOKENS = "PI_SUBAGENT_REMAINING_TOKENS";
export const SUBAGENT_ENV_FINGERPRINTS = "PI_SUBAGENT_FINGERPRINTS";
export const SUBAGENT_ENV_CAN_SPAWN_CHILDREN = "PI_SUBAGENT_CAN_SPAWN_CHILDREN";
export const SUBAGENT_ENV_CONTEXT_MODE = "PI_SUBAGENT_CONTEXT_MODE";
export const SUBAGENT_ENV_CONTEXT_LIMIT = "PI_SUBAGENT_CONTEXT_LIMIT";
export const SUBAGENT_ENV_MEMORY_DIR = "PI_SUBAGENT_MEMORY_DIR";

export interface ExecutionBudget {
	runId: string;
	depth: number;
	maxDepth: number;
	rootStartedAtMs: number;
	deadlineAtMs: number;
	remainingTokens: number;
	fingerprints: Set<string>;
	canSpawnChildren: boolean;
}

export interface ChildProcessBudget {
	runId: string;
	nextDepth: number;
	maxDepth: number;
	rootStartedAtMs: number;
	deadlineAtMs: number;
	remainingTokens: number;
	fingerprints: string[];
	canSpawnChildren: boolean;
}

export interface GuardrailDefaults {
	maxDepth: number;
	maxTotalAgents: number;
	maxWallTimeMs: number;
}

export const DEFAULT_GUARDRAIL_DEFAULTS: GuardrailDefaults = {
	maxDepth: DEFAULT_MAX_DEPTH,
	maxTotalAgents: DEFAULT_MAX_TOTAL_AGENTS,
	maxWallTimeMs: DEFAULT_MAX_WALL_TIME_MS,
};

export function parseIntegerEnv(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseContextMode(value: string | undefined, fallback: SharedContextMode): SharedContextMode {
	if (value === "isolated" || value === "shared-read" || value === "shared-write") return value;
	return fallback;
}

export function parseFingerprintSet(value: string | undefined): Set<string> {
	if (!value) return new Set<string>();
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return new Set<string>();
		const out = new Set<string>();
		for (const item of parsed) {
			if (typeof item === "string" && item.trim().length > 0) out.add(item);
		}
		return out;
	} catch {
		return new Set<string>();
	}
}

export function normalizeTask(task: string): string {
	return task.replace(/\s+/g, " ").trim().toLowerCase();
}

export function makeFingerprint(agent: string, task: string): string {
	return `${agent.trim().toLowerCase()}::${normalizeTask(task)}`;
}

export function initializeExecutionBudget(
	env: NodeJS.ProcessEnv,
	nowMs: number,
	defaults: GuardrailDefaults = DEFAULT_GUARDRAIL_DEFAULTS,
): ExecutionBudget {
	const runId = env[SUBAGENT_ENV_RUN_ID] || randomBytes(8).toString("hex");
	const depth = Math.max(0, parseIntegerEnv(env[SUBAGENT_ENV_DEPTH], 0));
	const maxDepth = Math.max(0, parseIntegerEnv(env[SUBAGENT_ENV_MAX_DEPTH], defaults.maxDepth));
	const rootStartedAtMs = Math.max(0, parseIntegerEnv(env[SUBAGENT_ENV_ROOT_STARTED_AT], nowMs));
	const defaultDeadlineAtMs = rootStartedAtMs + defaults.maxWallTimeMs;
	const deadlineAtMs = Math.max(rootStartedAtMs, parseIntegerEnv(env[SUBAGENT_ENV_DEADLINE_AT], defaultDeadlineAtMs));
	const remainingTokens = Math.max(0, parseIntegerEnv(env[SUBAGENT_ENV_REMAINING_TOKENS], defaults.maxTotalAgents));
	const fingerprints = parseFingerprintSet(env[SUBAGENT_ENV_FINGERPRINTS]);
	const canSpawnChildren = env[SUBAGENT_ENV_CAN_SPAWN_CHILDREN] !== "0";
	return {
		runId,
		depth,
		maxDepth,
		rootStartedAtMs,
		deadlineAtMs,
		remainingTokens,
		fingerprints,
		canSpawnChildren,
	};
}

export function canNestAgent(agent: AgentConfig): boolean {
	return Boolean(agent.tools?.includes("subagent"));
}

export function reserveChildBudget(
	budget: ExecutionBudget,
	agentName: string,
	task: string,
	reservedDescendantTokens: number,
	allowNestedFromAgent: boolean,
): ChildProcessBudget {
	const fingerprint = makeFingerprint(agentName, task);
	if (budget.fingerprints.has(fingerprint)) {
		throw new Error(`Blocked recursive loop for ${agentName}: duplicate delegated task fingerprint.`);
	}
	const reserveTotal = 1 + Math.max(0, reservedDescendantTokens);
	if (budget.remainingTokens < reserveTotal) {
		throw new Error(
			`Subagent budget exceeded: requires ${reserveTotal} token(s), only ${budget.remainingTokens} remaining.`,
		);
	}
	budget.remainingTokens -= reserveTotal;
	budget.fingerprints.add(fingerprint);
	return {
		runId: budget.runId,
		nextDepth: budget.depth + 1,
		maxDepth: budget.maxDepth,
		rootStartedAtMs: budget.rootStartedAtMs,
		deadlineAtMs: budget.deadlineAtMs,
		remainingTokens: Math.max(0, reservedDescendantTokens),
		fingerprints: Array.from(budget.fingerprints),
		canSpawnChildren: allowNestedFromAgent,
	};
}
