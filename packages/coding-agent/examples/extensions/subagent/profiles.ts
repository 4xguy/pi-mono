import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentConfig } from "./agents.ts";
import { deriveIsolation, isWriteCapable, normalizeWritePaths } from "./policy.ts";
import type { DispatchDefaults, IsolationMode, ResolvedTaskExecution, SubagentTaskInput, TaskMode } from "./types.ts";

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

// Thinking level only inherits the parent session's dispatch default when the
// model itself is also inherited (`inheritsDispatchModel`): applying the
// parent's thinking level to a different, explicitly chosen model can be
// meaningless or invalid for that model.
function resolveThinking(
	agent: AgentConfig,
	input: SubagentTaskInput,
	dispatchDefaults: DispatchDefaults | undefined,
	inheritsDispatchModel: boolean,
): ThinkingLevel | undefined {
	const explicit = input.thinking ?? agent.thinking;
	if (explicit) return explicit;
	return inheritsDispatchModel ? dispatchDefaults?.thinkingLevel : undefined;
}

// Model falls back through three tiers: per-task override, per-agent config,
// then the parent session's active model (dispatchDefaults) so a subagent
// without an explicit model still inherits the caller's configuration instead
// of the CLI's own default. Preserves upstream's "inherit subagent session
// config" fix (#7897).
function resolveModel(
	agent: AgentConfig,
	input: SubagentTaskInput,
	dispatchDefaults: DispatchDefaults | undefined,
): string | undefined {
	return input.model ?? agent.model ?? dispatchDefaults?.model;
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
	dispatchDefaults?: DispatchDefaults,
): ResolvedTaskExecution {
	const mode = resolveMode(agent, input);
	const inheritsDispatchModel = !input.model && !agent.model;
	const model = resolveModel(agent, input, dispatchDefaults);
	const thinking = resolveThinking(agent, input, dispatchDefaults, inheritsDispatchModel);
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
