/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { loadSubagentConfig } from "./config.js";
import { buildCuratedContent } from "./curation.js";
import { applyPatchToRepo } from "./integration.js";
import { shouldFailOnConflicts, toSchedulerTask } from "./policy.js";
import { resolveTaskExecution } from "./profiles.js";
import { buildSchedulerWaves } from "./scheduler.js";
import type {
	IsolationMode,
	ResolvedTaskExecution,
	SingleResult,
	SubagentDelegationMode,
	SubagentDetails,
	SubagentTaskInput,
	TaskExecutionArtifacts,
	UsageStats,
	WorktreeHandle,
	WriteConflictPolicy,
} from "./types.js";
import {
	createWorktree,
	detectGitRepoRoot,
	getWorktreePatch,
	hasWorktreeChanges,
	pruneWorktrees,
	removeWorktree,
} from "./worktree.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const COLLAPSED_ITEM_COUNT = 10;
const SUBAGENT_MODE_ENTRY = "subagent-mode";

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

type ToolCallThemeColor = "muted" | "toolOutput" | "accent" | "warning" | "dim";

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ToolCallThemeColor, text: string) => string,
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

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

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

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface RunSingleAgentOptions {
	defaultCwd: string;
	agent: AgentConfig;
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	timeoutMs: number;
	seedResult: SingleResult;
}

async function runSingleAgent(options: RunSingleAgentOptions): Promise<SingleResult> {
	const {
		defaultCwd,
		agent,
		task,
		cwd,
		step,
		signal,
		onUpdate,
		makeDetails,
		model,
		thinking,
		tools,
		timeoutMs,
		seedResult,
	} = options;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		...seedResult,
		step,
		task,
		model,
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
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
			});
			let buffer = "";
			let timedOut = false;
			const timeoutHandle = setTimeout(() => {
				timedOut = true;
				currentResult.stderr += `Timed out after ${timeoutMs}ms.`;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			}, timeoutMs);

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
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

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				clearTimeout(timeoutHandle);
				if (buffer.trim()) processLine(buffer);
				if (timedOut) resolve(124);
				else resolve(code ?? 0);
			});

			proc.on("error", () => {
				clearTimeout(timeoutHandle);
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
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

async function executeResolvedTask(
	task: ResolvedTaskExecution,
	defaultCwd: string,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	timeoutMs: number,
): Promise<TaskExecutionArtifacts> {
	let runCwd = task.cwd;
	let worktree: WorktreeHandle | undefined;

	const seedResult: SingleResult = {
		agent: task.agent.name,
		agentSource: task.agent.source,
		task: task.input.task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: task.model,
		index: task.index,
		isWriteTask: task.isWriteTask,
		writePaths: task.writePaths,
		isolation: task.isolation,
	};

	if (task.isWriteTask && task.isolation === "worktree") {
		const repoRoot = await detectGitRepoRoot(task.cwd, timeoutMs);
		if (repoRoot) {
			const creation = await createWorktree(repoRoot, timeoutMs);
			if (creation.handle) {
				worktree = creation.handle;
				runCwd = creation.handle.path;
				seedResult.worktreePath = creation.handle.path;
			} else {
				seedResult.stderr += `\n[worktree disabled] ${creation.error ?? "Failed to create worktree."}`;
			}
		} else {
			seedResult.stderr += "\n[worktree disabled] Not in a git repository.";
		}
	}

	const result = await runSingleAgent({
		defaultCwd,
		agent: task.agent,
		task: task.input.task,
		cwd: runCwd,
		signal,
		onUpdate,
		makeDetails,
		model: task.model,
		thinking: task.thinking,
		tools: task.tools,
		timeoutMs: task.timeoutMs ?? timeoutMs,
		seedResult,
	});

	let patch: string | undefined;
	if (worktree && result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted") {
		const patchResult = await getWorktreePatch(worktree.path, timeoutMs);
		if (patchResult.error) {
			result.integrationError = patchResult.error;
		} else if (patchResult.patch.trim()) {
			patch = patchResult.patch;
			result.patchBytes = Buffer.byteLength(patch, "utf-8");
		}
	}

	return { result, patch, worktree };
}

function isExecutionError(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

async function integrateArtifact(
	artifact: TaskExecutionArtifacts,
	defaultCwd: string,
	onWriteConflict: WriteConflictPolicy,
	timeoutMs: number,
	retryTask: (() => Promise<TaskExecutionArtifacts>) | undefined,
): Promise<TaskExecutionArtifacts> {
	const { result, patch } = artifact;
	if (!artifact.worktree) return artifact;

	if (isExecutionError(result)) return artifact;

	if (!patch || !patch.trim()) {
		const hasChanges = await hasWorktreeChanges(artifact.worktree.path, timeoutMs);
		result.patchApplied = !hasChanges;
		return artifact;
	}

	const applyResult = await applyPatchToRepo(defaultCwd, patch, timeoutMs);
	if (applyResult.ok) {
		result.patchApplied = true;
		return artifact;
	}

	result.patchApplied = false;
	result.integrationError = applyResult.error ?? "Patch apply failed.";

	if (onWriteConflict === "serialize" && retryTask) {
		const retryArtifact = await retryTask();
		retryArtifact.result.retried = true;
		return retryArtifact;
	}

	result.exitCode = 1;
	return artifact;
}

async function finalizeWorktree(
	artifact: TaskExecutionArtifacts,
	cleanupOnSuccess: boolean,
	keepFailedWorktrees: boolean,
	timeoutMs: number,
): Promise<void> {
	if (!artifact.worktree) return;
	const success = artifact.result.patchApplied !== false && !isExecutionError(artifact.result);
	if (success && cleanupOnSuccess) {
		await removeWorktree(artifact.worktree.repoRoot, artifact.worktree.path, timeoutMs);
		return;
	}
	if (!success && !keepFailedWorktrees) {
		await removeWorktree(artifact.worktree.repoRoot, artifact.worktree.path, timeoutMs);
	}
}

function parseToolsOverride(value: string | string[] | undefined): string[] | undefined {
	if (!value) return undefined;
	const tools = Array.isArray(value) ? value : value.split(",");
	const normalized = tools.map((tool) => tool.trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

function parseWritePaths(value: string | string[] | undefined): string[] | undefined {
	if (!value) return undefined;
	const paths = Array.isArray(value) ? value : value.split(",");
	const normalized = paths.map((item) => item.trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

function toTaskInput(raw: {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[] | string;
	mode?: "read" | "write" | "auto";
	writePaths?: string[] | string;
	isolation?: IsolationMode;
	timeoutMs?: number;
}): SubagentTaskInput {
	return {
		agent: raw.agent,
		task: raw.task,
		cwd: raw.cwd,
		model: raw.model,
		thinking: raw.thinking,
		tools: parseToolsOverride(raw.tools),
		mode: raw.mode,
		writePaths: parseWritePaths(raw.writePaths),
		isolation: raw.isolation,
		timeoutMs: raw.timeoutMs,
	};
}

function writeArtifactFile(cwd: string, relativeDir: string, details: SubagentDetails): string | undefined {
	try {
		const targetDir = path.resolve(cwd, relativeDir);
		fs.mkdirSync(targetDir, { recursive: true });
		const fileName = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}.json`;
		const outputPath = path.join(targetDir, fileName);
		fs.writeFileSync(outputPath, JSON.stringify(details, null, 2), "utf-8");
		return outputPath;
	} catch {
		return undefined;
	}
}

const TaskModeSchema = StringEnum(["read", "write", "auto"] as const, {
	description: "Execution mode for this task",
});

const IsolationModeSchema = StringEnum(["none", "worktree"] as const, {
	description: "Execution isolation mode for this task",
});

const ThinkingSchema = StringEnum(THINKING_LEVELS, {
	description: "Thinking level override for this task",
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Model override for this task" })),
	thinking: Type.Optional(ThinkingSchema),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tools override for this task" })),
	mode: Type.Optional(TaskModeSchema),
	writePaths: Type.Optional(Type.Array(Type.String(), { description: "Write path hints for conflict detection" })),
	isolation: Type.Optional(IsolationModeSchema),
	timeoutMs: Type.Optional(Type.Number({ description: "Task timeout in milliseconds" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Model override for this step" })),
	thinking: Type.Optional(ThinkingSchema),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tools override for this step" })),
	mode: Type.Optional(TaskModeSchema),
	writePaths: Type.Optional(Type.Array(Type.String(), { description: "Write path hints for conflict detection" })),
	isolation: Type.Optional(IsolationModeSchema),
	timeoutMs: Type.Optional(Type.Number({ description: "Step timeout in milliseconds" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const WriteConflictSchema = StringEnum(["serialize", "fail"] as const, {
	description: "How to handle write-path conflicts in parallel mode",
	default: "serialize",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before running project-local agents." })),
	onWriteConflict: Type.Optional(WriteConflictSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
	thinking: Type.Optional(ThinkingSchema),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tools override (single mode)" })),
	mode: Type.Optional(TaskModeSchema),
	writePaths: Type.Optional(Type.Array(Type.String(), { description: "Write path hints (single mode)" })),
	isolation: Type.Optional(IsolationModeSchema),
	timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds (single mode)" })),
});

function delegationModeGuidance(
	mode: SubagentDelegationMode,
	prompt: string,
	contextPercent: number | null,
): string | null {
	const normalizedPrompt = prompt.toLowerCase();
	const intentWords = ["delegate", "parallel", "split", "research", "plan", "review", "subagent"];
	const hasIntentWord = intentWords.some((word) => normalizedPrompt.includes(word));
	const complexityScore =
		(prompt.match(/\band\b|\bthen\b|\balso\b|\bplus\b/gi)?.length ?? 0) + (prompt.includes("\n") ? 1 : 0);
	const highContextPressure = contextPercent !== null && contextPercent >= 70;

	if (mode === "assist") {
		if (!hasIntentWord && !highContextPressure && complexityScore < 2) return null;
	}

	if (mode === "orchestrate") {
		if (prompt.trim().length < 18 && !hasIntentWord && !highContextPressure) return null;
	}

	return `\n\nSubagent orchestration mode: ${mode}.\nUse the subagent tool proactively when tasks can be split into scout/planner/worker/reviewer phases, when parallel investigation helps, or when context pressure is high.\nKeep your own context compact: request concise summaries from subagents, and prefer delegation over large in-thread exploration when appropriate.`;
}

export default function (pi: ExtensionAPI) {
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
	let delegationMode: SubagentDelegationMode = "off";

	if (!isSubagentChild) {
		pi.registerFlag("subagent-mode", {
			description: "Subagent delegation mode: off, assist, orchestrate",
			type: "string",
			default: "off",
		});

		pi.registerCommand("subagent-mode", {
			description: "Set or view subagent delegation mode (off|assist|orchestrate)",
			handler: async (args, ctx) => {
				const value = args.trim();
				if (!value) {
					ctx.ui.notify(`subagent-mode: ${delegationMode}`);
					return;
				}
				if (value !== "off" && value !== "assist" && value !== "orchestrate") {
					ctx.ui.notify("Invalid mode. Use off, assist, or orchestrate.", "warning");
					return;
				}
				delegationMode = value;
				pi.appendEntry(SUBAGENT_MODE_ENTRY, { mode: delegationMode });
				ctx.ui.notify(`subagent-mode set to ${delegationMode}`);
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			const cfg = loadSubagentConfig(ctx.cwd);
			delegationMode = cfg.autoDelegationDefault;
			const flagValue = pi.getFlag("subagent-mode");
			if (flagValue === "off" || flagValue === "assist" || flagValue === "orchestrate") {
				delegationMode = flagValue;
			}

			const modeEntry = ctx.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === SUBAGENT_MODE_ENTRY)
				.pop();

			if (modeEntry && "data" in modeEntry && modeEntry.data && typeof modeEntry.data === "object") {
				const maybeMode = (modeEntry.data as { mode?: unknown }).mode;
				if (maybeMode === "off" || maybeMode === "assist" || maybeMode === "orchestrate") {
					delegationMode = maybeMode;
				}
			}
		});

		pi.on("before_agent_start", async (event, ctx) => {
			if (delegationMode === "off") return;
			const usage = ctx.getContextUsage();
			const contextPercent = usage?.percent ?? null;
			const guidance = delegationModeGuidance(delegationMode, event.prompt, contextPercent);
			if (!guidance) return;
			return {
				systemPrompt: `${event.systemPrompt}${guidance}`,
			};
		});
	}

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const runtimeConfig = loadSubagentConfig(ctx.cwd);
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? runtimeConfig.confirmProjectAgents;
			const onWriteConflict = params.onWriteConflict ?? runtimeConfig.onWriteConflict;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					policy: { onWriteConflict },
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const task of params.tasks) requestedAgentNames.add(task.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((agent) => agent.name === name))
					.filter((agent): agent is AgentConfig => agent?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((agent) => agent.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			const availableByName = new Map<string, AgentConfig>(agents.map((agent) => [agent.name, agent]));

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				const touchedRepoRoots = new Set<string>();

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const agent = availableByName.get(step.agent);
					if (!agent) {
						const available = agents.map((entry) => `"${entry.name}"`).join(", ") || "none";
						return {
							content: [
								{ type: "text", text: `Unknown agent: "${step.agent}". Available agents: ${available}.` },
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}

					const taskInput = toTaskInput({
						...step,
						task: step.task.replace(/\{previous\}/g, previousOutput),
					});
					const resolved = resolveTaskExecution(i, agent, taskInput, ctx.cwd);

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

					let artifact = await executeResolvedTask(
						resolved,
						ctx.cwd,
						signal,
						chainUpdate,
						makeDetails("chain"),
						runtimeConfig.taskTimeoutMs,
					);

					artifact = await integrateArtifact(
						artifact,
						ctx.cwd,
						onWriteConflict,
						runtimeConfig.taskTimeoutMs,
						onWriteConflict === "serialize"
							? async () => {
									const retry = await executeResolvedTask(
										resolved,
										ctx.cwd,
										signal,
										undefined,
										makeDetails("chain"),
										runtimeConfig.taskTimeoutMs,
									);
									return integrateArtifact(retry, ctx.cwd, "fail", runtimeConfig.taskTimeoutMs, undefined);
								}
							: undefined,
					);

					results.push(artifact.result);
					if (artifact.worktree) {
						touchedRepoRoots.add(artifact.worktree.repoRoot);
						await finalizeWorktree(
							artifact,
							runtimeConfig.cleanupWorktreesOnSuccess,
							runtimeConfig.keepFailedWorktrees,
							runtimeConfig.taskTimeoutMs,
						);
					}

					if (isExecutionError(artifact.result) || artifact.result.patchApplied === false) {
						const errorMsg =
							artifact.result.integrationError ||
							artifact.result.errorMessage ||
							artifact.result.stderr ||
							getFinalOutput(artifact.result.messages) ||
							"(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}

					previousOutput = getFinalOutput(artifact.result.messages);
				}

				if (runtimeConfig.pruneWorktreesOnFinish) {
					for (const repoRoot of touchedRepoRoots) {
						await pruneWorktrees(repoRoot, runtimeConfig.taskTimeoutMs);
					}
				}

				const details = makeDetails("chain")(results);
				details.artifactsPath = writeArtifactFile(ctx.cwd, runtimeConfig.artifactDir, details);
				return {
					content: [{ type: "text", text: buildCuratedContent("chain", results, runtimeConfig.contentMaxChars) }],
					details,
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > runtimeConfig.maxParallelTasks)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${runtimeConfig.maxParallelTasks}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const resolvedTasks: ResolvedTaskExecution[] = [];
				for (let i = 0; i < params.tasks.length; i++) {
					const taskInput = toTaskInput(params.tasks[i]);
					const agent = availableByName.get(taskInput.agent);
					if (!agent) {
						const available = agents.map((entry) => `"${entry.name}"`).join(", ") || "none";
						return {
							content: [
								{ type: "text", text: `Unknown agent: "${taskInput.agent}". Available agents: ${available}.` },
							],
							details: makeDetails("parallel")([]),
							isError: true,
						};
					}
					resolvedTasks.push(resolveTaskExecution(i, agent, taskInput, ctx.cwd));
				}

				const schedule = buildSchedulerWaves(resolvedTasks.map(toSchedulerTask));
				if (shouldFailOnConflicts(onWriteConflict) && schedule.conflicts.length > 0) {
					const conflictText = schedule.conflicts.map((pair) => `${pair.a + 1}<->${pair.b + 1}`).join(", ");
					return {
						content: [{ type: "text", text: `Write conflict policy is fail. Conflicts: ${conflictText}` }],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}

				const allResults: SingleResult[] = new Array(resolvedTasks.length);
				for (let i = 0; i < resolvedTasks.length; i++) {
					allResults[i] = {
						agent: resolvedTasks[i].agent.name,
						agentSource: resolvedTasks[i].agent.source,
						task: resolvedTasks[i].input.task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						model: resolvedTasks[i].model,
						index: i,
						isWriteTask: resolvedTasks[i].isWriteTask,
						writePaths: resolvedTasks[i].writePaths,
						isolation: resolvedTasks[i].isolation,
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

				const artifactMap = new Map<number, TaskExecutionArtifacts>();
				const touchedRepoRoots = new Set<string>();

				for (const wave of schedule.waves) {
					const waveTasks = wave.taskIndexes.map((index) => resolvedTasks[index]);
					const waveArtifacts = await mapWithConcurrencyLimit(
						waveTasks,
						runtimeConfig.maxConcurrency,
						async (task) => {
							const artifact = await executeResolvedTask(
								task,
								ctx.cwd,
								signal,
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[task.index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
								runtimeConfig.taskTimeoutMs,
							);
							allResults[task.index] = artifact.result;
							emitParallelUpdate();
							return artifact;
						},
					);

					for (const artifact of waveArtifacts) {
						artifactMap.set(artifact.result.index ?? 0, artifact);
					}

					for (const taskIndex of [...wave.taskIndexes].sort((a, b) => a - b)) {
						const task = resolvedTasks[taskIndex];
						const existing = artifactMap.get(taskIndex);
						if (!existing) continue;

						const integrated = await integrateArtifact(
							existing,
							ctx.cwd,
							onWriteConflict,
							runtimeConfig.taskTimeoutMs,
							onWriteConflict === "serialize"
								? async () => {
										const retry = await executeResolvedTask(
											task,
											ctx.cwd,
											signal,
											undefined,
											makeDetails("parallel"),
											runtimeConfig.taskTimeoutMs,
										);
										return integrateArtifact(retry, ctx.cwd, "fail", runtimeConfig.taskTimeoutMs, undefined);
									}
								: undefined,
						);

						artifactMap.set(taskIndex, integrated);
						allResults[taskIndex] = integrated.result;
						emitParallelUpdate();
						if (integrated.worktree) {
							touchedRepoRoots.add(integrated.worktree.repoRoot);
							await finalizeWorktree(
								integrated,
								runtimeConfig.cleanupWorktreesOnSuccess,
								runtimeConfig.keepFailedWorktrees,
								runtimeConfig.taskTimeoutMs,
							);
						}
					}
				}

				if (runtimeConfig.pruneWorktreesOnFinish) {
					for (const repoRoot of touchedRepoRoots) {
						await pruneWorktrees(repoRoot, runtimeConfig.taskTimeoutMs);
					}
				}

				const finalResults = [...allResults];
				const details = makeDetails("parallel")(finalResults);
				details.artifactsPath = writeArtifactFile(ctx.cwd, runtimeConfig.artifactDir, details);
				const anyError = finalResults.some((result) => isExecutionError(result) || result.patchApplied === false);
				return {
					content: [
						{ type: "text", text: buildCuratedContent("parallel", finalResults, runtimeConfig.contentMaxChars) },
					],
					details,
					isError: anyError,
				};
			}

			if (params.agent && params.task) {
				const taskInput = toTaskInput({
					agent: params.agent,
					task: params.task,
					cwd: params.cwd,
					model: params.model,
					thinking: params.thinking,
					tools: params.tools,
					mode: params.mode,
					writePaths: params.writePaths,
					isolation: params.isolation,
					timeoutMs: params.timeoutMs,
				});
				const agent = availableByName.get(taskInput.agent);
				if (!agent) {
					const available = agents.map((entry) => `"${entry.name}"`).join(", ") || "none";
					return {
						content: [
							{ type: "text", text: `Unknown agent: "${taskInput.agent}". Available agents: ${available}.` },
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const resolved = resolveTaskExecution(0, agent, taskInput, ctx.cwd);

				let artifact = await executeResolvedTask(
					resolved,
					ctx.cwd,
					signal,
					onUpdate,
					makeDetails("single"),
					runtimeConfig.taskTimeoutMs,
				);
				artifact = await integrateArtifact(
					artifact,
					ctx.cwd,
					onWriteConflict,
					runtimeConfig.taskTimeoutMs,
					onWriteConflict === "serialize"
						? async () => {
								const retry = await executeResolvedTask(
									resolved,
									ctx.cwd,
									signal,
									undefined,
									makeDetails("single"),
									runtimeConfig.taskTimeoutMs,
								);
								return integrateArtifact(retry, ctx.cwd, "fail", runtimeConfig.taskTimeoutMs, undefined);
							}
						: undefined,
				);
				await finalizeWorktree(
					artifact,
					runtimeConfig.cleanupWorktreesOnSuccess,
					runtimeConfig.keepFailedWorktrees,
					runtimeConfig.taskTimeoutMs,
				);
				if (artifact.worktree && runtimeConfig.pruneWorktreesOnFinish) {
					await pruneWorktrees(artifact.worktree.repoRoot, runtimeConfig.taskTimeoutMs);
				}

				const details = makeDetails("single")([artifact.result]);
				details.artifactsPath = writeArtifactFile(ctx.cwd, runtimeConfig.artifactDir, details);
				const isError = isExecutionError(artifact.result) || artifact.result.patchApplied === false;
				if (isError) {
					const errorMsg =
						artifact.result.integrationError ||
						artifact.result.errorMessage ||
						artifact.result.stderr ||
						getFinalOutput(artifact.result.messages) ||
						"(no output)";
					return {
						content: [{ type: "text", text: `Agent ${artifact.result.stopReason || "failed"}: ${errorMsg}` }],
						details,
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: buildCuratedContent("single", [artifact.result], runtimeConfig.contentMaxChars),
						},
					],
					details,
				};
			}

			const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
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
					theme.fg("muted", ` [${scope}]`);
				for (const task of args.tasks.slice(0, 3)) {
					const preview = task.task.length > 40 ? `${task.task.slice(0, 40)}...` : task.task;
					text += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
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

			if (details.mode === "single" && details.results.length === 1) {
				const single = details.results[0];
				const isError = single.exitCode !== 0 || single.stopReason === "error" || single.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(single.messages);
				const finalOutput = getFinalOutput(single.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(single.agent))}${theme.fg("muted", ` (${single.agentSource})`)}`;
					if (isError && single.stopReason) header += ` ${theme.fg("error", `[${single.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && single.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${single.errorMessage}`), 0, 0));
					if (single.worktreePath)
						container.addChild(new Text(theme.fg("dim", `worktree: ${single.worktreePath}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", single.task), 0, 0));
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
					const usageStr = formatUsageStats(single.usage, single.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(single.agent))}${theme.fg("muted", ` (${single.agentSource})`)}`;
				if (isError && single.stopReason) text += ` ${theme.fg("error", `[${single.stopReason}]`)}`;
				if (single.worktreePath) text += `\n${theme.fg("dim", `worktree: ${single.worktreePath}`)}`;
				if (isError && single.errorMessage) text += `\n${theme.fg("error", `Error: ${single.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				if (single.integrationError) text += `\n${theme.fg("warning", `integration: ${single.integrationError}`)}`;
				const usageStr = formatUsageStats(single.usage, single.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total: UsageStats = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
					turns: 0,
				};
				for (const entry of results) {
					total.input += entry.usage.input;
					total.output += entry.usage.output;
					total.cacheRead += entry.usage.cacheRead;
					total.cacheWrite += entry.usage.cacheWrite;
					total.cost += entry.usage.cost;
					total.turns += entry.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((entry) => entry.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
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

					for (const entry of details.results) {
						const rIcon = entry.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(entry.messages);
						const finalOutput = getFinalOutput(entry.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${entry.step}: `) + theme.fg("accent", entry.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", entry.task), 0, 0));
						if (entry.worktreePath)
							container.addChild(new Text(theme.fg("dim", `worktree: ${entry.worktreePath}`), 0, 0));

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

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						if (entry.integrationError)
							container.addChild(new Text(theme.fg("warning", `integration: ${entry.integrationError}`), 0, 0));
						const stepUsage = formatUsageStats(entry.usage, entry.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const entry of details.results) {
					const rIcon = entry.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(entry.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${entry.step}: `)}${theme.fg("accent", entry.agent)} ${rIcon}`;
					if (entry.worktreePath) text += `\n${theme.fg("dim", `worktree: ${entry.worktreePath}`)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					if (entry.integrationError) text += `\n${theme.fg("warning", `integration: ${entry.integrationError}`)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((entry) => entry.exitCode === -1).length;
				const successCount = details.results.filter((entry) => entry.exitCode === 0).length;
				const failCount = details.results.filter((entry) => entry.exitCode > 0).length;
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
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const entry of details.results) {
						const rIcon = entry.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(entry.messages);
						const finalOutput = getFinalOutput(entry.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", entry.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", entry.task), 0, 0));
						if (entry.worktreePath)
							container.addChild(new Text(theme.fg("dim", `worktree: ${entry.worktreePath}`), 0, 0));

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

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						if (entry.integrationError)
							container.addChild(new Text(theme.fg("warning", `integration: ${entry.integrationError}`), 0, 0));
						const taskUsage = formatUsageStats(entry.usage, entry.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const entry of details.results) {
					const rIcon =
						entry.exitCode === -1
							? theme.fg("warning", "⏳")
							: entry.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(entry.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", entry.agent)} ${rIcon}`;
					if (entry.worktreePath) text += `\n${theme.fg("dim", `worktree: ${entry.worktreePath}`)}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", entry.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					if (entry.integrationError) text += `\n${theme.fg("warning", `integration: ${entry.integrationError}`)}`;
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
