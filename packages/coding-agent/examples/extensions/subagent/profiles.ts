import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentConfig } from "./agents.js";
import { deriveIsolation, isWriteCapable, normalizeWritePaths } from "./policy.js";
import type { IsolationMode, ResolvedTaskExecution, SubagentTaskInput, TaskMode } from "./types.js";

function normalizeTools(tools: string[] | undefined): string[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	const normalized = tools.map((tool) => tool.trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

function subtractDisallowedTools(tools: string[] | undefined, disallowed: string[] | undefined): string[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	if (!disallowed || disallowed.length === 0) return tools;
	const blocked = new Set(disallowed.map((tool) => tool.toLowerCase()));
	const filtered = tools.filter((tool) => !blocked.has(tool.toLowerCase()));
	return filtered.length > 0 ? filtered : undefined;
}

function resolveMode(agent: AgentConfig, input: SubagentTaskInput): TaskMode {
	return input.mode ?? agent.mode ?? "auto";
}

function resolveThinking(agent: AgentConfig, input: SubagentTaskInput): ThinkingLevel | undefined {
	return input.thinking ?? agent.thinking;
}

function resolveModel(agent: AgentConfig, input: SubagentTaskInput): string | undefined {
	return input.model ?? agent.model;
}

function resolveTools(agent: AgentConfig, input: SubagentTaskInput): string[] | undefined {
	const requestedTools = normalizeTools(input.tools) ?? normalizeTools(agent.tools);
	const disallowed = normalizeTools(agent.disallowedTools);
	return subtractDisallowedTools(requestedTools, disallowed);
}

function resolveIsolation(
	agent: AgentConfig,
	mode: TaskMode,
	isWriteTask: boolean,
	inputIsolation: IsolationMode | undefined,
): IsolationMode {
	if (inputIsolation) return inputIsolation;
	return deriveIsolation(mode, isWriteTask, agent.isolation);
}

export function resolveTaskExecution(
	index: number,
	agent: AgentConfig,
	input: SubagentTaskInput,
	defaultCwd: string,
): ResolvedTaskExecution {
	const mode = resolveMode(agent, input);
	const model = resolveModel(agent, input);
	const thinking = resolveThinking(agent, input);
	const tools = resolveTools(agent, input);
	const isWriteTask = isWriteCapable(mode, tools);
	const isolation = resolveIsolation(agent, mode, isWriteTask, input.isolation);
	const writePaths = normalizeWritePaths(input.writePaths ?? agent.writePaths);

	return {
		index,
		input,
		agent,
		cwd: input.cwd ?? defaultCwd,
		model,
		thinking,
		tools,
		mode,
		writePaths,
		isWriteTask,
		isolation,
		timeoutMs: input.timeoutMs ?? agent.timeoutMs,
	};
}
