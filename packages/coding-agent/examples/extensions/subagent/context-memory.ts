import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type SharedContextMode = "isolated" | "shared-read" | "shared-write";

export interface TaskHandoffEnvelope {
	runId: string;
	taskId: string;
	parentTaskId?: string;
	agent: string;
	task: string;
	mode: "single" | "parallel" | "chain";
	depth: number;
	createdAtMs: number;
}

interface SharedContextEntryBase {
	entryId: string;
	runId: string;
	createdAtMs: number;
}

export interface DispatchEntry extends SharedContextEntryBase {
	type: "dispatch";
	envelope: TaskHandoffEnvelope;
	contextMode: SharedContextMode;
}

export interface ObservationEntry extends SharedContextEntryBase {
	type: "observation";
	taskId: string;
	agent: string;
	status: "success" | "error";
	summary: string;
}

export interface DecisionEntry extends SharedContextEntryBase {
	type: "decision";
	taskId: string;
	coordinator: string;
	decision: string;
}

export type SharedContextEntry = DispatchEntry | ObservationEntry | DecisionEntry;

export interface SharedContextStore {
	getLedgerPath(): string;
	readRecent(limit: number): SharedContextEntry[];
	appendDispatch(envelope: TaskHandoffEnvelope, contextMode: SharedContextMode): void;
	appendObservation(taskId: string, agent: string, status: "success" | "error", summary: string): void;
	appendDecision(taskId: string, coordinator: string, decision: string): void;
}

export interface CreateSharedContextStoreOptions {
	cwd: string;
	runId: string;
	memoryDir?: string;
}

class NoopSharedContextStore implements SharedContextStore {
	getLedgerPath(): string {
		return "(disabled)";
	}

	readRecent(_limit: number): SharedContextEntry[] {
		return [];
	}

	appendDispatch(_envelope: TaskHandoffEnvelope, _contextMode: SharedContextMode): void {
		// noop
	}

	appendObservation(_taskId: string, _agent: string, _status: "success" | "error", _summary: string): void {
		// noop
	}

	appendDecision(_taskId: string, _coordinator: string, _decision: string): void {
		// noop
	}
}

class FileSharedContextStore implements SharedContextStore {
	private readonly ledgerPath: string;
	private readonly runId: string;

	constructor(options: CreateSharedContextStoreOptions) {
		const baseDir = options.memoryDir
			? path.resolve(options.memoryDir)
			: path.join(options.cwd, ".pi", "subagent-memory", "runs");
		this.runId = options.runId;
		this.ledgerPath = path.join(baseDir, `${options.runId}.jsonl`);
		fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
		if (!fs.existsSync(this.ledgerPath)) fs.writeFileSync(this.ledgerPath, "");
	}

	getLedgerPath(): string {
		return this.ledgerPath;
	}

	readRecent(limit: number): SharedContextEntry[] {
		const boundedLimit = Math.max(1, Math.min(100, limit));
		let content = "";
		try {
			content = fs.readFileSync(this.ledgerPath, "utf-8");
		} catch {
			return [];
		}
		const lines = content.split("\n").filter((line) => line.trim().length > 0);
		const entries: SharedContextEntry[] = [];
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as SharedContextEntry;
				if (parsed.runId === this.runId) entries.push(parsed);
			} catch {
				// ignore malformed line
			}
		}
		return entries.slice(-boundedLimit);
	}

	appendDispatch(envelope: TaskHandoffEnvelope, contextMode: SharedContextMode): void {
		this.append({
			type: "dispatch",
			envelope,
			contextMode,
			entryId: createEntryId(),
			runId: this.runId,
			createdAtMs: Date.now(),
		});
	}

	appendObservation(taskId: string, agent: string, status: "success" | "error", summary: string): void {
		this.append({
			type: "observation",
			taskId,
			agent,
			status,
			summary,
			entryId: createEntryId(),
			runId: this.runId,
			createdAtMs: Date.now(),
		});
	}

	appendDecision(taskId: string, coordinator: string, decision: string): void {
		this.append({
			type: "decision",
			taskId,
			coordinator,
			decision,
			entryId: createEntryId(),
			runId: this.runId,
			createdAtMs: Date.now(),
		});
	}

	private append(entry: SharedContextEntry): void {
		try {
			fs.appendFileSync(this.ledgerPath, `${JSON.stringify(entry)}\n`);
		} catch {
			// ignore write errors for best-effort logging
		}
	}
}

function createEntryId(): string {
	return randomBytes(8).toString("hex");
}

export function createTaskId(): string {
	return randomBytes(6).toString("hex");
}

export function createSharedContextStore(options: CreateSharedContextStoreOptions): SharedContextStore {
	try {
		return new FileSharedContextStore(options);
	} catch {
		return new NoopSharedContextStore();
	}
}

function summarizeEntry(entry: SharedContextEntry): string {
	switch (entry.type) {
		case "dispatch":
			return `dispatch ${entry.envelope.agent} task:${entry.envelope.taskId}`;
		case "observation":
			return `${entry.status} ${entry.agent} task:${entry.taskId} ${entry.summary.slice(0, 120)}`;
		case "decision":
			return `decision ${entry.coordinator} task:${entry.taskId} ${entry.decision.slice(0, 120)}`;
		default:
			return "entry";
	}
}

export function buildSharedContextPacket(
	contextMode: SharedContextMode,
	envelope: TaskHandoffEnvelope,
	recentEntries: SharedContextEntry[],
): string {
	if (contextMode === "isolated") return "";
	const lines: string[] = [];
	lines.push("<shared_context>");
	lines.push(`run_id: ${envelope.runId}`);
	lines.push(`task_id: ${envelope.taskId}`);
	if (envelope.parentTaskId) lines.push(`parent_task_id: ${envelope.parentTaskId}`);
	lines.push(`context_mode: ${contextMode}`);
	lines.push("recent_entries:");
	if (recentEntries.length === 0) {
		lines.push("- none");
	} else {
		for (const entry of recentEntries) {
			lines.push(`- ${summarizeEntry(entry)}`);
		}
	}
	lines.push("</shared_context>");
	lines.push("Use shared_context as the source of truth when relevant. Do not duplicate long excerpts.");
	return lines.join("\n");
}
