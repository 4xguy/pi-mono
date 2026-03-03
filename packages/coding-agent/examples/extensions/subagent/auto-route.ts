import type { AgentScope } from "./agents.js";
import type { TopologyPolicy } from "./policy.js";

export interface AutoRouteCommandCompletion {
	value: string;
	label: string;
	description?: string;
}

export type ParsedAutoRouteCommand =
	| { kind: "status" }
	| { kind: "setAutoRoute"; enabled: boolean }
	| { kind: "setCoordinatorOnly"; enabled: boolean }
	| { kind: "setCoordinator"; coordinatorAgent: string }
	| { kind: "invalid"; message: string };

export interface AutoRouteConfig {
	autoRouteEnabled: boolean;
	coordinatorOnlyEnabled: boolean;
	coordinatorAgent: string;
}

export interface ResolveAutoRouteConfigInput {
	flagAutoRoute?: boolean;
	flagCoordinatorOnly?: boolean;
	flagCoordinatorAgent?: string;
	envAutoRoute?: string;
	envCoordinatorOnly?: string;
	envCoordinatorAgent?: string;
	defaultAutoRouteEnabled: boolean;
	defaultCoordinatorAgent: string;
}

export interface AutoRoutePromptDecision {
	shouldInject: boolean;
	warnMissingCoordinator: boolean;
}

export interface AutoRoutePromptDecisionInput {
	config: AutoRouteConfig;
	prompt: string;
	depth: number;
	hasCoordinator: boolean;
}

export interface AutoRouteDirectiveConfig {
	coordinatorAgent: string;
	agentScope: AgentScope;
	contextMode: "shared-read" | "shared-write";
	sharedContextLimit: number;
	topologyPolicy: TopologyPolicy;
}

export function resolveAutoRouteConfig(input: ResolveAutoRouteConfigInput): AutoRouteConfig {
	const autoRouteEnabled = input.flagAutoRoute ?? parseBooleanEnv(input.envAutoRoute) ?? input.defaultAutoRouteEnabled;
	const coordinatorOnlyEnabled =
		input.flagCoordinatorOnly ?? parseBooleanEnv(input.envCoordinatorOnly) ?? autoRouteEnabled;
	const coordinatorAgent =
		normalizeAgentName(input.flagCoordinatorAgent) ??
		normalizeAgentName(input.envCoordinatorAgent) ??
		input.defaultCoordinatorAgent;

	return {
		autoRouteEnabled,
		coordinatorOnlyEnabled: coordinatorOnlyEnabled || autoRouteEnabled,
		coordinatorAgent,
	};
}

export function shouldInjectAutoRoutePrompt(input: AutoRoutePromptDecisionInput): AutoRoutePromptDecision {
	if (!input.config.autoRouteEnabled && !input.config.coordinatorOnlyEnabled) {
		return { shouldInject: false, warnMissingCoordinator: false };
	}
	if (input.depth > 0) {
		return { shouldInject: false, warnMissingCoordinator: false };
	}
	const prompt = input.prompt.trim();
	if (prompt.length === 0 || prompt.startsWith("/") || prompt.startsWith("!")) {
		return { shouldInject: false, warnMissingCoordinator: false };
	}
	if (!input.hasCoordinator) {
		return { shouldInject: false, warnMissingCoordinator: true };
	}
	return { shouldInject: true, warnMissingCoordinator: false };
}

export function buildAutoRouteDirective(config: AutoRouteDirectiveConfig): string {
	return [
		"AUTO-ROUTE COORDINATOR MODE (ROOT ONLY):",
		"- You must not execute coding work directly.",
		"- Delegate by calling the subagent tool exactly once.",
		`- Use single mode with agent "${config.coordinatorAgent}".`,
		"- Pass the user prompt as-is in the subagent task.",
		"- Always set:",
		`  - agentScope: "${config.agentScope}"`,
		"  - confirmProjectAgents: false",
		`  - contextMode: "${config.contextMode}"`,
		`  - sharedContextLimit: ${config.sharedContextLimit}`,
		`  - topologyPolicy: "${config.topologyPolicy}"`,
		"- If delegation fails (missing tool/agent or budget), continue safely in direct mode and note fallback.",
		"- Return only the delegated tool result when delegation succeeds.",
	].join("\n");
}

export const AUTO_ROUTE_COMMAND_USAGE = "Usage: /subagent-auto on|off|coordinator <agent>|coordinator-only on|off";

export function parseAutoRouteCommandArguments(args: string): ParsedAutoRouteCommand {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return { kind: "status" };
	}

	const [actionRaw, ...restTokens] = trimmed.split(/\s+/);
	const action = actionRaw?.toLowerCase() ?? "";

	if (action === "on") {
		return { kind: "setAutoRoute", enabled: true };
	}
	if (action === "off") {
		return { kind: "setAutoRoute", enabled: false };
	}
	if (action === "coordinator") {
		const coordinatorAgent = normalizeAgentName(restTokens.join(" "));
		if (!coordinatorAgent) {
			return { kind: "invalid", message: `${AUTO_ROUTE_COMMAND_USAGE}. Missing coordinator agent name.` };
		}
		return { kind: "setCoordinator", coordinatorAgent };
	}
	if (action === "coordinator-only") {
		const toggle = restTokens[0]?.toLowerCase();
		if (toggle === "on") {
			return { kind: "setCoordinatorOnly", enabled: true };
		}
		if (toggle === "off") {
			return { kind: "setCoordinatorOnly", enabled: false };
		}
		return {
			kind: "invalid",
			message: `${AUTO_ROUTE_COMMAND_USAGE}. Expected 'on' or 'off' after coordinator-only.`,
		};
	}

	return { kind: "invalid", message: AUTO_ROUTE_COMMAND_USAGE };
}

export function getAutoRouteCommandCompletions(
	argumentPrefix: string,
	coordinatorAgent: string,
): AutoRouteCommandCompletion[] | null {
	const normalizedPrefix = argumentPrefix.trimStart();
	const normalizedLower = normalizedPrefix.toLowerCase();
	const normalizedCoordinatorAgent = normalizeAgentName(coordinatorAgent) ?? "coordinator";

	const options: AutoRouteCommandCompletion[] = [
		{ value: "on", label: "on", description: "Enable root auto-route delegation" },
		{ value: "off", label: "off", description: "Disable auto-route (manual delegation mode)" },
		{
			value: "coordinator-only on",
			label: "coordinator-only on",
			description: "Force coordinator-only root behavior",
		},
		{
			value: "coordinator-only off",
			label: "coordinator-only off",
			description: "Allow non-coordinator root behavior when route is off",
		},
		{
			value: `coordinator ${normalizedCoordinatorAgent}`,
			label: `coordinator ${normalizedCoordinatorAgent}`,
			description: "Set coordinator agent name",
		},
	];

	if (normalizedLower.length === 0) {
		return options;
	}

	if (normalizedLower.startsWith("coordinator-only")) {
		const coordinatorOnlyOptions = options.filter((option) => option.value.startsWith("coordinator-only "));
		const filtered = coordinatorOnlyOptions.filter((option) =>
			option.value.toLowerCase().startsWith(normalizedLower),
		);
		return filtered.length > 0 ? filtered : coordinatorOnlyOptions;
	}

	if (normalizedLower.startsWith("coordinator")) {
		const coordinatorOptions = options.filter((option) => option.value.startsWith("coordinator "));
		const filtered = coordinatorOptions.filter((option) => option.value.toLowerCase().startsWith(normalizedLower));
		return filtered.length > 0 ? filtered : coordinatorOptions;
	}

	const filtered = options.filter((option) => option.value.toLowerCase().startsWith(normalizedLower));
	return filtered.length > 0 ? filtered : null;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	if (value === "1" || value.toLowerCase() === "true") return true;
	if (value === "0" || value.toLowerCase() === "false") return false;
	return undefined;
}

function normalizeAgentName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}
