/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, getEditorKeybindings, Key, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import {
	AUTO_ROUTE_COMMAND_USAGE,
	buildAutoRouteDirective,
	getAutoRouteCommandCompletions,
	parseAutoRouteCommandArguments,
	resolveAutoRouteConfig,
	shouldInjectAutoRoutePrompt,
} from "./auto-route.js";
import {
	buildSharedContextPacket,
	createSharedContextStore,
	createTaskId,
	type SharedContextMode,
	type TaskHandoffEnvelope,
} from "./context-memory.js";
import {
	type CoordinatorInspectorState,
	normalizeCoordinatorInspectorState,
	reduceCoordinatorInspectorState,
} from "./coordinator-inspector-state.js";
import { COMPLETION_STATUS_WINDOW_MS, CoordinatorMonitor, type CoordinatorRunState } from "./coordinator-monitor.js";
import {
	type ChildProcessBudget,
	canNestAgent,
	DEFAULT_MAX_DEPTH,
	DEFAULT_MAX_TOTAL_AGENTS,
	DEFAULT_MAX_WALL_TIME_MS,
	initializeExecutionBudget,
	parseContextMode,
	parseIntegerEnv,
	reserveChildBudget,
	SUBAGENT_ENV_CAN_SPAWN_CHILDREN,
	SUBAGENT_ENV_CONTEXT_LIMIT,
	SUBAGENT_ENV_CONTEXT_MODE,
	SUBAGENT_ENV_DEADLINE_AT,
	SUBAGENT_ENV_DEPTH,
	SUBAGENT_ENV_FINGERPRINTS,
	SUBAGENT_ENV_MAX_DEPTH,
	SUBAGENT_ENV_MEMORY_DIR,
	SUBAGENT_ENV_REMAINING_TOKENS,
	SUBAGENT_ENV_ROOT_STARTED_AT,
	SUBAGENT_ENV_RUN_ID,
} from "./guardrails.js";
import {
	applySmokeResults,
	createPhaseGateState,
	formatPhaseGateSummary,
	markSmokeSkipped,
	type PhaseGateState,
	recordSmokeFixAttempt,
	type SmokeCommandResult,
	validatePhaseGateState,
} from "./phase-gates.js";
import {
	buildExecutionPlan,
	buildTopologyDecision,
	type ExecutionTaskItem,
	parseTopologyPolicy,
	type TopologyDecision,
	type TopologyMode,
	type TopologyPolicy,
} from "./policy.js";
import {
	cleanupWorktreeSession,
	createWorktreeAssignment,
	createWorktreeSession,
	decideExecutionIsolation,
	type ExecutionIsolation,
	integrateWorktreeAssignments,
	parseExecutionIsolation,
	type ResolvedExecutionIsolation,
	resolveWorktreeTaskCwd,
	type WorktreeAssignment,
	type WorktreeIntegrationReport,
	type WorktreeSession,
} from "./worktree.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MAX_DEPTH = DEFAULT_MAX_DEPTH;
const MAX_TOTAL_AGENTS = DEFAULT_MAX_TOTAL_AGENTS;
const MAX_WALL_TIME_MS = DEFAULT_MAX_WALL_TIME_MS;
const DEFAULT_TOPOLOGY_POLICY = "auto" as const;
const DEFAULT_COORDINATOR_AGENT = "coordinator";
const DEFAULT_AUTO_ROUTE_SCOPE: AgentScope = "project";
const DEFAULT_AUTO_ROUTE_CONTEXT_MODE: "shared-read" = "shared-read";
const DEFAULT_AUTO_ROUTE_CONTEXT_LIMIT = 8;
const DEFAULT_AUTO_ROUTE_ENABLED = false;
const SUBAGENT_ENV_AUTO_ROUTE = "SUBAGENT_AUTO_ROUTE";
const SUBAGENT_ENV_COORDINATOR_ONLY = "SUBAGENT_COORDINATOR_ONLY";
const SUBAGENT_ENV_COORDINATOR_AGENT = "SUBAGENT_COORDINATOR_AGENT";
const SUBAGENT_ENV_TOPOLOGY_POLICY = "SUBAGENT_TOPOLOGY_POLICY";
const SUBAGENT_ENV_EXECUTION_ISOLATION = "SUBAGENT_EXECUTION_ISOLATION";
const SUBAGENT_ENV_WORKTREE_BASE_DIR = "SUBAGENT_WORKTREE_BASE_DIR";

interface SharedContextConfig {
	mode: SharedContextMode;
	limit: number;
	memoryDir?: string;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function createBudgetError(
	message: string,
	makeDetails: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
	mode: "single" | "parallel" | "chain",
): AgentToolResult<SubagentDetails> {
	return {
		content: [{ type: "text", text: message }],
		details: makeDetails(mode)([]),
	};
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
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
}

interface WorktreeExecutionDetails {
	requestedIsolation: ExecutionIsolation;
	activeIsolation: ResolvedExecutionIsolation;
	repoRoot?: string;
	baseDir?: string;
	assignments: number;
	reports: WorktreeIntegrationReport[];
	warnings: string[];
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	topologyDecision?: TopologyDecision;
	phaseGate?: PhaseGateState;
	worktree?: WorktreeExecutionDetails;
	results: SingleResult[];
}

class CoordinatorInspectorComponent implements Component {
	private state: CoordinatorInspectorState = {
		selectedCoordinator: 0,
		selectedAgent: 0,
		showAgentDetails: false,
	};

	constructor(
		private readonly runsProvider: () => CoordinatorRunState[],
		private readonly theme: Theme,
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(data, "selectCancel")) {
			this.done();
			return;
		}

		const runs = this.runsProvider();
		if (runs.length === 0) {
			if (kb.matches(data, "selectConfirm") || kb.matches(data, "tab")) this.done();
			return;
		}

		this.state = normalizeCoordinatorInspectorState(this.state, runs);
		if (kb.matches(data, "cursorLeft")) {
			this.state = reduceCoordinatorInspectorState(this.state, runs, "left");
			return;
		}
		if (kb.matches(data, "cursorRight")) {
			this.state = reduceCoordinatorInspectorState(this.state, runs, "right");
			return;
		}
		if (kb.matches(data, "selectUp")) {
			this.state = reduceCoordinatorInspectorState(this.state, runs, "up");
			return;
		}
		if (kb.matches(data, "selectDown")) {
			this.state = reduceCoordinatorInspectorState(this.state, runs, "down");
			return;
		}
		if (kb.matches(data, "selectConfirm") || kb.matches(data, "tab")) {
			this.state = reduceCoordinatorInspectorState(this.state, runs, "toggleDetails");
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const runs = this.runsProvider();
		const lines: string[] = [];

		lines.push(th.fg("accent", th.bold("Subagent Coordinators")));

		if (runs.length === 0) {
			lines.push(th.fg("dim", "No coordinator runs yet."));
			lines.push(th.fg("dim", "Esc to close"));
			return lines;
		}

		this.state = normalizeCoordinatorInspectorState(this.state, runs);
		const run = runs[this.state.selectedCoordinator];

		const coordinatorSummary = runs
			.map((item, index) => {
				const token = `c${item.id}:a${item.agentsTotal}${item.parallelRunning > 0 ? `:p${item.parallelRunning}` : ""}`;
				return index === this.state.selectedCoordinator ? th.fg("accent", `[${token}]`) : th.fg("dim", token);
			})
			.join(th.fg("muted", " | "));

		lines.push(coordinatorSummary.slice(0, width));
		lines.push(
			th.fg("dim", `mode:${run.mode} phase:${run.phase} run:${run.runId.slice(0, 8)} agents:${run.agentsTotal}`),
		);
		if (run.currentStep) lines.push(th.fg("dim", `step:${run.currentStep}`));
		if (run.error) lines.push(th.fg("error", `error: ${run.error.slice(0, width - 7)}`));
		if (run.governance) {
			lines.push(
				th.fg(
					"dim",
					`gates:${run.governance.gateSummary} smokeAttempts:${run.governance.smokeAttempts} fix:${run.governance.smokeFixAttempts}/${run.governance.smokeMaxFixAttempts}`,
				),
			);
			if (run.governance.remediation.length > 0) {
				lines.push(th.fg("muted", "Remediation:"));
				for (const entry of run.governance.remediation.slice(-3)) {
					const marker = entry.outcome === "success" ? th.fg("success", "ok") : th.fg("error", "fail");
					lines.push(th.fg("dim", `  #${entry.attempt} ${entry.agent} ${marker} ${entry.summary.slice(0, 70)}`));
				}
			}
		}
		lines.push("");
		lines.push(th.fg("muted", "Agents:"));

		for (let i = 0; i < run.agents.length; i++) {
			const agent = run.agents[i];
			const marker = i === this.state.selectedAgent ? th.fg("accent", "▶") : th.fg("dim", " ");
			const statusColor = agent.status === "error" ? "error" : agent.status === "done" ? "success" : "dim";
			const stepPrefix = agent.step ? `${agent.step}.` : `${i + 1}.`;
			const preview = agent.task.length > 58 ? `${agent.task.slice(0, 58)}...` : agent.task;
			lines.push(
				`${marker} ${th.fg("muted", stepPrefix)} ${th.fg("accent", agent.agent)} ${th.fg(statusColor, agent.status)} ${th.fg("dim", preview)}`,
			);
		}

		if (this.state.showAgentDetails && run.agents.length > 0) {
			const agent = run.agents[this.state.selectedAgent];
			lines.push("");
			lines.push(th.fg("muted", "Selected agent details:"));
			lines.push(th.fg("accent", `${agent.agent} (${agent.status})`));
			lines.push(th.fg("dim", agent.task));
			if (agent.error) lines.push(th.fg("error", agent.error));
		}

		lines.push("");
		lines.push(th.fg("dim", "Left/Right: coordinator  Up/Down: agent  Enter/Tab: details  Esc: close"));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function runSmokeCommand(
	command: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<SmokeCommandResult> {
	const startedAt = Date.now();
	return new Promise<SmokeCommandResult>((resolve) => {
		const proc = spawn(command, {
			cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		let wasAborted = false;
		let abortHandler: (() => void) | null = null;

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			resolve({
				command,
				exitCode: wasAborted ? 130 : (code ?? 1),
				stdout,
				stderr,
				durationMs: Date.now() - startedAt,
			});
		});

		proc.on("error", (error) => {
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			resolve({
				command,
				exitCode: 1,
				stdout,
				stderr: `${stderr}${error.message}`,
				durationMs: Date.now() - startedAt,
			});
		});

		if (signal) {
			abortHandler = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 3000);
			};
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
		}
	});
}

async function runSmokeCommands(
	commands: string[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<SmokeCommandResult[]> {
	const results: SmokeCommandResult[] = [];
	for (const command of commands) {
		const result = await runSmokeCommand(command, cwd, signal);
		results.push(result);
		if (result.exitCode !== 0) break;
	}
	return results;
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	executionTask: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	childBudget: ChildProcessBudget,
	sharedContextConfig: SharedContextConfig,
	executionIsolation: ResolvedExecutionIsolation,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		[SUBAGENT_ENV_RUN_ID]: childBudget.runId,
		[SUBAGENT_ENV_DEPTH]: String(childBudget.nextDepth),
		[SUBAGENT_ENV_MAX_DEPTH]: String(childBudget.maxDepth),
		[SUBAGENT_ENV_ROOT_STARTED_AT]: String(childBudget.rootStartedAtMs),
		[SUBAGENT_ENV_DEADLINE_AT]: String(childBudget.deadlineAtMs),
		[SUBAGENT_ENV_REMAINING_TOKENS]: String(childBudget.remainingTokens),
		[SUBAGENT_ENV_FINGERPRINTS]: JSON.stringify(childBudget.fingerprints),
		[SUBAGENT_ENV_CAN_SPAWN_CHILDREN]: childBudget.canSpawnChildren ? "1" : "0",
		[SUBAGENT_ENV_CONTEXT_MODE]: sharedContextConfig.mode,
		[SUBAGENT_ENV_CONTEXT_LIMIT]: String(sharedContextConfig.limit),
		[SUBAGENT_ENV_MEMORY_DIR]: sharedContextConfig.memoryDir,
		[SUBAGENT_ENV_EXECUTION_ISOLATION]: executionIsolation,
	};

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${executionTask}`);
		let wasAborted = false;
		let wasTimedOut = false;

		const exitCode = await new Promise<number>((resolve) => {
			const remainingMs = childBudget.deadlineAtMs - Date.now();
			if (remainingMs <= 0) {
				currentResult.stderr += "Subagent budget exceeded: wall-time deadline reached before launch.";
				resolve(1);
				return;
			}

			const proc = spawn("pi", args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			let buffer = "";
			let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
				wasTimedOut = true;
				currentResult.stderr += `Subagent timed out after ${remainingMs}ms (shared wall-time budget).`;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			}, remainingMs);

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			let abortHandler: (() => void) | null = null;

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
					timeoutHandle = null;
				}
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
					timeoutHandle = null;
				}
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
				resolve(1);
			});

			if (signal) {
				abortHandler = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasTimedOut) {
			currentResult.stopReason = "error";
			if (!currentResult.errorMessage) currentResult.errorMessage = "Subagent wall-time budget exceeded.";
		}
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const ContextModeSchema = StringEnum(["isolated", "shared-read", "shared-write"] as const, {
	description:
		'Context behavior across subagents. "isolated" disables shared ledger context, "shared-read" includes recent ledger context, and "shared-write" also allows explicit coordinator decisions.',
	default: "shared-read",
});

const TopologyPolicySchema = StringEnum(["advisory", "auto"] as const, {
	description: 'Topology policy behavior. "advisory" keeps requested mode, "auto" applies safe policy routing.',
	default: "auto",
});

const ExecutionIsolationSchema = StringEnum(["auto", "shared", "worktree"] as const, {
	description:
		'Execution isolation mode. "auto" chooses by topology/task intent, "shared" uses current worktree, "worktree" uses git worktree per execution lane.',
	default: "auto",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	contextMode: Type.Optional(ContextModeSchema),
	executionIsolation: Type.Optional(ExecutionIsolationSchema),
	topologyPolicy: Type.Optional(TopologyPolicySchema),
	sharedContextLimit: Type.Optional(
		Type.Integer({
			description: "How many recent shared-context ledger entries to include in each handoff packet. Default: 12.",
			minimum: 1,
			maximum: 50,
			default: 12,
		}),
	),
	memoryDir: Type.Optional(
		Type.String({
			description: "Optional base directory for shared context ledgers. Defaults to <cwd>/.pi/subagent-memory/runs.",
		}),
	),
	worktreeBaseDir: Type.Optional(
		Type.String({
			description: "Optional base directory for git worktree isolation. Defaults to <repo>/.pi/worktrees.",
		}),
	),
	phaseName: Type.Optional(Type.String({ description: "Optional phase label for policy logging and phase gates." })),
	requirePhaseSmoke: Type.Optional(
		Type.Boolean({ description: "Require phase smoke commands to pass before completion.", default: false }),
	),
	phaseSmokeCommands: Type.Optional(
		Type.Array(Type.String(), {
			description: "Shell commands to run as phase smoke gate checks (executed in cwd).",
		}),
	),
	phaseSmokeRetries: Type.Optional(
		Type.Integer({
			description: "Number of automatic retries for flaky smoke failures. Default: 1.",
			minimum: 0,
			maximum: 5,
			default: 1,
		}),
	),
	phaseMaxFixAttempts: Type.Optional(
		Type.Integer({
			description: "Maximum bounded gate-fix attempts after smoke failure. Default: 2.",
			minimum: 0,
			maximum: 5,
			default: 2,
		}),
	),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const coordinatorMonitor = new CoordinatorMonitor();
	let statusRefreshTimeout: NodeJS.Timeout | undefined;
	let autoRouteConfig = resolveAutoRouteConfig({
		defaultAutoRouteEnabled: DEFAULT_AUTO_ROUTE_ENABLED,
		defaultCoordinatorAgent: DEFAULT_COORDINATOR_AGENT,
	});
	let autoRouteWarnedMissingCoordinator = false;

	const updateCoordinatorStatus = (ctx: ExtensionContext) => {
		const summary = coordinatorMonitor.formatStatusSummary();
		ctx.ui.setStatus("subagents", summary ? ctx.ui.theme.fg("accent", summary) : undefined);

		const routeLabel = autoRouteConfig.autoRouteEnabled ? "on" : "off";
		const coordinatorOnlyLabel = autoRouteConfig.coordinatorOnlyEnabled ? "on" : "off";
		const autoStatusText =
			autoRouteConfig.autoRouteEnabled || autoRouteConfig.coordinatorOnlyEnabled
				? `subauto:${routeLabel} co:${coordinatorOnlyLabel}`
				: `subauto:${routeLabel}`;
		const autoStatusColor = autoRouteConfig.autoRouteEnabled ? "warning" : "dim";
		ctx.ui.setStatus("subagent-auto", ctx.ui.theme.fg(autoStatusColor, autoStatusText));
	};

	const scheduleCompletionStatusClear = (ctx: ExtensionContext) => {
		if (statusRefreshTimeout) clearTimeout(statusRefreshTimeout);
		statusRefreshTimeout = setTimeout(() => {
			statusRefreshTimeout = undefined;
			updateCoordinatorStatus(ctx);
		}, COMPLETION_STATUS_WINDOW_MS + 150);
	};

	const showCoordinatorInspector = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		await ctx.ui.custom<void>(
			(_tui, theme, _keybindings, done) => {
				return new CoordinatorInspectorComponent(
					() => coordinatorMonitor.getRuns(),
					theme,
					() => done(undefined),
				);
			},
			{ overlay: true },
		);
	};

	const refreshAutoRouteConfig = () => {
		autoRouteConfig = resolveAutoRouteConfig({
			flagAutoRoute: pi.getFlag("subagent-auto-route") as boolean | undefined,
			flagCoordinatorOnly: pi.getFlag("subagent-coordinator-only") as boolean | undefined,
			flagCoordinatorAgent: pi.getFlag("subagent-coordinator-agent") as string | undefined,
			envAutoRoute: process.env[SUBAGENT_ENV_AUTO_ROUTE],
			envCoordinatorOnly: process.env[SUBAGENT_ENV_COORDINATOR_ONLY],
			envCoordinatorAgent: process.env[SUBAGENT_ENV_COORDINATOR_AGENT],
			defaultAutoRouteEnabled: DEFAULT_AUTO_ROUTE_ENABLED,
			defaultCoordinatorAgent: DEFAULT_COORDINATOR_AGENT,
		});
	};

	pi.registerFlag("subagent-auto-route", {
		description: "Automatically route root prompts through the coordinator via subagent tool",
		type: "boolean",
		default: DEFAULT_AUTO_ROUTE_ENABLED,
	});
	pi.registerFlag("subagent-coordinator-only", {
		description: "Force coordinator-only root behavior (delegate, do not execute direct coding actions)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("subagent-coordinator-agent", {
		description: `Coordinator agent name used for auto route (default: ${DEFAULT_COORDINATOR_AGENT})`,
		type: "string",
		default: DEFAULT_COORDINATOR_AGENT,
	});

	pi.registerCommand("subagent-auto", {
		description: `${AUTO_ROUTE_COMMAND_USAGE}. Toggle or inspect subagent auto-route mode.`,
		getArgumentCompletions: (argumentPrefix) =>
			getAutoRouteCommandCompletions(argumentPrefix, autoRouteConfig.coordinatorAgent),
		handler: async (args, ctx) => {
			const parsed = parseAutoRouteCommandArguments(args);
			if (parsed.kind === "invalid") {
				ctx.ui.notify(parsed.message, "error");
				ctx.ui.notify(AUTO_ROUTE_COMMAND_USAGE, "info");
				updateCoordinatorStatus(ctx);
				return;
			}

			switch (parsed.kind) {
				case "setAutoRoute":
					autoRouteConfig = {
						...autoRouteConfig,
						autoRouteEnabled: parsed.enabled,
						coordinatorOnlyEnabled: parsed.enabled,
					};
					break;
				case "setCoordinator":
					autoRouteConfig = {
						...autoRouteConfig,
						coordinatorAgent: parsed.coordinatorAgent,
					};
					break;
				case "setCoordinatorOnly":
					autoRouteConfig = {
						...autoRouteConfig,
						coordinatorOnlyEnabled: parsed.enabled || autoRouteConfig.autoRouteEnabled,
					};
					break;
				case "status":
					refreshAutoRouteConfig();
					break;
			}

			ctx.ui.notify(
				`subagent-auto route:${autoRouteConfig.autoRouteEnabled ? "on" : "off"} coordinatorOnly:${autoRouteConfig.coordinatorOnlyEnabled ? "on" : "off"} coordinator:${autoRouteConfig.coordinatorAgent}`,
				"info",
			);
			updateCoordinatorStatus(ctx);
		},
	});

	pi.registerCommand("agents", {
		description: "Open coordinator/agent inspector",
		handler: async (_args, ctx) => {
			await showCoordinatorInspector(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Open coordinator/agent inspector",
		handler: async (ctx) => {
			await showCoordinatorInspector(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		coordinatorMonitor.reset();
		refreshAutoRouteConfig();
		autoRouteWarnedMissingCoordinator = false;
		if (statusRefreshTimeout) {
			clearTimeout(statusRefreshTimeout);
			statusRefreshTimeout = undefined;
		}
		updateCoordinatorStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const hasCoordinator = discoverAgents(ctx.cwd, "both").agents.some(
			(agent) => agent.name === autoRouteConfig.coordinatorAgent,
		);
		const decision = shouldInjectAutoRoutePrompt({
			config: autoRouteConfig,
			prompt: event.prompt,
			depth: parseIntegerEnv(process.env[SUBAGENT_ENV_DEPTH], 0),
			hasCoordinator,
		});
		if (!decision.shouldInject) {
			if (decision.warnMissingCoordinator && ctx.hasUI && !autoRouteWarnedMissingCoordinator) {
				autoRouteWarnedMissingCoordinator = true;
				ctx.ui.notify(
					`subagent auto-route: coordinator agent "${autoRouteConfig.coordinatorAgent}" not found; falling back to normal behavior`,
					"warning",
				);
			}
			return;
		}

		const directive = buildAutoRouteDirective({
			coordinatorAgent: autoRouteConfig.coordinatorAgent,
			agentScope: DEFAULT_AUTO_ROUTE_SCOPE,
			contextMode: DEFAULT_AUTO_ROUTE_CONTEXT_MODE,
			sharedContextLimit: DEFAULT_AUTO_ROUTE_CONTEXT_LIMIT,
			topologyPolicy: "auto",
		});
		return { systemPrompt: `${event.systemPrompt}\n\n${directive}` };
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Guardrails: depth ${MAX_DEPTH}, total-agent budget ${MAX_TOTAL_AGENTS}, and shared wall-time budget ${MAX_WALL_TIME_MS}ms.`,
			'Nested spawning is only allowed for agents that explicitly include "subagent" in tools.',
			"Loop protection blocks duplicate (agent, task) delegation fingerprints.",
			'Optional shared context ledger supports "isolated", "shared-read", and "shared-write" handoff modes.',
			'Optional execution isolation supports "shared" and git "worktree" lanes with patch-based integration.',
			"Includes topology policy scoring, flaky-smoke retries, and bounded phase smoke fix-loop caps.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const requestedMode: TopologyMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			const getAgentByName = (name: string): AgentConfig | undefined => agents.find((a) => a.name === name);

			const topologyPolicy: TopologyPolicy = parseTopologyPolicy(
				params.topologyPolicy ?? process.env[SUBAGENT_ENV_TOPOLOGY_POLICY],
				DEFAULT_TOPOLOGY_POLICY,
			);
			const requestedIsolation: ExecutionIsolation = parseExecutionIsolation(
				params.executionIsolation ?? process.env[SUBAGENT_ENV_EXECUTION_ISOLATION],
				"auto",
			);
			let activeIsolation: ResolvedExecutionIsolation = "shared";
			let worktreeSession: WorktreeSession | undefined;
			let worktreeReports: WorktreeIntegrationReport[] = [];
			let worktreeWarnings: string[] = [];
			const requestedSingle: ExecutionTaskItem | undefined =
				params.agent && params.task ? { agent: params.agent, task: params.task, cwd: params.cwd } : undefined;
			const requestedTasks: ExecutionTaskItem[] | undefined = params.tasks?.map((task) => ({
				agent: task.agent,
				task: task.task,
				cwd: task.cwd,
			}));
			const requestedChain: ExecutionTaskItem[] | undefined = params.chain?.map((step) => ({
				agent: step.agent,
				task: step.task,
				cwd: step.cwd,
			}));

			const topologyDecision = buildTopologyDecision({
				requestedMode,
				singleTask: params.task,
				tasks: params.tasks,
				chain: params.chain,
			});
			topologyDecision.policy = topologyPolicy;

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: {
						mode: "single",
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						topologyDecision,
						worktree: {
							requestedIsolation,
							activeIsolation,
							assignments: 0,
							reports: worktreeReports,
							warnings: worktreeWarnings,
						},
						results: [],
					},
				};
			}

			const executionPlan = buildExecutionPlan({
				requestedMode,
				policy: topologyPolicy,
				recommendedMode: topologyDecision.recommendedMode,
				single: requestedSingle,
				tasks: requestedTasks,
				chain: requestedChain,
			});
			topologyDecision.selectedMode = executionPlan.mode;
			topologyDecision.reasons.push(...executionPlan.notes);

			let phaseGateState: PhaseGateState = createPhaseGateState({
				phaseName: params.phaseName,
				requireSmoke: params.requirePhaseSmoke ?? false,
				smokeCommands: params.phaseSmokeCommands,
				smokeMaxRetries: params.phaseSmokeRetries,
				smokeMaxFixAttempts: params.phaseMaxFixAttempts,
				topologySummary: `${topologyDecision.selectedMode} (recommended ${topologyDecision.recommendedMode})`,
			});

			const mode = executionPlan.mode;
			const selectedSingle = executionPlan.single;
			const selectedTasks = executionPlan.tasks ?? [];
			const selectedChain = executionPlan.chain ?? [];
			const getAgentTools = (agentName: string): string[] | undefined => getAgentByName(agentName)?.tools;
			const isolationDecision = decideExecutionIsolation({
				requestedIsolation,
				mode,
				single: selectedSingle
					? {
							task: selectedSingle.task,
							agent: selectedSingle.agent,
							agentTools: getAgentTools(selectedSingle.agent),
						}
					: undefined,
				tasks:
					mode === "parallel"
						? selectedTasks.map((task) => ({
								task: task.task,
								agent: task.agent,
								agentTools: getAgentTools(task.agent),
							}))
						: undefined,
				chain:
					mode === "chain"
						? selectedChain.map((step) => ({
								task: step.task,
								agent: step.agent,
								agentTools: getAgentTools(step.agent),
							}))
						: undefined,
			});
			activeIsolation = isolationDecision.selectedIsolation;
			topologyDecision.reasons.push(isolationDecision.reason);

			const makeDetails =
				(currentMode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode: currentMode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					topologyDecision,
					phaseGate: phaseGateState,
					worktree: {
						requestedIsolation,
						activeIsolation,
						repoRoot: worktreeSession?.repoRoot,
						baseDir: worktreeSession?.baseDir,
						assignments: worktreeSession?.assignments.length ?? 0,
						reports: worktreeReports,
						warnings: worktreeWarnings,
					},
					results,
				});

			const phaseGateValidationError = validatePhaseGateState(phaseGateState);
			if (phaseGateValidationError) {
				return {
					content: [{ type: "text", text: phaseGateValidationError }],
					details: makeDetails(mode)([]),
				};
			}

			const budget = initializeExecutionBudget(process.env, Date.now(), {
				maxDepth: MAX_DEPTH,
				maxTotalAgents: MAX_TOTAL_AGENTS,
				maxWallTimeMs: MAX_WALL_TIME_MS,
			});
			if (budget.depth > 0 && !budget.canSpawnChildren) {
				return createBudgetError(
					"Nested subagent spawning blocked: this agent must explicitly include 'subagent' in tools.",
					makeDetails,
					mode,
				);
			}
			if (budget.depth >= budget.maxDepth) {
				return createBudgetError(
					`Subagent depth limit reached (${budget.depth}/${budget.maxDepth}).`,
					makeDetails,
					mode,
				);
			}
			if (Date.now() > budget.deadlineAtMs) {
				return createBudgetError("Subagent wall-time budget exceeded before execution.", makeDetails, mode);
			}
			if (budget.remainingTokens <= 0) {
				return createBudgetError("Subagent budget exhausted: no remaining agent tokens.", makeDetails, mode);
			}

			if (activeIsolation === "worktree") {
				try {
					worktreeSession = createWorktreeSession({
						cwd: ctx.cwd,
						runId: budget.runId,
						baseDir: params.worktreeBaseDir ?? process.env[SUBAGENT_ENV_WORKTREE_BASE_DIR],
					});
					topologyDecision.reasons.push(`worktree isolation active (${worktreeSession.baseDir})`);
				} catch (error) {
					const reason = toErrorMessage(error);
					worktreeWarnings.push(`worktree isolation fallback: ${reason}`);
					topologyDecision.reasons.push(`worktree isolation fallback: ${reason}`);
					activeIsolation = "shared";
				}
			}

			const sharedContextConfig: SharedContextConfig = {
				mode: parseContextMode(params.contextMode ?? process.env[SUBAGENT_ENV_CONTEXT_MODE], "shared-read"),
				limit: Math.max(
					1,
					Math.min(50, params.sharedContextLimit ?? parseIntegerEnv(process.env[SUBAGENT_ENV_CONTEXT_LIMIT], 12)),
				),
				memoryDir: params.memoryDir ?? process.env[SUBAGENT_ENV_MEMORY_DIR],
			};
			const sharedContextStore = createSharedContextStore({
				cwd: ctx.cwd,
				runId: budget.runId,
				memoryDir: sharedContextConfig.memoryDir,
			});
			const rootTaskId = createTaskId();

			const plannedAgents =
				mode === "chain"
					? selectedChain.map((step, index) => ({ agent: step.agent, task: step.task, step: index + 1 }))
					: mode === "parallel"
						? selectedTasks.map((task) => ({ agent: task.agent, task: task.task }))
						: selectedSingle
							? [{ agent: selectedSingle.agent, task: selectedSingle.task }]
							: [];
			const parallelMax = mode === "parallel" ? Math.min(selectedTasks.length, MAX_CONCURRENCY) : 0;
			const coordinatorId = coordinatorMonitor.startRun({
				runId: budget.runId,
				mode,
				agents: plannedAgents,
				parallelMax,
			});
			coordinatorMonitor.setPhase(coordinatorId, "dispatch");
			updateCoordinatorStatus(ctx);

			let coordinatorFinished = false;
			const finishCoordinator = (success: boolean, error?: string): void => {
				if (coordinatorFinished) return;
				coordinatorFinished = true;
				coordinatorMonitor.finishRun(coordinatorId, success, error);
				updateCoordinatorStatus(ctx);
				scheduleCompletionStatusClear(ctx);
			};

			const syncCoordinatorGovernance = (): void => {
				coordinatorMonitor.setGovernance(coordinatorId, {
					phaseName: phaseGateState.phaseName,
					gateSummary: formatPhaseGateSummary(phaseGateState),
					smokeAttempts: phaseGateState.smokeAttempts,
					smokeFixAttempts: phaseGateState.smokeFixAttempts,
					smokeMaxFixAttempts: phaseGateState.smokeMaxFixAttempts,
					remediation: phaseGateState.smokeFixHistory,
				});
			};
			syncCoordinatorGovernance();

			const prepareDelegation = (
				agentName: string,
				rawTask: string,
				parentTaskId: string | undefined,
				runMode: "single" | "parallel" | "chain",
			): { taskId: string; executionTask: string } => {
				const taskId = createTaskId();
				const envelope: TaskHandoffEnvelope = {
					runId: budget.runId,
					taskId,
					parentTaskId,
					agent: agentName,
					task: rawTask,
					mode: runMode,
					depth: budget.depth + 1,
					createdAtMs: Date.now(),
				};
				sharedContextStore.appendDispatch(envelope, sharedContextConfig.mode);
				const packet = buildSharedContextPacket(
					sharedContextConfig.mode,
					envelope,
					sharedContextStore.readRecent(sharedContextConfig.limit),
				);
				const executionTask = packet ? `${rawTask}\n\n${packet}` : rawTask;
				return { taskId, executionTask };
			};

			const runPhaseSmokeGate = async (
				currentMode: TopologyMode,
				completedResults: SingleResult[],
			): Promise<{ ok: boolean; message?: string }> => {
				if (phaseGateState.smokeCommands.length === 0) {
					phaseGateState = markSmokeSkipped(phaseGateState);
					syncCoordinatorGovernance();
					return { ok: true };
				}

				const runSmokeWithRetries = async (): Promise<{ passed: boolean; failed?: SmokeCommandResult }> => {
					let failed: SmokeCommandResult | undefined;
					for (let retry = 0; retry <= phaseGateState.smokeMaxRetries; retry++) {
						phaseGateState = {
							...phaseGateState,
							smokeAttempts: phaseGateState.smokeAttempts + 1,
						};
						const smokeResults = await runSmokeCommands(phaseGateState.smokeCommands, ctx.cwd, signal);
						phaseGateState = applySmokeResults(phaseGateState, smokeResults);
						syncCoordinatorGovernance();
						failed = smokeResults.find((result) => result.exitCode !== 0);
						if (!failed) return { passed: true };
					}
					return { passed: false, failed };
				};

				const getFixAgent = (): AgentConfig | undefined => {
					let preferredAgent: string | undefined;
					if (currentMode === "single") preferredAgent = selectedSingle?.agent;
					else if (currentMode === "chain") preferredAgent = selectedChain[selectedChain.length - 1]?.agent;
					else preferredAgent = selectedTasks[0]?.agent;
					if (!preferredAgent && completedResults.length > 0) {
						preferredAgent = completedResults[completedResults.length - 1].agent;
					}
					if (!preferredAgent) return undefined;
					return getAgentByName(preferredAgent);
				};

				const initialSmoke = await runSmokeWithRetries();
				if (initialSmoke.passed) {
					const retryCount = Math.max(0, phaseGateState.smokeAttempts - 1);
					if (retryCount > 0) {
						return { ok: true, message: `Phase smoke passed after ${retryCount} retry attempt(s).` };
					}
					return { ok: true };
				}

				if (!phaseGateState.requireSmoke) {
					const failed = initialSmoke.failed;
					if (!failed) return { ok: true };
					return {
						ok: true,
						message: `Phase smoke warning: ${failed.command} (exit ${failed.exitCode})`,
					};
				}

				const fixAgent = getFixAgent();
				if (!fixAgent || phaseGateState.smokeMaxFixAttempts === 0) {
					const failed = initialSmoke.failed;
					return {
						ok: false,
						message: failed
							? `Phase smoke gate failed: ${failed.command} (exit ${failed.exitCode}). No fix attempts available.`
							: "Phase smoke gate failed and no fix attempts are available.",
					};
				}

				for (let fixAttempt = 1; fixAttempt <= phaseGateState.smokeMaxFixAttempts; fixAttempt++) {
					const failed =
						phaseGateState.smokeResults.find((result) => result.exitCode !== 0) ?? initialSmoke.failed;
					if (budget.remainingTokens <= 0) {
						phaseGateState = recordSmokeFixAttempt(phaseGateState, {
							attempt: fixAttempt,
							agent: fixAgent.name,
							outcome: "error",
							summary: "budget exhausted before fix attempt",
						});
						syncCoordinatorGovernance();
						return {
							ok: false,
							message: `Phase smoke gate failed and fix loop exhausted budget before attempt ${fixAttempt}.`,
						};
					}

					const remediationTask = [
						"Phase smoke gate failed. Apply a minimal fix and stop.",
						`Phase: ${phaseGateState.phaseName ?? "unspecified"}`,
						failed ? `Failing command: ${failed.command} (exit ${failed.exitCode})` : "Failing command: unknown",
						failed?.stderr ? `stderr:\n${failed.stderr.slice(0, 1500)}` : "",
						failed?.stdout ? `stdout:\n${failed.stdout.slice(0, 800)}` : "",
						`Fix pass: ${fixAttempt}/${phaseGateState.smokeMaxFixAttempts}`,
						"Do not refactor unrelated files. Preserve existing behavior.",
					]
						.filter(Boolean)
						.join("\n\n");

					const delegation = prepareDelegation(fixAgent.name, remediationTask, rootTaskId, currentMode);
					let fixBudget: ChildProcessBudget;
					try {
						fixBudget = reserveChildBudget(budget, fixAgent.name, remediationTask, 0, canNestAgent(fixAgent));
					} catch (error) {
						const errorMessage = toErrorMessage(error);
						phaseGateState = recordSmokeFixAttempt(phaseGateState, {
							attempt: fixAttempt,
							agent: fixAgent.name,
							outcome: "error",
							summary: `fix attempt blocked: ${errorMessage}`,
						});
						syncCoordinatorGovernance();
						return {
							ok: false,
							message: `Phase smoke fix attempt blocked: ${errorMessage}`,
						};
					}

					const fixResult = await runSingleAgent(
						ctx.cwd,
						agents,
						fixAgent.name,
						remediationTask,
						delegation.executionTask,
						undefined,
						undefined,
						signal,
						undefined,
						makeDetails(currentMode),
						fixBudget,
						sharedContextConfig,
						activeIsolation,
					);
					const fixFailed =
						fixResult.exitCode !== 0 || fixResult.stopReason === "error" || fixResult.stopReason === "aborted";
					const fixSummary = (
						getFinalOutput(fixResult.messages) ||
						fixResult.errorMessage ||
						fixResult.stderr ||
						"(no output)"
					).slice(0, 800);
					sharedContextStore.appendObservation(
						delegation.taskId,
						fixAgent.name,
						fixFailed ? "error" : "success",
						fixSummary,
					);

					if (fixFailed) {
						phaseGateState = recordSmokeFixAttempt(phaseGateState, {
							attempt: fixAttempt,
							agent: fixAgent.name,
							outcome: "error",
							summary: `fix run failed: ${fixSummary.slice(0, 180)}`,
						});
						syncCoordinatorGovernance();
						continue;
					}

					const postFixSmoke = await runSmokeWithRetries();
					if (postFixSmoke.passed) {
						phaseGateState = recordSmokeFixAttempt(phaseGateState, {
							attempt: fixAttempt,
							agent: fixAgent.name,
							outcome: "success",
							summary: "fix applied and smoke gate passed",
						});
						syncCoordinatorGovernance();
						return { ok: true, message: `Phase smoke passed after fix attempt ${fixAttempt}.` };
					}

					const postFixFailed = phaseGateState.smokeResults.find((result) => result.exitCode !== 0);
					phaseGateState = recordSmokeFixAttempt(phaseGateState, {
						attempt: fixAttempt,
						agent: fixAgent.name,
						outcome: "error",
						summary: postFixFailed
							? `smoke still failing: ${postFixFailed.command} (exit ${postFixFailed.exitCode})`
							: "smoke still failing after fix",
					});
					syncCoordinatorGovernance();
				}

				const terminalFailure =
					phaseGateState.smokeResults.find((result) => result.exitCode !== 0) ?? initialSmoke.failed;
				return {
					ok: false,
					message: terminalFailure
						? `Phase smoke gate failed after ${phaseGateState.smokeFixAttempts}/${phaseGateState.smokeMaxFixAttempts} fix attempts: ${terminalFailure.command} (exit ${terminalFailure.exitCode}).`
						: `Phase smoke gate failed after ${phaseGateState.smokeFixAttempts}/${phaseGateState.smokeMaxFixAttempts} fix attempts.`,
				};
			};

			const integrateAssignments = (
				assignments: WorktreeAssignment[],
			): { ok: true } | { ok: false; message: string } => {
				if (activeIsolation !== "worktree" || !worktreeSession) return { ok: true };
				if (assignments.length === 0) return { ok: true };
				const reports = integrateWorktreeAssignments(worktreeSession, assignments);
				worktreeReports = [...worktreeReports, ...reports];
				const failed = reports.find((report) => report.status === "failed");
				if (failed) {
					const reason = failed.message ? `${failed.label}: ${failed.message}` : failed.label;
					return { ok: false, message: `Worktree integration failed (${reason})` };
				}
				return { ok: true };
			};

			try {
				if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
					const requestedAgentNames = new Set<string>();
					for (const step of selectedChain) requestedAgentNames.add(step.agent);
					for (const task of selectedTasks) requestedAgentNames.add(task.agent);
					if (selectedSingle?.agent) requestedAgentNames.add(selectedSingle.agent);

					const projectAgentsRequested = Array.from(requestedAgentNames)
						.map((name) => agents.find((a) => a.name === name))
						.filter((agent): agent is AgentConfig => agent?.source === "project");

					if (projectAgentsRequested.length > 0) {
						const names = projectAgentsRequested.map((agent) => agent.name).join(", ");
						const dir = discovery.projectAgentsDir ?? "(unknown)";
						const ok = await ctx.ui.confirm(
							"Run project-local agents?",
							`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
						);
						if (!ok) {
							finishCoordinator(false, "Project-local agents not approved");
							return {
								content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
								details: makeDetails(mode)([]),
							};
						}
					}
				}

				if (mode === "chain" && selectedChain.length > 0) {
					coordinatorMonitor.setPhase(coordinatorId, "running");
					updateCoordinatorStatus(ctx);
					if (budget.remainingTokens < selectedChain.length) {
						return createBudgetError(
							`Insufficient subagent budget for chain: need at least ${selectedChain.length}, have ${budget.remainingTokens}.`,
							makeDetails,
							"chain",
						);
					}

					let chainAssignment: WorktreeAssignment | undefined;
					if (activeIsolation === "worktree" && worktreeSession) {
						try {
							chainAssignment = createWorktreeAssignment(worktreeSession, "chain");
						} catch (error) {
							const reason = toErrorMessage(error);
							finishCoordinator(false, reason);
							return {
								content: [{ type: "text", text: `Failed to prepare chain worktree: ${reason}` }],
								details: makeDetails("chain")([]),
								isError: true,
							};
						}
					}

					const results: SingleResult[] = [];
					let previousOutput = "";
					let previousTaskId: string | undefined = rootTaskId;

					for (let i = 0; i < selectedChain.length; i++) {
						const step = selectedChain[i];
						const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
						const { taskId, executionTask } = prepareDelegation(
							step.agent,
							taskWithContext,
							previousTaskId,
							"chain",
						);
						const stepAgent = getAgentByName(step.agent);
						if (!stepAgent) {
							return createBudgetError(
								`Unknown agent: "${step.agent}". Available agents: ${available}`,
								makeDetails,
								"chain",
							);
						}
						if (Date.now() > budget.deadlineAtMs) {
							return createBudgetError(
								"Subagent wall-time budget exceeded during chain execution.",
								makeDetails,
								"chain",
							);
						}

						const remainingDirectSteps = selectedChain.length - i - 1;
						const minRequired = remainingDirectSteps + 1;
						if (budget.remainingTokens < minRequired) {
							return createBudgetError(
								`Subagent budget exhausted at chain step ${i + 1}: need at least ${minRequired}, have ${budget.remainingTokens}.`,
								makeDetails,
								"chain",
							);
						}

						const reservedDescendantTokens = budget.remainingTokens - minRequired;
						let childBudget: ChildProcessBudget;
						try {
							childBudget = reserveChildBudget(
								budget,
								step.agent,
								taskWithContext,
								reservedDescendantTokens,
								canNestAgent(stepAgent),
							);
						} catch (error) {
							return createBudgetError(toErrorMessage(error), makeDetails, "chain");
						}

						const chainUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
									const currentResult = partial.details?.results[0];
									if (currentResult) {
										onUpdate({
											content: partial.content,
											details: makeDetails("chain")([...results, currentResult]),
										});
									}
								}
							: undefined;

						coordinatorMonitor.setCurrentStep(coordinatorId, i + 1);
						coordinatorMonitor.markAgentRunning(coordinatorId, i);
						updateCoordinatorStatus(ctx);

						const stepExecutionCwd = chainAssignment
							? resolveWorktreeTaskCwd(
									worktreeSession?.repoRoot ?? ctx.cwd,
									chainAssignment.worktreePath,
									step.cwd,
								)
							: { cwd: step.cwd, warning: undefined };
						if (stepExecutionCwd.warning) worktreeWarnings.push(stepExecutionCwd.warning);

						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							step.agent,
							taskWithContext,
							executionTask,
							stepExecutionCwd.cwd,
							i + 1,
							signal,
							chainUpdate,
							makeDetails("chain"),
							childBudget,
							sharedContextConfig,
							activeIsolation,
						);
						results.push(result);

						const isError =
							result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
						sharedContextStore.appendObservation(
							taskId,
							step.agent,
							isError ? "error" : "success",
							(getFinalOutput(result.messages) || result.errorMessage || result.stderr || "(no output)").slice(
								0,
								800,
							),
						);
						if (isError) {
							coordinatorMonitor.markAgentError(
								coordinatorId,
								i,
								result.errorMessage || result.stderr || "subagent error",
							);
							updateCoordinatorStatus(ctx);
							const errorMsg =
								result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
							finishCoordinator(false, errorMsg);
							return {
								content: [
									{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` },
								],
								details: makeDetails("chain")(results),
								isError: true,
							};
						}
						coordinatorMonitor.markAgentDone(coordinatorId, i);
						updateCoordinatorStatus(ctx);
						previousOutput = getFinalOutput(result.messages);
						previousTaskId = taskId;
					}
					const finalOutput = getFinalOutput(results[results.length - 1].messages) || "(no output)";
					if (sharedContextConfig.mode === "shared-write") {
						sharedContextStore.appendDecision(rootTaskId, "coordinator", finalOutput.slice(0, 1000));
					}
					const integration = integrateAssignments(chainAssignment ? [chainAssignment] : []);
					if (!integration.ok) {
						finishCoordinator(false, integration.message);
						return {
							content: [{ type: "text", text: integration.message }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					const smokeGate = await runPhaseSmokeGate("chain", results);
					if (!smokeGate.ok) {
						finishCoordinator(false, smokeGate.message);
						return {
							content: [{ type: "text", text: smokeGate.message ?? "Phase smoke gate failed." }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					coordinatorMonitor.setPhase(coordinatorId, "finalizing");
					updateCoordinatorStatus(ctx);
					finishCoordinator(true);
					const outputText = smokeGate.message ? `${finalOutput}\n\n${smokeGate.message}` : finalOutput;
					return {
						content: [{ type: "text", text: outputText }],
						details: makeDetails("chain")(results),
					};
				}

				if (mode === "parallel" && selectedTasks.length > 0) {
					coordinatorMonitor.setPhase(coordinatorId, "running");
					coordinatorMonitor.setParallelRunning(coordinatorId, 0);
					updateCoordinatorStatus(ctx);
					if (selectedTasks.length > MAX_PARALLEL_TASKS)
						return {
							content: [
								{
									type: "text",
									text: `Too many parallel tasks (${selectedTasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
								},
							],
							details: makeDetails("parallel")([]),
						};
					if (budget.remainingTokens < selectedTasks.length) {
						return createBudgetError(
							`Insufficient subagent budget for parallel execution: need at least ${selectedTasks.length}, have ${budget.remainingTokens}.`,
							makeDetails,
							"parallel",
						);
					}
					if (Date.now() > budget.deadlineAtMs) {
						return createBudgetError(
							"Subagent wall-time budget exceeded before parallel execution.",
							makeDetails,
							"parallel",
						);
					}

					const childBudgets: ChildProcessBudget[] = new Array(selectedTasks.length);
					const delegations: { taskId: string; executionTask: string }[] = new Array(selectedTasks.length);
					const taskWorktrees: Array<WorktreeAssignment | undefined> = new Array(selectedTasks.length);
					const descendantsPool = budget.remainingTokens - selectedTasks.length;
					const baseDescendants = Math.floor(descendantsPool / selectedTasks.length);
					let remainder = descendantsPool % selectedTasks.length;

					try {
						for (let i = 0; i < selectedTasks.length; i++) {
							const task = selectedTasks[i];
							const taskAgent = getAgentByName(task.agent);
							if (!taskAgent) {
								return createBudgetError(
									`Unknown agent: "${task.agent}". Available agents: ${available}`,
									makeDetails,
									"parallel",
								);
							}
							if (activeIsolation === "worktree" && worktreeSession) {
								taskWorktrees[i] = createWorktreeAssignment(worktreeSession, `parallel-${i + 1}-${task.agent}`);
							}
							delegations[i] = prepareDelegation(task.agent, task.task, rootTaskId, "parallel");
							const reservedDescendantTokens = baseDescendants + (remainder > 0 ? 1 : 0);
							if (remainder > 0) remainder--;
							childBudgets[i] = reserveChildBudget(
								budget,
								task.agent,
								task.task,
								reservedDescendantTokens,
								canNestAgent(taskAgent),
							);
						}
					} catch (error) {
						return createBudgetError(toErrorMessage(error), makeDetails, "parallel");
					}

					const allResults: SingleResult[] = new Array(selectedTasks.length);
					for (let i = 0; i < selectedTasks.length; i++) {
						allResults[i] = {
							agent: selectedTasks[i].agent,
							agentSource: "unknown",
							task: selectedTasks[i].task,
							exitCode: -1,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						};
					}

					const emitParallelUpdate = () => {
						if (!onUpdate) return;
						const running = allResults.filter((result) => result.exitCode === -1).length;
						const done = allResults.filter((result) => result.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					};

					let runningAgents = 0;
					const results = await mapWithConcurrencyLimit(selectedTasks, MAX_CONCURRENCY, async (task, index) => {
						const delegation = delegations[index];
						runningAgents++;
						coordinatorMonitor.markAgentRunning(coordinatorId, index);
						coordinatorMonitor.setParallelRunning(coordinatorId, runningAgents);
						updateCoordinatorStatus(ctx);
						const workspaceAssignment = taskWorktrees[index];
						const taskExecutionCwd = workspaceAssignment
							? resolveWorktreeTaskCwd(
									worktreeSession?.repoRoot ?? ctx.cwd,
									workspaceAssignment.worktreePath,
									task.cwd,
								)
							: { cwd: task.cwd, warning: undefined };
						if (taskExecutionCwd.warning) worktreeWarnings.push(taskExecutionCwd.warning);
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							task.agent,
							task.task,
							delegation.executionTask,
							taskExecutionCwd.cwd,
							undefined,
							signal,
							(partial) => {
								const currentResult = partial.details?.results[0];
								if (!currentResult) return;
								allResults[index] = currentResult;
								emitParallelUpdate();
							},
							makeDetails("parallel"),
							childBudgets[index],
							sharedContextConfig,
							activeIsolation,
						);
						allResults[index] = result;
						const isError =
							result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
						sharedContextStore.appendObservation(
							delegation.taskId,
							task.agent,
							isError ? "error" : "success",
							(getFinalOutput(result.messages) || result.errorMessage || result.stderr || "(no output)").slice(
								0,
								800,
							),
						);
						if (isError) {
							coordinatorMonitor.markAgentError(
								coordinatorId,
								index,
								result.errorMessage || result.stderr || "subagent error",
							);
						} else {
							coordinatorMonitor.markAgentDone(coordinatorId, index);
						}
						runningAgents = Math.max(0, runningAgents - 1);
						coordinatorMonitor.setParallelRunning(coordinatorId, runningAgents);
						updateCoordinatorStatus(ctx);
						emitParallelUpdate();
						return result;
					});

					const successCount = results.filter((result) => result.exitCode === 0).length;
					const summaries = results.map((result) => {
						const output = getFinalOutput(result.messages);
						const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
						return `[${result.agent}] ${result.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
					});
					const parallelSummary = `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`;
					if (sharedContextConfig.mode === "shared-write") {
						sharedContextStore.appendDecision(rootTaskId, "coordinator", parallelSummary.slice(0, 1000));
					}
					const successfulAssignments = results
						.map((result, index) => ({ result, assignment: taskWorktrees[index] }))
						.filter(
							(item): item is { result: SingleResult; assignment: WorktreeAssignment } =>
								Boolean(item.assignment) && item.result.exitCode === 0,
						)
						.map((item) => item.assignment);
					const integration = integrateAssignments(successfulAssignments);
					if (!integration.ok) {
						finishCoordinator(false, integration.message);
						return {
							content: [{ type: "text", text: integration.message }],
							details: makeDetails("parallel")(results),
							isError: true,
						};
					}
					const smokeGate = await runPhaseSmokeGate("parallel", results);
					if (!smokeGate.ok) {
						finishCoordinator(false, smokeGate.message);
						return {
							content: [{ type: "text", text: smokeGate.message ?? "Phase smoke gate failed." }],
							details: makeDetails("parallel")(results),
							isError: true,
						};
					}
					coordinatorMonitor.setPhase(coordinatorId, "finalizing");
					updateCoordinatorStatus(ctx);
					if (successCount === results.length) finishCoordinator(true);
					else finishCoordinator(false, `${results.length - successCount} parallel agents failed`);
					const outputText = smokeGate.message ? `${parallelSummary}\n\n${smokeGate.message}` : parallelSummary;
					return {
						content: [{ type: "text", text: outputText }],
						details: makeDetails("parallel")(results),
					};
				}

				if (mode === "single" && selectedSingle) {
					coordinatorMonitor.setPhase(coordinatorId, "running");
					coordinatorMonitor.setCurrentStep(coordinatorId, 1);
					coordinatorMonitor.markAgentRunning(coordinatorId, 0);
					updateCoordinatorStatus(ctx);
					const singleAgent = getAgentByName(selectedSingle.agent);
					if (!singleAgent) {
						return createBudgetError(
							`Unknown agent: "${selectedSingle.agent}". Available agents: ${available}`,
							makeDetails,
							"single",
						);
					}
					if (Date.now() > budget.deadlineAtMs) {
						return createBudgetError(
							"Subagent wall-time budget exceeded before execution.",
							makeDetails,
							"single",
						);
					}
					let singleAssignment: WorktreeAssignment | undefined;
					if (activeIsolation === "worktree" && worktreeSession) {
						try {
							singleAssignment = createWorktreeAssignment(worktreeSession, `single-${selectedSingle.agent}`);
						} catch (error) {
							const reason = toErrorMessage(error);
							finishCoordinator(false, reason);
							return {
								content: [{ type: "text", text: `Failed to prepare single worktree: ${reason}` }],
								details: makeDetails("single")([]),
								isError: true,
							};
						}
					}
					const delegation = prepareDelegation(selectedSingle.agent, selectedSingle.task, rootTaskId, "single");
					let childBudget: ChildProcessBudget;
					try {
						childBudget = reserveChildBudget(
							budget,
							selectedSingle.agent,
							selectedSingle.task,
							Math.max(0, budget.remainingTokens - 1),
							canNestAgent(singleAgent),
						);
					} catch (error) {
						return createBudgetError(toErrorMessage(error), makeDetails, "single");
					}

					const singleExecutionCwd = singleAssignment
						? resolveWorktreeTaskCwd(
								worktreeSession?.repoRoot ?? ctx.cwd,
								singleAssignment.worktreePath,
								selectedSingle.cwd,
							)
						: { cwd: selectedSingle.cwd, warning: undefined };
					if (singleExecutionCwd.warning) worktreeWarnings.push(singleExecutionCwd.warning);
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						selectedSingle.agent,
						selectedSingle.task,
						delegation.executionTask,
						singleExecutionCwd.cwd,
						undefined,
						signal,
						onUpdate,
						makeDetails("single"),
						childBudget,
						sharedContextConfig,
						activeIsolation,
					);
					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					sharedContextStore.appendObservation(
						delegation.taskId,
						selectedSingle.agent,
						isError ? "error" : "success",
						(getFinalOutput(result.messages) || result.errorMessage || result.stderr || "(no output)").slice(
							0,
							800,
						),
					);
					if (isError) {
						coordinatorMonitor.markAgentError(
							coordinatorId,
							0,
							result.errorMessage || result.stderr || "subagent error",
						);
						updateCoordinatorStatus(ctx);
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						finishCoordinator(false, errorMsg);
						return {
							content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					coordinatorMonitor.markAgentDone(coordinatorId, 0);
					coordinatorMonitor.setPhase(coordinatorId, "finalizing");
					updateCoordinatorStatus(ctx);
					const finalOutput = getFinalOutput(result.messages) || "(no output)";
					if (sharedContextConfig.mode === "shared-write") {
						sharedContextStore.appendDecision(rootTaskId, "coordinator", finalOutput.slice(0, 1000));
					}
					const integration = integrateAssignments(singleAssignment ? [singleAssignment] : []);
					if (!integration.ok) {
						finishCoordinator(false, integration.message);
						return {
							content: [{ type: "text", text: integration.message }],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					const smokeGate = await runPhaseSmokeGate("single", [result]);
					if (!smokeGate.ok) {
						finishCoordinator(false, smokeGate.message);
						return {
							content: [{ type: "text", text: smokeGate.message ?? "Phase smoke gate failed." }],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					finishCoordinator(true);
					const outputText = smokeGate.message ? `${finalOutput}\n\n${smokeGate.message}` : finalOutput;
					return {
						content: [{ type: "text", text: outputText }],
						details: makeDetails("single")([result]),
					};
				}

				finishCoordinator(false, "Invalid parameters");
				return {
					content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
					details: makeDetails("single")([]),
				};
			} finally {
				if (worktreeSession) {
					const cleanupWarnings = cleanupWorktreeSession(worktreeSession);
					if (cleanupWarnings.length > 0) {
						worktreeWarnings = [...worktreeWarnings, ...cleanupWarnings];
						topologyDecision.reasons.push(
							...cleanupWarnings.map((warning) => `worktree cleanup warning: ${warning}`),
						);
					}
				}
				if (!coordinatorFinished) {
					finishCoordinator(false);
				}
			}
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			const contextMode = parseContextMode(args.contextMode, "shared-read");
			const executionIsolation = parseExecutionIsolation(args.executionIsolation, "auto");
			const contextTag = theme.fg("muted", ` {${contextMode}|${executionIsolation}}`);
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`) +
					contextTag;
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`) +
					contextTag;
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				contextTag;
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const governanceLines: string[] = [];
			if (details.topologyDecision) {
				const decision = details.topologyDecision;
				governanceLines.push(
					theme.fg(
						"dim",
						`policy:${decision.policy} mode:${decision.selectedMode} rec:${decision.recommendedMode} c:${decision.complexityScore} r:${decision.riskScore} k:${decision.couplingScore} conf:${decision.confidenceScore}`,
					),
				);
				if (decision.reasons.length > 0)
					governanceLines.push(theme.fg("dim", `policy note: ${decision.reasons[0]}`));
			}
			if (details.phaseGate) {
				const phaseLabel = details.phaseGate.phaseName
					? `phase:${details.phaseGate.phaseName}`
					: "phase:unspecified";
				governanceLines.push(
					theme.fg(
						"dim",
						`${phaseLabel} gates:${formatPhaseGateSummary(details.phaseGate)} smokeAttempts:${details.phaseGate.smokeAttempts} fixAttempts:${details.phaseGate.smokeFixAttempts}/${details.phaseGate.smokeMaxFixAttempts}`,
					),
				);
				if (details.phaseGate.smokeFixHistory.length > 0) {
					governanceLines.push(theme.fg("dim", "gate remediation:"));
					for (const entry of details.phaseGate.smokeFixHistory.slice(-3)) {
						const marker = entry.outcome === "success" ? "ok" : "fail";
						governanceLines.push(
							theme.fg("dim", `  #${entry.attempt} ${entry.agent} ${marker} ${entry.summary.slice(0, 120)}`),
						);
					}
				}
			}
			if (details.worktree) {
				const applied = details.worktree.reports.filter((report) => report.status === "applied").length;
				const skipped = details.worktree.reports.filter((report) => report.status === "skipped").length;
				const failed = details.worktree.reports.filter((report) => report.status === "failed").length;
				governanceLines.push(
					theme.fg(
						"dim",
						`isolation:${details.worktree.activeIsolation} (req:${details.worktree.requestedIsolation}) worktrees:${details.worktree.assignments} applied:${applied} skipped:${skipped} failed:${failed}`,
					),
				);
				if (details.worktree.warnings.length > 0) {
					governanceLines.push(theme.fg("dim", `worktree warning: ${details.worktree.warnings[0]}`));
				}
			}
			const governancePrefix = governanceLines.length > 0 ? `${governanceLines.join("\n")}\n` : "";

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					if (governanceLines.length > 0) {
						container.addChild(new Text(governanceLines.join("\n"), 0, 0));
						container.addChild(new Spacer(1));
					}
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${governancePrefix}${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					if (governanceLines.length > 0) {
						container.addChild(new Text(governanceLines.join("\n"), 0, 0));
						container.addChild(new Spacer(1));
					}
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					governancePrefix +
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					if (governanceLines.length > 0) {
						container.addChild(new Text(governanceLines.join("\n"), 0, 0));
						container.addChild(new Spacer(1));
					}
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${governancePrefix}${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
