import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const DEFAULT_URL = "https://mem.icvida.com/mcp";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_MEMORY_MODE = "auto";
const DEFAULT_ALLOW_SECRETS = false;
const DEFAULT_SEARCH_QUERY_MAX_CHARS = 1000;
const MIN_SEARCH_QUERY_MAX_CHARS = 120;
const MAX_SEARCH_QUERY_MAX_CHARS = 4000;

const DOMAIN_VALUES = ["technical", "personal", "work", "learning", "communication", "creative"] as const;
const MEMORY_TYPE_VALUES = ["working", "short-term", "long-term", "episodic", "procedural"] as const;
const RETENTION_POLICY_VALUES = ["temporary", "standard", "permanent"] as const;
const SENSITIVITY_VALUES = ["low", "medium", "high", "critical"] as const;
const RELATIONSHIP_TYPE_VALUES = [
	"parent",
	"child",
	"related",
	"references",
	"contradicts",
	"updates",
	"supports",
] as const;

const DOMAIN_SET = new Set<string>(DOMAIN_VALUES);
const MEMORY_TYPE_SET = new Set<string>(MEMORY_TYPE_VALUES);

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"how",
	"i",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"we",
	"with",
	"you",
]);

type Domain = (typeof DOMAIN_VALUES)[number];
type MemoryType = (typeof MEMORY_TYPE_VALUES)[number];
type MemoryMode = "off" | "assist" | "auto" | "strict";

interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

interface JsonRpcSuccessResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	result: unknown;
}

interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	error: JsonRpcErrorObject;
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

interface ToolContentPart {
	type?: string;
	text?: string;
	mimeType?: string;
	data?: string;
	url?: string;
}

interface ToolCallResult {
	content?: ToolContentPart[];
	structuredContent?: unknown;
	isError?: boolean;
}

interface InitializeResult {
	protocolVersion?: string;
	capabilities?: unknown;
	serverInfo?: {
		name?: string;
		version?: string;
	};
}

interface MemoryCandidate {
	memoryId: string;
	domain: string;
	memoryType: string;
	createdAt?: string;
	content: string;
	rankIndex: number;
}

interface RecommendationCandidate {
	memoryId: string;
	score: number;
	reasons: string[];
}

interface ConversationCandidate {
	rankIndex: number;
	sessionId?: string;
	exchangeId?: string;
	summary: string;
	scoreHint?: number;
}

interface RankedMemory extends MemoryCandidate {
	scores: {
		semantic: number;
		text: number;
		graph: number;
		recency: number;
		importance: number;
		project: number;
		final: number;
	};
	whySelected: string[];
}

interface RecallScope {
	projectPath?: string;
	domain?: Domain;
	memoryTypes?: MemoryType[];
	includeConversations?: boolean;
	includeRecommendations?: boolean;
}

interface QueryTelemetry {
	rawLength: number;
	sanitizedLength: number;
	maxChars: number;
	truncated: boolean;
}

interface RecallResult {
	query: string;
	queryTelemetry: QueryTelemetry;
	candidates: MemoryCandidate[];
	ranked: RankedMemory[];
	conversations: ConversationCandidate[];
	recommendations: RecommendationCandidate[];
	raw: {
		searchMemories: string;
		searchConversations?: string;
		recommendations?: string;
	};
}

interface ContextPacketResult {
	text: string;
	details: {
		mode: MemoryMode;
		budgetTokens: number;
		sliceBudgets: Record<string, number>;
		selectedMemoryIds: string[];
		retrievalTrace: Array<{ memoryId: string; score: number; why: string[] }>;
		conflicts: string[];
	};
}

type WriteCandidateKind = "preference" | "decision" | "procedure" | "environment";

interface ExtractedWriteCandidate {
	content: string;
	kind: WriteCandidateKind;
	memoryType: MemoryType;
	domain: Domain;
	confidence: number;
	source: "user" | "assistant";
	reason: string;
}

interface WritebackModeConfig {
	autoPersist: boolean;
	minConfidence: number;
	maxCandidatesPerTurn: number;
	duplicateSimilarityThreshold: number;
}

const MemoryModeSchema = StringEnum(["off", "assist", "auto", "strict"] as const, {
	description: "Memory autopilot mode.",
});

const RecallScopeSchema = Type.Object(
	{
		projectPath: Type.Optional(Type.String({ description: "Optional project path to scope conversation recall." })),
		domain: Type.Optional(StringEnum(DOMAIN_VALUES, { description: "Optional domain filter." })),
		memoryTypes: Type.Optional(
			Type.Array(StringEnum(MEMORY_TYPE_VALUES), {
				description: "Optional memory type filters.",
				maxItems: 5,
			}),
		),
		includeConversations: Type.Optional(Type.Boolean({ description: "Include conversation recall." })),
		includeRecommendations: Type.Optional(Type.Boolean({ description: "Include recommendation augmentation." })),
	},
	{ additionalProperties: false },
);

const MemoryRecallParams = Type.Object(
	{
		query: Type.String({ minLength: 1, maxLength: 2000, description: "Memory recall query." }),
		scope: Type.Optional(RecallScopeSchema),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 30, default: 8 })),
	},
	{ additionalProperties: false },
);

const MemoryStoreParams = Type.Object(
	{
		facts: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 10000 }), {
				maxItems: 25,
				description: "Durable facts to store.",
			}),
		),
		decisions: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 10000 }), {
				maxItems: 25,
				description: "Project decisions to store.",
			}),
		),
		procedures: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 10000 }), {
				maxItems: 25,
				description: "Reusable procedures/patterns.",
			}),
		),
		domain: Type.Optional(StringEnum(DOMAIN_VALUES, { description: "Domain classification." })),
		projectPath: Type.Optional(Type.String({ description: "Optional project path metadata." })),
		sessionId: Type.Optional(Type.String({ description: "Optional session identifier metadata." })),
	},
	{ additionalProperties: false },
);

const MemoryRecentParams = Type.Object(
	{
		projectPath: Type.Optional(Type.String({ description: "Optional project path for project-scoped recent exchanges." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
	},
	{ additionalProperties: false },
);

const RelationshipPatchSchema = Type.Object(
	{
		targetMemoryId: Type.String({ description: "Target memory UUID." }),
		relationshipType: StringEnum(RELATIONSHIP_TYPE_VALUES, { description: "Relationship type." }),
		strength: Type.Number({ minimum: 0, maximum: 1, description: "Relationship strength." }),
		metadata: Type.Optional(Type.Object({}, { additionalProperties: true })),
	},
	{ additionalProperties: false },
);

const MemoryUpdateParams = Type.Object(
	{
		memoryId: Type.String({ minLength: 1, description: "Memory UUID to update." }),
		patch: Type.Object(
			{
				content: Type.Optional(Type.String({ minLength: 1, maxLength: 1000000 })),
				tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 })),
				metadata: Type.Optional(Type.Object({}, { additionalProperties: true })),
				relationships: Type.Optional(Type.Array(RelationshipPatchSchema, { maxItems: 100 })),
				retentionPolicy: Type.Optional(StringEnum(RETENTION_POLICY_VALUES)),
				sensitivityLevel: Type.Optional(StringEnum(SENSITIVITY_VALUES)),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const MemoryStatsParams = Type.Object(
	{
		userId: Type.Optional(Type.String({ description: "Optional user ID filter." })),
	},
	{ additionalProperties: false },
);

const MemoryGetParams = Type.Object(
	{
		memoryId: Type.String({ minLength: 1, description: "Memory UUID to hydrate." }),
		includeRelated: Type.Optional(Type.Boolean({ description: "Include related memory pointers from graph traversal." })),
		relatedLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 5 })),
	},
	{ additionalProperties: false },
);

type MemoryRecallParams = Static<typeof MemoryRecallParams>;
type MemoryStoreParams = Static<typeof MemoryStoreParams>;
type MemoryRecentParams = Static<typeof MemoryRecentParams>;
type MemoryUpdateParams = Static<typeof MemoryUpdateParams>;
type MemoryStatsParams = Static<typeof MemoryStatsParams>;
type MemoryGetParams = Static<typeof MemoryGetParams>;

function getMemoryUrl(): string {
	return process.env.MONGO_MEMORY_URL || process.env.MCP_MEMORY_URL || DEFAULT_URL;
}

function getMemoryToken(): string {
	return process.env.MONGO_MEMORY_TOKEN || process.env.MCP_MEMORY_TOKEN || "";
}

function getMemoryProtocolVersion(): string {
	return process.env.MONGO_MEMORY_PROTOCOL_VERSION || process.env.MCP_MEMORY_PROTOCOL_VERSION || DEFAULT_PROTOCOL_VERSION;
}

function normalizeMode(mode: string | undefined): MemoryMode {
	if (mode === "off" || mode === "assist" || mode === "auto" || mode === "strict") {
		return mode;
	}
	return DEFAULT_MEMORY_MODE;
}

function getInitialMemoryMode(): MemoryMode {
	const envMode = process.env.MONGO_MEMORY_AUTOPILOT_MODE || process.env.MCP_MEMORY_AUTOPILOT_MODE;
	return normalizeMode(envMode);
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
	if (!value) {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "allow"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off", "block"].includes(normalized)) {
		return false;
	}
	return fallback;
}

function parsePositiveIntEnv(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}
	return parsed;
}

function getSearchQueryMaxChars(): number {
	const envValue =
		parsePositiveIntEnv(process.env.MONGO_MEMORY_QUERY_MAX_CHARS) ??
		parsePositiveIntEnv(process.env.MCP_MEMORY_QUERY_MAX_CHARS);
	const candidate = envValue ?? DEFAULT_SEARCH_QUERY_MAX_CHARS;
	return Math.max(MIN_SEARCH_QUERY_MAX_CHARS, Math.min(MAX_SEARCH_QUERY_MAX_CHARS, candidate));
}

function getInitialAllowSecrets(): boolean {
	return parseBooleanEnv(process.env.MONGO_MEMORY_ALLOW_SECRETS || process.env.MCP_MEMORY_ALLOW_SECRETS, DEFAULT_ALLOW_SECRETS);
}

function hasCliFlag(flagName: string): boolean {
	const full = `--${flagName}`;
	return process.argv.some((arg) => arg === full || arg.startsWith(`${full}=`));
}

function isDomainValue(value: string): value is Domain {
	return DOMAIN_SET.has(value);
}

function isMemoryTypeValue(value: string): value is MemoryType {
	return MEMORY_TYPE_SET.has(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asJsonRpcResponse(value: unknown): JsonRpcResponse | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	if (value.jsonrpc !== "2.0") {
		return undefined;
	}
	if ("error" in value && isObject(value.error)) {
		const code = value.error.code;
		const message = value.error.message;
		if (typeof code === "number" && typeof message === "string") {
			return {
				jsonrpc: "2.0",
				id: typeof value.id === "number" || typeof value.id === "string" || value.id === null ? value.id : null,
				error: {
					code,
					message,
					data: value.error.data,
				},
			};
		}
	}
	if ("result" in value) {
		return {
			jsonrpc: "2.0",
			id: typeof value.id === "number" || typeof value.id === "string" || value.id === null ? value.id : null,
			result: value.result,
		};
	}
	return undefined;
}

function tryParseJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function extractSseDataPayloads(text: string): string[] {
	const payloads: string[] = [];
	const lines = text.split(/\r?\n/);
	let currentData: string[] = [];

	for (const line of lines) {
		if (line.startsWith("data:")) {
			currentData.push(line.slice(5).trimStart());
			continue;
		}
		if (line.trim().length === 0) {
			if (currentData.length > 0) {
				payloads.push(currentData.join("\n"));
				currentData = [];
			}
		}
	}

	if (currentData.length > 0) {
		payloads.push(currentData.join("\n"));
	}

	return payloads;
}

function parseJsonRpcResponseText(text: string): JsonRpcResponse | undefined {
	const directParsed = tryParseJson(text);
	const directRpc = directParsed ? asJsonRpcResponse(directParsed) : undefined;
	if (directRpc) {
		return directRpc;
	}

	const payloads = extractSseDataPayloads(text);
	for (let index = payloads.length - 1; index >= 0; index -= 1) {
		const payload = payloads[index];
		if (!payload || payload === "[DONE]") {
			continue;
		}
		const parsed = tryParseJson(payload);
		if (!parsed) {
			continue;
		}
		const rpc = asJsonRpcResponse(parsed);
		if (rpc) {
			return rpc;
		}
	}

	return undefined;
}

function toToolCallResult(value: unknown): ToolCallResult {
	if (!isObject(value)) {
		return {};
	}
	const contentRaw = Array.isArray(value.content) ? value.content : [];
	const content: ToolContentPart[] = [];
	for (const item of contentRaw) {
		if (!isObject(item)) {
			continue;
		}
		content.push({
			type: typeof item.type === "string" ? item.type : undefined,
			text: typeof item.text === "string" ? item.text : undefined,
			mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
			data: typeof item.data === "string" ? item.data : undefined,
			url: typeof item.url === "string" ? item.url : undefined,
		});
	}
	return {
		content,
		structuredContent: value.structuredContent,
		isError: typeof value.isError === "boolean" ? value.isError : undefined,
	};
}

function flattenToolContent(result: ToolCallResult): string {
	const lines: string[] = [];
	for (const item of result.content ?? []) {
		if (item.text) {
			lines.push(item.text);
			continue;
		}
		if (item.type === "image" && item.mimeType && item.data) {
			lines.push(`[image: ${item.mimeType}, ${item.data.length} bytes (base64)]`);
			continue;
		}
		if (item.url) {
			lines.push(item.url);
		}
	}
	return lines.join("\n\n").trim();
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	let output = truncation.content;
	if (truncation.truncated) {
		output += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
	}
	return { text: output, truncated: truncation.truncated };
}

class MongoMemoryHttpClient {
	private readonly url: string;
	private readonly token: string;
	private readonly protocolVersion: string;
	private sessionId: string | undefined;
	private initialized = false;
	private requestCounter = 1;

	public constructor(url: string, token: string, protocolVersion: string) {
		this.url = url;
		this.token = token;
		this.protocolVersion = protocolVersion;
	}

	private nextRequestId(): number {
		const id = this.requestCounter;
		this.requestCounter += 1;
		return id;
	}

	private async post(method: string, params: unknown, id?: number, signal?: AbortSignal): Promise<JsonRpcResponse | undefined> {
		const body = id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.token}`,
			Accept: "application/json, text/event-stream",
		};
		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}

		const response = await fetch(this.url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});

		const sessionHeader = response.headers.get("mcp-session-id");
		if (sessionHeader && sessionHeader.trim().length > 0) {
			this.sessionId = sessionHeader;
		}

		const text = await response.text();
		if (!response.ok) {
			throw new Error(`MCP HTTP ${response.status}: ${text}`);
		}

		if (!text.trim()) {
			return undefined;
		}

		const rpc = parseJsonRpcResponseText(text);
		if (!rpc) {
			throw new Error(`MCP server returned unrecognized response payload: ${text}`);
		}
		if ("error" in rpc) {
			throw new Error(`MCP error ${rpc.error.code}: ${rpc.error.message}`);
		}
		return rpc;
	}

	public async ensureInitialized(signal?: AbortSignal): Promise<InitializeResult> {
		if (this.initialized) {
			return {};
		}

		try {
			const init = await this.post(
				"initialize",
				{
					protocolVersion: this.protocolVersion,
					capabilities: {},
					clientInfo: {
						name: "pi-mongo-memory-autopilot",
						version: "0.1.0",
					},
				},
				this.nextRequestId(),
				signal,
			);
			await this.post("notifications/initialized", {}, undefined, signal);
			this.initialized = true;
			return init && "result" in init ? (init.result as InitializeResult) : {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("already initialized")) {
				this.initialized = true;
				return {};
			}
			throw error;
		}
	}

	public async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ result: ToolCallResult; text: string }> {
		await this.ensureInitialized(signal);
		const rpc = await this.post(
			"tools/call",
			{
				name,
				arguments: args,
			},
			this.nextRequestId(),
			signal,
		);

		const result = toToolCallResult(rpc && "result" in rpc ? rpc.result : undefined);
		return {
			result,
			text: flattenToolContent(result),
		};
	}
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars - 3)}...`;
}

function sanitizeSearchQuery(query: string): { query: string; telemetry: QueryTelemetry } {
	const maxChars = getSearchQueryMaxChars();
	const normalized = query.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) {
		return {
			query: "context",
			telemetry: {
				rawLength: 0,
				sanitizedLength: "context".length,
				maxChars,
				truncated: false,
			},
		};
	}
	if (normalized.length <= maxChars) {
		return {
			query: normalized,
			telemetry: {
				rawLength: normalized.length,
				sanitizedLength: normalized.length,
				maxChars,
				truncated: false,
			},
		};
	}

	const compactTerms = getQueryTerms(normalized).slice(0, 64).join(" ").trim();
	const sanitized = compactTerms.length >= 24 ? clip(compactTerms, maxChars) : clip(normalized, maxChars);
	return {
		query: sanitized,
		telemetry: {
			rawLength: normalized.length,
			sanitizedLength: sanitized.length,
			maxChars,
			truncated: sanitized.length < normalized.length,
		},
	};
}

function safeNumber(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(1, value));
}

function getWritebackModeConfig(mode: MemoryMode): WritebackModeConfig {
	switch (mode) {
		case "strict":
			return {
				autoPersist: true,
				minConfidence: 0.9,
				maxCandidatesPerTurn: 2,
				duplicateSimilarityThreshold: 0.82,
			};
		case "assist":
			return {
				autoPersist: false,
				minConfidence: 0.88,
				maxCandidatesPerTurn: 2,
				duplicateSimilarityThreshold: 0.78,
			};
		case "auto":
			return {
				autoPersist: true,
				minConfidence: 0.76,
				maxCandidatesPerTurn: 4,
				duplicateSimilarityThreshold: 0.78,
			};
		default:
			return {
				autoPersist: false,
				minConfidence: 1,
				maxCandidatesPerTurn: 0,
				duplicateSimilarityThreshold: 1,
			};
	}
}

function normalizeForCompare(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function canonicalizeMemoryStatement(text: string): string {
	return text
		.replace(/^\s*[-*]\s*/, "")
		.replace(/^\s*(User preference|Project decision|Project constraint|Procedure|Environment fact):\s*/i, "")
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function getQueryTerms(query: string): string[] {
	return normalizeForCompare(query)
		.split(" ")
		.filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
}

function isLowSpecificityQuery(query: string): boolean {
	const normalized = normalizeForCompare(query);
	if (normalized.length === 0) {
		return true;
	}
	if (/^(ok|okay|continue|lets continue|let s continue|proceed|sounds good|ready|go ahead)$/i.test(normalized)) {
		return true;
	}
	const terms = getQueryTerms(query);
	return terms.length <= 1;
}

function projectAffinityScore(content: string, projectPath: string | undefined): number {
	if (!projectPath || projectPath.trim().length === 0) {
		return 0;
	}
	const normalizedPath = projectPath.toLowerCase();
	const segments = normalizedPath.split(/[\\/]+/).filter((segment) => segment.length >= 2);
	const basename = segments.length > 0 ? segments[segments.length - 1] : "";
	const cues = new Set<string>();
	if (basename.length >= 2) {
		cues.add(basename);
		for (const part of basename.split(/[^a-z0-9]+/)) {
			if (part.length >= 2) {
				cues.add(part);
			}
		}
	}
	for (const segment of segments.slice(-3)) {
		if (segment.length >= 3) {
			cues.add(segment);
		}
	}
	if (cues.size === 0) {
		return 0;
	}

	const lower = content.toLowerCase();
	let hits = 0;
	for (const cue of cues) {
		if (lower.includes(cue)) {
			hits += 1;
		}
	}
	return safeNumber(hits / Math.max(1, Math.min(4, cues.size)));
}

function splitCandidateSentences(text: string): string[] {
	return text
		.split(/\n+/)
		.flatMap((line) => line.split(/[.!?]\s+/))
		.map((line) => line.trim())
		.filter((line) => line.length >= 24 && line.length <= 320);
}

function tokenSet(text: string): Set<string> {
	const tokens = normalizeForCompare(text)
		.split(" ")
		.filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
	return new Set(tokens);
}

function jaccardSimilarity(a: string, b: string): number {
	const setA = tokenSet(a);
	const setB = tokenSet(b);
	if (setA.size === 0 || setB.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) {
			intersection += 1;
		}
	}
	const union = setA.size + setB.size - intersection;
	return union > 0 ? intersection / union : 0;
}

function containsSecretLikeContent(text: string): boolean {
	const patterns = [
		/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|password|passwd|secret)\s*[:=]\s*\S+/i,
		/\b(?:sk|rk|pk)_[a-z0-9]{16,}\b/i,
		/\bghp_[A-Za-z0-9]{20,}\b/,
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
		/\b[A-Za-z0-9+/]{40,}={0,2}\b/,
	];
	return patterns.some((pattern) => pattern.test(text));
}

function inferDomain(content: string): Domain {
	const lower = content.toLowerCase();
	if (/\b(family|health|personal|hobby|home)\b/.test(lower)) {
		return "personal";
	}
	if (/\b(meeting|client|deadline|roadmap|stakeholder)\b/.test(lower)) {
		return "work";
	}
	return "technical";
}

function scoreWriteCandidate(content: string, kind: WriteCandidateKind): number {
	let score = kind === "procedure" ? 0.76 : kind === "decision" ? 0.74 : kind === "preference" ? 0.72 : 0.7;
	if (/\b(must|never|always|required|do not|don't)\b/i.test(content)) {
		score += 0.1;
	}
	if (/`[^`]+`|\/[A-Za-z0-9_.\-/]+|\.ts\b|\.js\b|npm\b|typescript\b|python\b/i.test(content)) {
		score += 0.06;
	}
	if (/\b(maybe|might|could|probably|possibly)\b/i.test(content)) {
		score -= 0.12;
	}
	if (isLowValueMetaContent(content)) {
		score -= 0.3;
	}
	return safeNumber(score);
}

function isProcessMetaSentence(sentence: string): boolean {
	return /\b(phase\d|live-check|memory-debug|memory-flush|run exactly|please run now|paste|entries shown|debug report|context packet|continuity|write-back is active|step\s+\d+|if you reload|first run stored|memory mode set|probe exchange)\b/i.test(
		sentence,
	);
}

function extractWriteCandidates(userText: string, assistantText: string, allowSecrets: boolean): ExtractedWriteCandidate[] {
	const candidates: ExtractedWriteCandidate[] = [];
	const seenFingerprints = new Set<string>();

	const addCandidate = (content: string, kind: WriteCandidateKind, source: "user" | "assistant", reason: string): void => {
		const canonical = canonicalizeMemoryStatement(content);
		const normalized = normalizeForCompare(canonical);
		if (normalized.length < 24 || seenFingerprints.has(normalized)) {
			return;
		}
		if (!allowSecrets && containsSecretLikeContent(content)) {
			return;
		}
		seenFingerprints.add(normalized);
		const memoryType: MemoryType = kind === "procedure" ? "procedural" : "long-term";
		candidates.push({
			content,
			kind,
			memoryType,
			domain: inferDomain(content),
			confidence: scoreWriteCandidate(content, kind),
			source,
			reason,
		});
	};

	for (const sentence of splitCandidateSentences(userText)) {
		if (isProcessMetaSentence(sentence) || isLowValueMetaContent(sentence)) {
			continue;
		}
		if (/\b(i|we)\s+(prefer|like|want|need|always|never)\b/i.test(sentence)) {
			addCandidate(`User preference: ${sentence}`, "preference", "user", "user preference pattern");
		}
		if (
			/\b(project|repo|workspace|path|typescript|python|node|uses|configured)\b/i.test(sentence) &&
			!/\b(decision|procedure|constraint|step|checklist|phase)\b/i.test(sentence)
		) {
			addCandidate(`Environment fact: ${sentence}`, "environment", "user", "persistent environment pattern");
		}
	}

	for (const sentence of splitCandidateSentences(assistantText)) {
		if (isProcessMetaSentence(sentence) || isLowValueMetaContent(sentence)) {
			continue;
		}
		if (
			/\b(decision|decided|we will|adopt|chosen|standard|constraint)\b/i.test(sentence) &&
			/\b(project|repo|workspace|for this repo|in this repo|must|always|never)\b/i.test(sentence)
		) {
			addCandidate(`Project decision: ${sentence}`, "decision", "assistant", "decision pattern");
		}
		if (
			/\b(must|never|do not|don't|required|policy|guardrail)\b/i.test(sentence) &&
			/\b(project|repo|workspace|for this repo|in this repo|editing|files|validation|check)\b/i.test(sentence)
		) {
			addCandidate(`Project constraint: ${sentence}`, "decision", "assistant", "constraint pattern");
		}
		if (
			/\b(procedure|run|execute|command|when editing|prefer edit over write)\b/i.test(sentence) &&
			/`[^`]+`|\b(npm run check|prefer edit over write|before final|when editing)\b/i.test(sentence)
		) {
			addCandidate(`Procedure: ${sentence}`, "procedure", "assistant", "procedure pattern");
		}
	}

	return candidates.sort((a, b) => b.confidence - a.confidence);
}

function readTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const texts: string[] = [];
	for (const block of content) {
		if (!isObject(block)) {
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			texts.push(block.text);
		}
	}
	return texts.join("\n");
}

function readLatestUserMessageText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message) || entry.message.role !== "user") {
			continue;
		}
		return readTextContent(entry.message.content);
	}
	return "";
}

interface CustomEntrySnapshot {
	customType: string;
	data: unknown;
	timestamp?: number;
	id: string;
}

interface PersistedAutopilotSettings {
	allowSecrets?: boolean;
	mode?: MemoryMode;
	source?: string;
	updatedAt?: string;
}

function collectRecentCustomEntries(
	ctx: ExtensionContext,
	customTypes: ReadonlySet<string>,
	limit: number,
): CustomEntrySnapshot[] {
	const entries = ctx.sessionManager.getEntries();
	const snapshots: CustomEntrySnapshot[] = [];

	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (snapshots.length >= limit) {
			break;
		}
		const entry = entries[index];
		if (!isObject(entry) || entry.type !== "custom" || typeof entry.customType !== "string") {
			continue;
		}
		if (!customTypes.has(entry.customType)) {
			continue;
		}
		snapshots.push({
			customType: entry.customType,
			data: "data" in entry ? entry.data : undefined,
			timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
			id: typeof entry.id === "string" ? entry.id : "",
		});
	}

	return snapshots;
}

function readLatestPersistedAutopilotSettings(ctx: ExtensionContext): PersistedAutopilotSettings | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isObject(entry) || entry.type !== "custom" || entry.customType !== "mongo-memory-settings") {
			continue;
		}
		if (!isObject(entry.data)) {
			continue;
		}

		const settings: PersistedAutopilotSettings = {};
		if (typeof entry.data.allowSecrets === "boolean") {
			settings.allowSecrets = entry.data.allowSecrets;
		}
		if (typeof entry.data.mode === "string") {
			settings.mode = normalizeMode(entry.data.mode);
		}
		if (typeof entry.data.source === "string") {
			settings.source = entry.data.source;
		}
		if (typeof entry.data.updatedAt === "string") {
			settings.updatedAt = entry.data.updatedAt;
		}
		if (
			settings.allowSecrets !== undefined ||
			settings.mode !== undefined ||
			settings.source !== undefined ||
			settings.updatedAt !== undefined
		) {
			return settings;
		}
	}
	return undefined;
}

function formatWritebackCandidates(candidates: unknown): string[] {
	if (!Array.isArray(candidates)) {
		return [];
	}
	const lines: string[] = [];
	for (const candidate of candidates) {
		if (!isObject(candidate) || typeof candidate.content !== "string") {
			continue;
		}
		const kind = typeof candidate.kind === "string" ? candidate.kind : "unknown";
		const confidence = typeof candidate.confidence === "number" ? candidate.confidence.toFixed(2) : "?";
		const summary = summarizeMemoryTopic(candidate.content, 22);
		lines.push(`- ${kind} (confidence ${confidence}): ${summary}`);
	}
	return lines;
}

function formatTimestamp(timestamp: number | undefined): string {
	if (timestamp === undefined) {
		return "n/a";
	}
	try {
		return new Date(timestamp).toISOString();
	} catch {
		return "n/a";
	}
}

function parseStoredWriteCandidate(value: unknown): ExtractedWriteCandidate | undefined {
	if (!isObject(value) || typeof value.content !== "string") {
		return undefined;
	}
	const kind = value.kind;
	if (kind !== "preference" && kind !== "decision" && kind !== "procedure" && kind !== "environment") {
		return undefined;
	}

	const source = value.source;
	if (source !== "user" && source !== "assistant") {
		return undefined;
	}

	const domainRaw = typeof value.domain === "string" ? value.domain : "technical";
	const memoryTypeRaw = typeof value.memoryType === "string" ? value.memoryType : "long-term";
	const domain: Domain = isDomainValue(domainRaw) ? domainRaw : "technical";
	const memoryType: MemoryType = isMemoryTypeValue(memoryTypeRaw) ? memoryTypeRaw : "long-term";
	const confidence = typeof value.confidence === "number" ? safeNumber(value.confidence) : scoreWriteCandidate(value.content, kind);
	const reason = typeof value.reason === "string" ? value.reason : "manual flush";

	return {
		content: value.content,
		kind,
		memoryType,
		domain,
		confidence,
		source,
		reason,
	};
}

function readLatestWritebackSuggestion(ctx: ExtensionContext): {
	entryId: string;
	turnIndex?: number;
	candidates: ExtractedWriteCandidate[];
} | undefined {
	const snapshots = collectRecentCustomEntries(ctx, new Set(["mongo-memory-writeback-suggestion"]), 1);
	if (snapshots.length === 0) {
		return undefined;
	}
	const snapshot = snapshots[0];
	if (!isObject(snapshot.data) || !Array.isArray(snapshot.data.candidates)) {
		return undefined;
	}
	const candidates = snapshot.data.candidates
		.map((candidate) => parseStoredWriteCandidate(candidate))
		.filter((candidate): candidate is ExtractedWriteCandidate => candidate !== undefined);
	if (candidates.length === 0) {
		return undefined;
	}
	return {
		entryId: snapshot.id,
		turnIndex: typeof snapshot.data.turnIndex === "number" ? snapshot.data.turnIndex : undefined,
		candidates,
	};
}

function collectRecentCandidateFingerprints(ctx: ExtensionContext, limit: number): Set<string> {
	const snapshots = collectRecentCustomEntries(
		ctx,
		new Set(["mongo-memory-writeback", "mongo-memory-writeback-suggestion", "mongo-memory-flush"]),
		limit,
	);
	const fingerprints = new Set<string>();

	for (const snapshot of snapshots) {
		if (!isObject(snapshot.data)) {
			continue;
		}
		const candidateArrays: unknown[] = [];
		if (Array.isArray(snapshot.data.storedCandidates)) {
			candidateArrays.push(snapshot.data.storedCandidates);
		}
		if (Array.isArray(snapshot.data.candidates)) {
			candidateArrays.push(snapshot.data.candidates);
		}
		if (Array.isArray(snapshot.data.flushedCandidates)) {
			candidateArrays.push(snapshot.data.flushedCandidates);
		}

		for (const value of candidateArrays) {
			if (!Array.isArray(value)) {
				continue;
			}
			for (const candidate of value) {
				if (!isObject(candidate) || typeof candidate.content !== "string") {
					continue;
				}
				const fingerprint = normalizeForCompare(canonicalizeMemoryStatement(candidate.content));
				if (fingerprint.length >= 24) {
					fingerprints.add(fingerprint);
				}
			}
		}
	}

	return fingerprints;
}

function summarizeDroppedCandidates(
	dropped: Array<{ candidate: ExtractedWriteCandidate; reason: string }>,
): Array<{ reason: string; content: string }> {
	return dropped.map((item) => ({
		reason: item.reason,
		content: summarizeMemoryTopic(item.candidate.content, 18),
	}));
}

function isLowValueMetaContent(text: string): boolean {
	return /\b(phase\d|live-check|live checks|memory-debug|memory-flush|run exactly|please run now|paste the outputs|entries shown|debug report|write-back is active|step\s+\d+|context packet|added stricter|reduced user|smoke run|live validation turn|if you reload|first run stored|memory mode set|probe exchange)\b/i.test(
		text,
	);
}

function isSuppressedMemoryContent(text: string): boolean {
	const lower = text.toLowerCase();
	if (lower.includes("[removed_security_threat]") || lower.includes("&#x2f;") || lower.includes("&quot;")) {
		return true;
	}
	return isLowValueMetaContent(text);
}

function isNoisyConversationCandidate(candidate: ConversationCandidate): boolean {
	const session = (candidate.sessionId ?? "").toLowerCase();
	const summary = candidate.summary.toLowerCase();
	const normalizedSummary = normalizeConversationSummary(candidate.summary);
	if (session.startsWith("smoke-session-") || session.startsWith("phase3-test-")) {
		return true;
	}
	if (/\b(phase\d|phase3-live-check|live-check|live checks|memory-debug|memory-flush|run exactly|if you reload|first run stored|entries shown|debug report|probe exchange)\b/i.test(summary)) {
		return true;
	}
	if (/\b(preference|decision)\s+\d{10,}\b/i.test(summary) || /architecture rule marker-\d{10,}/i.test(summary)) {
		return true;
	}
	if (/^(ok|okay|sure|done|got it|lets continue|let s continue|continue|sounds good|ready)(\b|$)/i.test(normalizedSummary)) {
		const terms = normalizedSummary.split(" ").filter((term) => term.length > 0);
		if (terms.length <= 5) {
			return true;
		}
	}
	return false;
}

function getNoiseReasons(text: string): string[] {
	const reasons: string[] = [];
	const lower = text.toLowerCase();
	if (isLowValueMetaContent(text)) {
		reasons.push("meta-process-content");
	}
	if (lower.includes("[removed_security_threat]") || lower.includes("&#x2f;") || lower.includes("&quot;")) {
		reasons.push("sanitized-secret-placeholder");
	}
	if (/architecture rule marker-\d{10,}/i.test(text)) {
		reasons.push("synthetic-marker");
	}
	if (/\b(preference|decision)\s+\d{10,}\b/i.test(text)) {
		reasons.push("timestamped-test-entry");
	}
	return reasons;
}

function isHighConfidenceNoise(item: NoiseMemoryCandidate): boolean {
	return item.reasons.some((reason) =>
		reason === "meta-process-content" || reason === "synthetic-marker" || reason === "timestamped-test-entry",
	);
}

async function applyNoiseTags(
	client: MongoMemoryHttpClient,
	items: NoiseMemoryCandidate[],
	signal?: AbortSignal,
): Promise<{ updated: string[]; failed: Array<{ memoryId: string; error: string }> }> {
	const updated: string[] = [];
	const failed: Array<{ memoryId: string; error: string }> = [];

	for (const item of items) {
		const tags = ["autopilot:noise"];
		for (const reason of item.reasons) {
			tags.push(`autopilot:noise:${reason}`);
		}
		const result = await safeCallTool(
			client,
			"updateMemory",
			{
				memoryId: item.memoryId,
				tags,
				metadata: {
					autopilotNoise: true,
					autopilotNoiseReasons: item.reasons,
					autopilotNoiseTaggedAt: new Date().toISOString(),
					autopilotNoiseSource: "memory-prune-noise",
				},
			},
			signal,
		);
		if (!result.ok) {
			failed.push({ memoryId: item.memoryId, error: result.error });
			continue;
		}
		updated.push(item.memoryId);
	}

	return { updated, failed };
}

interface NoiseMemoryCandidate {
	memoryId: string;
	content: string;
	domain: string;
	memoryType: string;
	reasons: string[];
}

async function collectNoiseMemoryCandidates(
	client: MongoMemoryHttpClient,
	limitPerQuery: number,
	signal?: AbortSignal,
): Promise<NoiseMemoryCandidate[]> {
	const queries = [
		"PHASE3-LIVE-CHECK",
		"memory-debug",
		"memory-flush",
		"run exactly",
		"if you reload",
		"first run stored",
		"probe exchange",
		"architecture rule marker",
		"[REMOVED_SECURITY_THREAT]",
		"smoke-session",
	];

	const byId = new Map<string, NoiseMemoryCandidate>();
	for (const query of queries) {
		const result = await safeCallTool(
			client,
			"searchMemories",
			{
				query,
				limit: Math.max(1, Math.min(50, limitPerQuery)),
			},
			signal,
		);
		if (!result.ok) {
			continue;
		}

		const matches = parseSearchMemories(result.text);
		for (const match of matches) {
			const reasons = getNoiseReasons(match.content);
			if (reasons.length === 0) {
				continue;
			}
			const existing = byId.get(match.memoryId);
			if (existing) {
				for (const reason of reasons) {
					if (!existing.reasons.includes(reason)) {
						existing.reasons.push(reason);
					}
				}
				continue;
			}
			byId.set(match.memoryId, {
				memoryId: match.memoryId,
				content: match.content,
				domain: match.domain,
				memoryType: match.memoryType,
				reasons: [...reasons],
			});
		}
	}

	return [...byId.values()].sort((a, b) => b.reasons.length - a.reasons.length || a.memoryId.localeCompare(b.memoryId));
}

function hasStoredConversationForTurn(
	ctx: ExtensionContext,
	sessionId: string,
	turnIndex: number,
): boolean {
	const snapshots = collectRecentCustomEntries(ctx, new Set(["mongo-memory-conversation"]), 80);
	for (const snapshot of snapshots) {
		if (!isObject(snapshot.data)) {
			continue;
		}
		if (snapshot.data.stored !== true) {
			continue;
		}
		if (snapshot.data.sessionId !== sessionId) {
			continue;
		}
		if (snapshot.data.turnIndex === turnIndex) {
			return true;
		}
	}
	return false;
}

function hasRecentConversationUserFingerprint(
	ctx: ExtensionContext,
	sessionId: string,
	userFingerprint: string,
): boolean {
	const snapshots = collectRecentCustomEntries(ctx, new Set(["mongo-memory-conversation"]), 20);
	let checked = 0;
	for (const snapshot of snapshots) {
		if (!isObject(snapshot.data)) {
			continue;
		}
		if (snapshot.data.stored !== true || snapshot.data.sessionId !== sessionId) {
			continue;
		}
		checked += 1;
		if (snapshot.data.userFingerprint === userFingerprint) {
			return true;
		}
		if (checked >= 6) {
			break;
		}
	}
	return false;
}

async function dropDuplicateWriteCandidates(
	client: MongoMemoryHttpClient,
	candidates: ExtractedWriteCandidate[],
	threshold: number,
	signal?: AbortSignal,
): Promise<{ kept: ExtractedWriteCandidate[]; dropped: Array<{ candidate: ExtractedWriteCandidate; reason: string }> }> {
	const kept: ExtractedWriteCandidate[] = [];
	const dropped: Array<{ candidate: ExtractedWriteCandidate; reason: string }> = [];

	for (const candidate of candidates) {
		const canonicalCandidate = canonicalizeMemoryStatement(candidate.content);
		const result = await safeCallTool(
			client,
			"searchMemories",
			{
				query: clip(canonicalCandidate, 180),
				domain: candidate.domain,
				limit: 3,
			},
			signal,
		);
		if (!result.ok) {
			kept.push(candidate);
			continue;
		}
		const existing = parseSearchMemories(result.text);
		const bestSimilarity = existing.reduce((best, memory) => {
			const canonicalExisting = canonicalizeMemoryStatement(memory.content);
			return Math.max(best, jaccardSimilarity(canonicalCandidate, canonicalExisting));
		}, 0);
		if (bestSimilarity >= threshold) {
			dropped.push({ candidate, reason: `near-duplicate similarity=${bestSimilarity.toFixed(2)}` });
			continue;
		}
		kept.push(candidate);
	}

	return { kept, dropped };
}

function queryTerms(query: string): string[] {
	return Array.from(new Set(getQueryTerms(query)));
}

function keywordOverlapScore(query: string, content: string): number {
	const terms = queryTerms(query);
	if (terms.length === 0) {
		return 0.25;
	}
	const text = content.toLowerCase();
	let hits = 0;
	for (const term of terms) {
		if (text.includes(term)) {
			hits += 1;
		}
	}
	return safeNumber(hits / terms.length);
}

function recencyScore(createdAt: string | undefined): number {
	if (!createdAt) {
		return 0.25;
	}
	const timestamp = Date.parse(createdAt);
	if (!Number.isFinite(timestamp)) {
		return 0.25;
	}
	const ageMs = Date.now() - timestamp;
	if (ageMs <= 0) {
		return 1;
	}
	const ageDays = ageMs / (1000 * 60 * 60 * 24);
	return safeNumber(1 / (1 + ageDays / 30));
}

function importanceScore(candidate: MemoryCandidate): number {
	const type = candidate.memoryType.toLowerCase();
	let score = 0.5;
	if (type === "procedural") score = 0.9;
	else if (type === "long-term") score = 0.85;
	else if (type === "episodic") score = 0.65;
	else if (type === "working") score = 0.45;
	else if (type === "short-term") score = 0.4;

	const lc = candidate.content.toLowerCase();
	if (/\b(must|always|never|do not|don't|required|constraint|rule|policy)\b/.test(lc)) {
		score += 0.08;
	}
	if (/\b(decision|decided|chosen|choose|adopt|standard)\b/.test(lc)) {
		score += 0.08;
	}
	return safeNumber(score);
}

function parseSearchMemories(text: string): MemoryCandidate[] {
	const candidates: MemoryCandidate[] = [];
	const regex =
		/(?:^|\n)(\d+)\.\s+Memory ID:\s*([^\n]+)\n\s*Domain:\s*([^|\n]+)\|\s*Type:\s*([^\n]+)\n\s*Created:\s*([^\n]+)\n\s*Content:\s*([\s\S]*?)(?=\n\d+\.\s+Memory ID:|\n\nOperation ID:|$)/g;
	let match = regex.exec(text);
	while (match) {
		const rankIndex = Math.max(0, parseInt(match[1], 10) - 1);
		candidates.push({
			rankIndex,
			memoryId: match[2].trim(),
			domain: match[3].trim(),
			memoryType: match[4].trim(),
			createdAt: match[5].trim(),
			content: match[6].trim(),
		});
		match = regex.exec(text);
	}
	return candidates;
}

function parseRecommendations(text: string): RecommendationCandidate[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) {
		return [];
	}
	const payload = text.slice(start, end + 1);
	const parsed = tryParseJson(payload);
	if (!Array.isArray(parsed)) {
		return [];
	}
	const recommendations: RecommendationCandidate[] = [];
	for (const item of parsed) {
		if (!isObject(item) || typeof item.memoryId !== "string") {
			continue;
		}
		const rawScore = typeof item.score === "string" ? Number(item.score) : typeof item.score === "number" ? item.score : 0;
		const reasons = Array.isArray(item.reasons) ? item.reasons.filter((reason): reason is string => typeof reason === "string") : [];
		recommendations.push({
			memoryId: item.memoryId,
			score: Number.isFinite(rawScore) ? rawScore : 0,
			reasons,
		});
	}
	return recommendations;
}

function parseConversationSearch(text: string): ConversationCandidate[] {
	const results: ConversationCandidate[] = [];
	const richRegex =
		/(?:^|\n)(\d+)\.\s+\[([^\]]+)\]\s+sessionId:\s*([^|\n]+)\|\s*exchangeId:\s*([^\n]+)\n\s*([\s\S]*?)(?:\(score:\s*([0-9.]+)\))?(?=\n\d+\.\s+\[|\n\nUse getConversationsBySession|$)/g;
	let richMatch = richRegex.exec(text);
	while (richMatch) {
		results.push({
			rankIndex: Math.max(0, parseInt(richMatch[1], 10) - 1),
			sessionId: richMatch[3].trim(),
			exchangeId: richMatch[4].trim(),
			summary: richMatch[5].trim(),
			scoreHint: richMatch[6] ? Number(richMatch[6]) : undefined,
		});
		richMatch = richRegex.exec(text);
	}
	if (results.length > 0) {
		return results;
	}

	const simpleRegex = /(?:^|\n)(\d+)\.\s+\[([^\]]+)\]\s+([^\n]+)(?=\n\d+\.\s+\[|\n\n|$)/g;
	let simpleMatch = simpleRegex.exec(text);
	while (simpleMatch) {
		results.push({
			rankIndex: Math.max(0, parseInt(simpleMatch[1], 10) - 1),
			summary: `[${simpleMatch[2].trim()}] ${simpleMatch[3].trim()}`,
		});
		simpleMatch = simpleRegex.exec(text);
	}
	return results;
}

function parseConversationsBySessionText(text: string): ConversationCandidate[] {
	const results: ConversationCandidate[] = [];
	const sessionMatch = text.match(/Session\s+([^:]+):/i);
	const sessionId = sessionMatch?.[1]?.trim();
	const turnRegex = /(?:^|\n)Turn\s+(\d+):\s*([^\n]+)(?=\nTurn\s+\d+:|\n\n|$)/g;
	let turnMatch = turnRegex.exec(text);
	while (turnMatch) {
		const turnNumber = Number.parseInt(turnMatch[1], 10);
		results.push({
			rankIndex: Number.isFinite(turnNumber) ? Math.max(0, turnNumber - 1) : results.length,
			sessionId,
			summary: turnMatch[2].trim(),
		});
		turnMatch = turnRegex.exec(text);
	}
	return results;
}

function normalizeConversationSummary(summary: string): string {
	let value = summary.replace(/\(score:\s*[0-9.]+\)\s*$/i, "").trim();
	value = value.replace(/^\[[0-9]{4}-[0-9]{2}-[0-9]{2}\]\s*/, "");
	value = value.replace(/^\[[^\]]+\]\s*/, "");
	return normalizeForCompare(value);
}

function mergeConversationCandidates(
	lists: ConversationCandidate[][],
	limit: number,
): ConversationCandidate[] {
	const merged: ConversationCandidate[] = [];
	const seen = new Set<string>();

	for (const list of lists) {
		for (const item of list) {
			const normalizedSummary = normalizeConversationSummary(item.summary);
			const key = normalizedSummary.length > 0 ? normalizedSummary : normalizeForCompare(item.summary);
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			merged.push(item);
			if (merged.length >= limit) {
				return merged;
			}
		}
	}

	return merged;
}

function rankCandidates(
	query: string,
	candidates: MemoryCandidate[],
	recommendations: RecommendationCandidate[],
	memoryTypeFilter?: MemoryType[],
	projectPath?: string,
): RankedMemory[] {
	const recommendationMap = new Map<string, RecommendationCandidate>();
	for (const recommendation of recommendations) {
		recommendationMap.set(recommendation.memoryId, recommendation);
	}

	const lowSpecificityQuery = isLowSpecificityQuery(query);
	const total = Math.max(1, candidates.length);
	const filteredByType = memoryTypeFilter && memoryTypeFilter.length > 0
		? candidates.filter((candidate) => memoryTypeFilter.includes(candidate.memoryType as MemoryType))
		: candidates;
	const filtered = filteredByType.filter((candidate) => !isSuppressedMemoryContent(candidate.content));

	return filtered
		.map((candidate, index) => {
			const recommendation = recommendationMap.get(candidate.memoryId);
			const semantic = recommendation ? safeNumber(recommendation.score) : safeNumber((total - index) / total);
			const textScore = keywordOverlapScore(query, candidate.content);
			const graph = recommendation && recommendation.reasons.some((reason) => reason !== "similarity") ? 0.6 : 0.2;
			const recency = recencyScore(candidate.createdAt);
			const importance = importanceScore(candidate);
			const project = projectAffinityScore(candidate.content, projectPath);
			let final = lowSpecificityQuery
				? 0.22 * semantic + 0.12 * textScore + 0.1 * graph + 0.28 * recency + 0.13 * importance + 0.15 * project
				: 0.42 * semantic + 0.18 * textScore + 0.12 * graph + 0.1 * recency + 0.1 * importance + 0.08 * project;
			if (lowSpecificityQuery && textScore < 0.2 && recency < 0.35 && project < 0.2) {
				final -= 0.2;
			}
			if (isLowValueMetaContent(candidate.content)) {
				final -= 0.28;
			}

			const why: string[] = [];
			if (semantic >= 0.75) why.push("high semantic similarity");
			if (textScore >= 0.5) why.push("high lexical match");
			if (graph >= 0.6) why.push("recommendation graph signal");
			if (recency >= 0.6) why.push("recent memory");
			if (importance >= 0.8) why.push("high-importance memory type");
			if (project >= 0.5) why.push("project-path affinity");
			if (recommendation?.reasons.length) {
				why.push(`recommended by ${recommendation.reasons.join(", ")}`);
			}
			if (why.length === 0) {
				why.push("top-ranked baseline recall");
			}

			return {
				...candidate,
				scores: {
					semantic: safeNumber(semantic),
					text: safeNumber(textScore),
					graph: safeNumber(graph),
					recency: safeNumber(recency),
					importance: safeNumber(importance),
					project: safeNumber(project),
					final: safeNumber(final),
				},
				whySelected: why,
			};
		})
		.sort((a, b) => b.scores.final - a.scores.final);
}

function computePacketBudget(contextWindow: number | undefined, mode: MemoryMode): number {
	const base = contextWindow && Number.isFinite(contextWindow) ? Math.floor(contextWindow * 0.12) : 1400;
	const clamped = Math.max(500, Math.min(3200, base));
	if (mode === "strict") {
		return Math.max(400, Math.floor(clamped * 0.75));
	}
	if (mode === "assist") {
		return Math.max(450, Math.floor(clamped * 0.9));
	}
	return clamped;
}

function selectByBudget<T>(
	items: T[],
	budgetTokens: number,
	toLine: (item: T) => { text: string; tokens: number },
): { selected: T[]; lines: string[]; usedTokens: number } {
	const selected: T[] = [];
	const lines: string[] = [];
	let usedTokens = 0;

	for (const item of items) {
		const line = toLine(item);
		if (line.tokens + usedTokens > budgetTokens) {
			continue;
		}
		selected.push(item);
		lines.push(line.text);
		usedTokens += line.tokens;
	}

	return { selected, lines, usedTokens };
}

function detectConflicts(memories: RankedMemory[]): string[] {
	const conflicts: string[] = [];
	const positives = new Map<string, RankedMemory[]>();
	const negatives = new Map<string, RankedMemory[]>();

	for (const memory of memories) {
		const text = memory.content.toLowerCase();
		const positiveMatch = text.match(/\b(?:always use|use|prefer)\s+([a-z0-9._\-/]+)/i);
		if (positiveMatch?.[1]) {
			const key = positiveMatch[1];
			positives.set(key, [...(positives.get(key) ?? []), memory]);
		}
		const negativeMatch = text.match(/\b(?:never use|avoid|do not use|don't use)\s+([a-z0-9._\-/]+)/i);
		if (negativeMatch?.[1]) {
			const key = negativeMatch[1];
			negatives.set(key, [...(negatives.get(key) ?? []), memory]);
		}
	}

	for (const [key, positiveMemories] of positives) {
		const negativeMemories = negatives.get(key);
		if (!negativeMemories || positiveMemories.length === 0) {
			continue;
		}
		const firstPositive = positiveMemories[0];
		const firstNegative = negativeMemories[0];
		conflicts.push(
			`Potential contradiction for '${key}': ${firstPositive.memoryId} vs ${firstNegative.memoryId}`,
		);
	}

	return conflicts;
}

function summarizeMemoryTopic(content: string, maxWords = 18): string {
	const normalized = content.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) {
		return "(empty memory)";
	}
	const firstSentence = normalized.split(/[.!?]\s+/)[0] ?? normalized;
	const words = firstSentence.split(" ").filter((word) => word.length > 0).slice(0, maxWords);
	return clip(words.join(" "), 140);
}

function buildMemoryLine(item: RankedMemory): string {
	const topic = summarizeMemoryTopic(item.content);
	const reasons = item.whySelected.slice(0, 3).join(", ");
	return `- [${item.memoryId}] (score ${item.scores.final.toFixed(2)}) domain:${item.domain} type:${item.memoryType}\n  about: ${topic}\n  why: ${reasons}\n  load full: memory_get(memoryId=\"${item.memoryId}\")`;
}

function buildConversationLine(item: ConversationCandidate): string {
	const idPart = item.sessionId ? `[${item.sessionId}]` : "[session]";
	const preview = clip(item.summary.replace(/\s+/g, " "), 220);
	return `- ${idPart} ${preview}`;
}

async function safeCallTool(
	client: MongoMemoryHttpClient,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ ok: true; text: string; result: ToolCallResult } | { ok: false; error: string }> {
	try {
		const called = await client.callTool(name, args, signal);
		return { ok: true, text: called.text, result: called.result };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function runRecall(
	client: MongoMemoryHttpClient,
	query: string,
	scope: RecallScope,
	limit: number,
	signal?: AbortSignal,
): Promise<RecallResult> {
	const includeConversations = scope.includeConversations ?? true;
	const includeRecommendations = scope.includeRecommendations ?? true;
	const candidateLimit = Math.max(limit * 3, 12);
	const sanitized = sanitizeSearchQuery(query);
	const searchQuery = sanitized.query;

	const searchMemoriesResult = await safeCallTool(
		client,
		"searchMemories",
		{
			query: searchQuery,
			domain: scope.domain,
			limit: Math.min(candidateLimit, 50),
		},
		signal,
	);
	if (!searchMemoriesResult.ok) {
		throw new Error(`searchMemories failed: ${searchMemoriesResult.error}`);
	}

	const candidates = parseSearchMemories(searchMemoriesResult.text);
	let recommendations: RecommendationCandidate[] = [];
	let recommendationRaw: string | undefined;

	if (includeRecommendations) {
		const recommendationResult = await safeCallTool(
			client,
			"getRecommendations",
			{ query: searchQuery, limit: Math.min(limit, 10) },
			signal,
		);
		if (recommendationResult.ok) {
			recommendationRaw = recommendationResult.text;
			recommendations = parseRecommendations(recommendationResult.text);
		}
	}

	let conversations: ConversationCandidate[] = [];
	let conversationsRaw: string | undefined;
	if (includeConversations) {
		const conversationSearchResult = await safeCallTool(
			client,
			"searchConversations",
			{
				query: searchQuery,
				projectPath: scope.projectPath,
				limit: Math.min(candidateLimit, 100),
			},
			signal,
		);
		if (conversationSearchResult.ok) {
			conversationsRaw = conversationSearchResult.text;
			conversations = parseConversationSearch(conversationSearchResult.text).filter((item) => !isNoisyConversationCandidate(item));
		}
	}

	const ranked = rankCandidates(query, candidates, recommendations, scope.memoryTypes, scope.projectPath);

	return {
		query,
		queryTelemetry: sanitized.telemetry,
		candidates,
		ranked,
		conversations,
		recommendations,
		raw: {
			searchMemories: searchMemoriesResult.text,
			searchConversations: conversationsRaw,
			recommendations: recommendationRaw,
		},
	};
}

async function getRecentConversations(
	client: MongoMemoryHttpClient,
	projectPath: string | undefined,
	limit: number,
	signal?: AbortSignal,
): Promise<{ text: string; items: ConversationCandidate[] }> {
	const toolName = projectPath ? "getConversationsByProject" : "getRecentConversations";
	const args = projectPath
		? ({ projectPath, limit: Math.min(limit, 500) } as Record<string, unknown>)
		: ({ limit: Math.min(limit, 200) } as Record<string, unknown>);

	const result = await safeCallTool(client, toolName, args, signal);
	if (!result.ok) {
		throw new Error(`${toolName} failed: ${result.error}`);
	}
	const parsed = parseConversationSearch(result.text).filter((item) => !isNoisyConversationCandidate(item));
	return {
		text: result.text,
		items: parsed,
	};
}

async function getContinuityConversations(
	client: MongoMemoryHttpClient,
	projectPath: string,
	sessionId: string | undefined,
	query: string,
	limit: number,
	signal?: AbortSignal,
): Promise<{
	items: ConversationCandidate[];
	trace: {
		queryHits: number;
		projectHits: number;
		sessionHits: number;
		queryTelemetry: QueryTelemetry;
	};
}> {
	const sanitized = sanitizeSearchQuery(query);
	const queryResult = await safeCallTool(
		client,
		"searchConversations",
		{
			query: sanitized.query,
			projectPath,
			limit: Math.min(limit, 100),
		},
		signal,
	);
	const projectResult = await safeCallTool(
		client,
		"getConversationsByProject",
		{
			projectPath,
			limit: Math.min(Math.max(limit, 20), 500),
		},
		signal,
	);
	const sessionResult = sessionId
		? await safeCallTool(
				client,
				"getConversationsBySession",
				{
					sessionId,
				},
				signal,
			)
		: undefined;

	const queryItems = queryResult.ok ? parseConversationSearch(queryResult.text).filter((item) => !isNoisyConversationCandidate(item)) : [];
	const projectItems = projectResult.ok ? parseConversationSearch(projectResult.text).filter((item) => !isNoisyConversationCandidate(item)) : [];
	const sessionItems =
		sessionResult && sessionResult.ok
			? parseConversationsBySessionText(sessionResult.text).filter((item) => !isNoisyConversationCandidate(item))
			: [];

	return {
		items: mergeConversationCandidates([sessionItems, queryItems, projectItems], limit),
		trace: {
			queryHits: queryItems.length,
			projectHits: projectItems.length,
			sessionHits: sessionItems.length,
			queryTelemetry: sanitized.telemetry,
		},
	};
}

function extractTopSentences(text: string, pattern: RegExp, limit: number): string[] {
	const results: string[] = [];
	for (const sentence of splitCandidateSentences(text)) {
		if (!pattern.test(sentence)) {
			continue;
		}
		results.push(clip(sentence, 240));
		if (results.length >= limit) {
			break;
		}
	}
	return results;
}

function extractFilePathHints(text: string): string[] {
	const matches = text.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|py|sh|yaml|yml)/g) ?? [];
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const match of matches) {
		if (seen.has(match)) {
			continue;
		}
		seen.add(match);
		deduped.push(match);
		if (deduped.length >= 20) {
			break;
		}
	}
	return deduped;
}

function summarizeToolResults(toolResults: unknown): string[] {
	if (!Array.isArray(toolResults)) {
		return [];
	}
	const summaries: string[] = [];
	for (const toolResult of toolResults) {
		if (!isObject(toolResult)) {
			continue;
		}
		const lines: string[] = [];
		if (typeof toolResult.toolCallId === "string") {
			lines.push(`toolCallId:${toolResult.toolCallId}`);
		}
		const contentText = readTextContent("content" in toolResult ? toolResult.content : undefined);
		if (contentText.trim().length > 0) {
			lines.push(clip(contentText.replace(/\s+/g, " "), 180));
		}
		if (lines.length > 0) {
			summaries.push(lines.join(" | "));
		}
		if (summaries.length >= 12) {
			break;
		}
	}
	return summaries;
}

function composeCuratedConversation(
	userText: string,
	assistantText: string,
): {
	summary: string;
	intent: string;
	outcome: string;
	decisions: string[];
	codeChanges: string[];
} {
	return {
		summary: summarizeMemoryTopic(`${userText} ${assistantText}`, 26),
		intent: summarizeMemoryTopic(userText, 20),
		outcome: summarizeMemoryTopic(assistantText, 24),
		decisions: extractTopSentences(assistantText, /\b(decision|decided|must|never|always|constraint|policy)\b/i, 6),
		codeChanges: extractFilePathHints(`${assistantText}\n${userText}`),
	};
}

function composeRawConversation(
	userText: string,
	assistantText: string,
	toolResults: unknown,
): {
	userMessage: string;
	assistantResponse: string;
	toolCalls: string[];
	filesTouched: string[];
} {
	const toolSummaries = summarizeToolResults(toolResults);
	const filesTouched = extractFilePathHints(`${assistantText}\n${userText}\n${toolSummaries.join("\n")}`);
	return {
		userMessage: clip(userText, 6000),
		assistantResponse: clip(assistantText, 12000),
		toolCalls: toolSummaries,
		filesTouched,
	};
}

function extractConversationExchangeId(text: string): string | undefined {
	const match = text.match(/exchange\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
	return match?.[1];
}

function composeContextPacket(
	prompt: string,
	cwd: string,
	mode: MemoryMode,
	contextWindow: number | undefined,
	recall: RecallResult,
	recentConversations: ConversationCandidate[],
): ContextPacketResult | undefined {
	const budgetTokens = computePacketBudget(contextWindow, mode);
	const sliceBudgets = {
		relevant: Math.floor(budgetTokens * 0.35),
		recency: Math.floor(budgetTokens * 0.25),
		decisions: Math.floor(budgetTokens * 0.2),
		constraints: Math.floor(budgetTokens * 0.1),
		contingency: Math.floor(budgetTokens * 0.1),
	};

	const lowSpecificityQuery = isLowSpecificityQuery(prompt);
	const minScore = mode === "strict" ? 0.55 : lowSpecificityQuery ? 0.6 : 0.35;
	const ranked = recall.ranked.filter((memory) => memory.scores.final >= minScore);
	if (ranked.length === 0 && recentConversations.length === 0) {
		return undefined;
	}

	const usedMemoryIds = new Set<string>();
	const relevantSelection = selectByBudget(
		ranked,
		sliceBudgets.relevant,
		(item) => {
			if (usedMemoryIds.has(item.memoryId)) {
				return { text: "", tokens: Number.MAX_SAFE_INTEGER };
			}
			const text = buildMemoryLine(item);
			return { text, tokens: estimateTokens(text) };
		},
	);
	for (const item of relevantSelection.selected) {
		usedMemoryIds.add(item.memoryId);
	}

	const decisionCandidates = ranked.filter(
		(memory) =>
			/\b(decision|decided|adopt|chosen|standard|architecture|constraint)\b/i.test(memory.content) &&
			!usedMemoryIds.has(memory.memoryId),
	);
	const decisionSelection = selectByBudget(decisionCandidates, sliceBudgets.decisions, (item) => {
		const text = buildMemoryLine(item);
		return { text, tokens: estimateTokens(text) };
	});
	for (const item of decisionSelection.selected) {
		usedMemoryIds.add(item.memoryId);
	}

	const constraintCandidates = ranked.filter(
		(memory) =>
			/\b(must|always|never|do not|don't|required|rule|policy|guardrail|preference)\b/i.test(memory.content) &&
			!usedMemoryIds.has(memory.memoryId),
	);
	const constraintSelection = selectByBudget(constraintCandidates, sliceBudgets.constraints, (item) => {
		const text = buildMemoryLine(item);
		return { text, tokens: estimateTokens(text) };
	});
	for (const item of constraintSelection.selected) {
		usedMemoryIds.add(item.memoryId);
	}

	const recencySource = (recentConversations.length > 0 ? recentConversations : recall.conversations)
		.filter((item) => !isNoisyConversationCandidate(item))
		.slice(0, 10);
	const recencySelection = selectByBudget(
		recencySource,
		sliceBudgets.recency,
		(item) => {
			const text = buildConversationLine(item);
			return { text, tokens: estimateTokens(text) };
		},
	);

	const conflictCandidates = [
		...relevantSelection.selected,
		...decisionSelection.selected,
		...constraintSelection.selected,
	];
	const conflicts = detectConflicts(conflictCandidates);
	const contingencyLines = conflicts.length > 0 ? conflicts.map((conflict) => `- ${conflict}`) : ["- No high-confidence contradictions detected."];
	const contingencySelection = selectByBudget(contingencyLines, sliceBudgets.contingency, (line) => ({
		text: line,
		tokens: estimateTokens(line),
	}));

	const sections: string[] = [];
	sections.push("[mongo-memory context packet]");
	sections.push(`project: ${cwd}`);
	sections.push(`mode: ${mode}`);
	sections.push(`budget: ~${budgetTokens} tokens`);
	sections.push(`query: ${clip(prompt.replace(/\s+/g, " "), 180)}`);
	sections.push("");

	if (relevantSelection.lines.length > 0) {
		sections.push("## task-relevant semantic/procedural memory");
		sections.push(...relevantSelection.lines);
		sections.push("");
	}
	if (recencySelection.lines.length > 0) {
		sections.push("## recent episodic continuity");
		sections.push(...recencySelection.lines);
		sections.push("");
	}
	if (decisionSelection.lines.length > 0) {
		sections.push("## decisions and branch state");
		sections.push(...decisionSelection.lines);
		sections.push("");
	}
	if (constraintSelection.lines.length > 0) {
		sections.push("## constraints and guardrails");
		sections.push(...constraintSelection.lines);
		sections.push("");
	}
	sections.push("## contingencies");
	sections.push(...contingencySelection.lines);
	sections.push("");
	sections.push("This packet is pointer-first. Treat entries as memory references, not full facts.");
	sections.push("Hydrate full details only when needed with memory_get(memoryId=\"...\").");
	sections.push("If memory appears stale or conflicting, ask the user to confirm before acting.");

	const selectedTrace = [...relevantSelection.selected, ...decisionSelection.selected, ...constraintSelection.selected].map(
		(memory) => ({
			memoryId: memory.memoryId,
			score: memory.scores.final,
			why: memory.whySelected,
		}),
	);

	return {
		text: sections.join("\n").trim(),
		details: {
			mode,
			budgetTokens,
			sliceBudgets,
			selectedMemoryIds: selectedTrace.map((item) => item.memoryId),
			retrievalTrace: selectedTrace,
			conflicts,
		},
	};
}

function composeFallbackContextPacket(
	prompt: string,
	cwd: string,
	mode: MemoryMode,
	contextWindow: number | undefined,
	errorMessage: string,
	queryTelemetry: QueryTelemetry,
): ContextPacketResult {
	const budgetTokens = computePacketBudget(contextWindow, mode);
	const fallbackReason = clip(errorMessage.replace(/\s+/g, " "), 220);
	const lines: string[] = [];
	lines.push("[mongo-memory context packet]");
	lines.push(`project: ${cwd}`);
	lines.push(`mode: ${mode}`);
	lines.push(`budget: ~${budgetTokens} tokens (fallback)`);
	lines.push(`query: ${clip(prompt.replace(/\s+/g, " "), 180)}`);
	lines.push("");
	lines.push("## fallback continuity context");
	lines.push("- Remote memory recall is unavailable for this turn.");
	lines.push("- Continue using current prompt + immediate local session context.");
	lines.push("- Preserve user intent and repository constraints; ask for clarification only if essential inputs are missing.");
	lines.push("");
	lines.push("## recall telemetry");
	lines.push(
		`- query-length raw:${queryTelemetry.rawLength} sanitized:${queryTelemetry.sanitizedLength} max:${queryTelemetry.maxChars} truncated:${queryTelemetry.truncated}`,
	);
	lines.push("");
	lines.push("## contingencies");
	lines.push(`- Memory recall error: ${fallbackReason}`);
	lines.push("");
	lines.push("This packet is fail-open fallback context. Retry remote recall on the next turn.");

	return {
		text: lines.join("\n").trim(),
		details: {
			mode,
			budgetTokens,
			sliceBudgets: {
				relevant: 0,
				recency: 0,
				decisions: 0,
				constraints: 0,
				contingency: budgetTokens,
			},
			selectedMemoryIds: [],
			retrievalTrace: [],
			conflicts: [`fallback-recall-error: ${fallbackReason}`],
		},
	};
}

function missingTokenResult() {
	return {
		content: [
			{
				type: "text" as const,
				text: "Missing MONGO_MEMORY_TOKEN (or MCP_MEMORY_TOKEN). Set it in your environment and retry.",
			},
		],
		isError: true,
		details: {},
	};
}

export default function mongoMemoryAutopilotExtension(pi: ExtensionAPI): void {
	const client = new MongoMemoryHttpClient(getMemoryUrl(), getMemoryToken(), getMemoryProtocolVersion());
	let mode: MemoryMode = getInitialMemoryMode();
	let allowSecrets = getInitialAllowSecrets();

	const updateModeStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) {
			return;
		}
		const color = mode === "off" ? "dim" : mode === "strict" ? "warning" : "accent";
		ctx.ui.setStatus("mongo-memory", ctx.ui.theme.fg(color, `memory:${mode}`));
		ctx.ui.setStatus("mongo-memory-secrets", ctx.ui.theme.fg(allowSecrets ? "warning" : "muted", `secrets:${allowSecrets ? "allow" : "block"}`));
	};

	const filterCommandCompletions = (
		prefix: string,
		items: Array<{ value: string; description?: string }>,
	): Array<{ value: string; label: string; description?: string }> | null => {
		const normalized = prefix.trim().toLowerCase();
		const mapped = items.map((item) => ({
			value: item.value,
			label: item.value,
			description: item.description,
		}));
		if (normalized.length === 0) {
			return mapped;
		}
		const filtered = mapped.filter((item) => item.value.toLowerCase().startsWith(normalized));
		return filtered.length > 0 ? filtered : null;
	};

	pi.registerFlag("memory-mode", {
		description: "Mongo memory autopilot mode: off|assist|auto|strict",
		type: "string",
		default: DEFAULT_MEMORY_MODE,
	});

	pi.registerCommand("memory-mode", {
		description: "Set mongo-memory autopilot mode (off|assist|auto|strict)",
		getArgumentCompletions: (prefix) =>
			filterCommandCompletions(prefix, [
				{ value: "off", description: "Disable autopilot recall/write-back" },
				{ value: "assist", description: "Recall on; suggest write-back only" },
				{ value: "auto", description: "Recall on; automatic write-back" },
				{ value: "strict", description: "Conservative recall and write-back" },
			]),
		handler: async (args, ctx) => {
			const requested = normalizeMode(args?.trim());
			mode = requested;
			ctx.ui.notify(`Mongo memory mode set to '${mode}'`, "info");
			updateModeStatus(ctx);
		},
	});

	pi.registerFlag("memory-allow-secrets", {
		description: "Allow secret-like content to be auto-persisted by mongo-memory autopilot",
		type: "boolean",
	});

	pi.registerCommand("memory-secrets", {
		description: "Set mongo-memory secret handling (allow|block|status)",
		getArgumentCompletions: (prefix) =>
			filterCommandCompletions(prefix, [
				{ value: "status", description: "Show current secret handling mode" },
				{ value: "allow", description: "Allow secret-like content in write-back" },
				{ value: "block", description: "Block secret-like content in write-back" },
			]),
		handler: async (args, ctx) => {
			const raw = args.trim().toLowerCase();
			if (raw === "" || raw === "status") {
				ctx.ui.notify(`Mongo memory secret handling: ${allowSecrets ? "allow" : "block"}`, "info");
				return;
			}

			let changed = false;
			if (raw === "allow" || raw === "on" || raw === "true") {
				allowSecrets = true;
				changed = true;
				ctx.ui.notify("Mongo memory secret handling set to allow", "warning");
			}
			if (raw === "block" || raw === "off" || raw === "false") {
				allowSecrets = false;
				changed = true;
				ctx.ui.notify("Mongo memory secret handling set to block", "info");
			}
			if (!changed) {
				ctx.ui.notify("Usage: /memory-secrets allow|block|status", "error");
				return;
			}

			pi.appendEntry("mongo-memory-settings", {
				allowSecrets,
				source: "memory-secrets-command",
				updatedAt: new Date().toISOString(),
			});
			updateModeStatus(ctx);
		},
	});

	pi.registerCommand("memory-debug", {
		description: "Usage: /memory-debug [limit]. Show recent memory packet and write-back diagnostics",
		getArgumentCompletions: (prefix) =>
			filterCommandCompletions(prefix, [
				{ value: "3", description: "Show 3 recent debug entries" },
				{ value: "6", description: "Show 6 recent debug entries (default)" },
				{ value: "12", description: "Show maximum debug entries" },
			]),
		handler: async (args, ctx) => {
			const requestedLimit = Number.parseInt(args.trim(), 10);
			const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 12) : 6;
			const snapshots = collectRecentCustomEntries(
				ctx,
				new Set([
					"mongo-memory-packet",
					"mongo-memory-writeback",
					"mongo-memory-writeback-suggestion",
					"mongo-memory-flush",
					"mongo-memory-conversation",
					"mongo-memory-prune",
					"mongo-memory-settings",
				]),
				limit,
			);

			if (snapshots.length === 0) {
				ctx.ui.notify("No mongo-memory debug entries in this session yet.", "info");
				return;
			}

			const lines: string[] = [];
			lines.push(`Mongo memory debug report (mode=${mode}, secrets=${allowSecrets ? "allow" : "block"})`);
			lines.push(`Entries shown: ${snapshots.length}`);
			lines.push("");

			for (const snapshot of snapshots) {
				lines.push(`### ${snapshot.customType} @ ${formatTimestamp(snapshot.timestamp)}`);
				if (!isObject(snapshot.data)) {
					lines.push("- data: (none)");
					lines.push("");
					continue;
				}

				if (snapshot.customType === "mongo-memory-packet") {
					const details = isObject(snapshot.data.details) ? snapshot.data.details : undefined;
					const selectedCount =
						details && Array.isArray(details.selectedMemoryIds) ? details.selectedMemoryIds.length : 0;
					const budget = details && typeof details.budgetTokens === "number" ? details.budgetTokens : "?";
					const conflictCount = details && Array.isArray(details.conflicts) ? details.conflicts.length : 0;
					lines.push(`- budgetTokens: ${budget}`);
					lines.push(`- selectedMemoryIds: ${selectedCount}`);
					lines.push(`- conflicts: ${conflictCount}`);
					const fallback = details && details.fallback === true;
					if (fallback) {
						lines.push("- fallback: true");
					}
					if (details && isObject(details.queryTelemetry)) {
						const telemetrySources = ["recall", "continuity"] as const;
						for (const source of telemetrySources) {
							const telemetry = isObject(details.queryTelemetry[source]) ? details.queryTelemetry[source] : undefined;
							if (!telemetry) continue;
							const rawLength = typeof telemetry.rawLength === "number" ? telemetry.rawLength : 0;
							const sanitizedLength = typeof telemetry.sanitizedLength === "number" ? telemetry.sanitizedLength : 0;
							const maxChars = typeof telemetry.maxChars === "number" ? telemetry.maxChars : 0;
							const truncated = telemetry.truncated === true;
							lines.push(
								`- ${source}Query: raw=${rawLength} sanitized=${sanitizedLength} max=${maxChars} truncated=${truncated}`,
							);
						}
					}
					if (details && isObject(details.continuityTrace)) {
						const queryHits = typeof details.continuityTrace.queryHits === "number" ? details.continuityTrace.queryHits : 0;
						const projectHits =
							typeof details.continuityTrace.projectHits === "number" ? details.continuityTrace.projectHits : 0;
						const sessionHits =
							typeof details.continuityTrace.sessionHits === "number" ? details.continuityTrace.sessionHits : 0;
						lines.push(`- continuityHits: query=${queryHits} project=${projectHits} session=${sessionHits}`);
					}
					if (typeof snapshot.data.fallbackReason === "string") {
						lines.push(`- fallbackReason: ${clip(snapshot.data.fallbackReason.replace(/\s+/g, " "), 180)}`);
					}
					lines.push("");
					continue;
				}

				if (snapshot.customType === "mongo-memory-flush") {
					const flushed = typeof snapshot.data.flushed === "number" ? snapshot.data.flushed : 0;
					const requested = typeof snapshot.data.requested === "number" ? snapshot.data.requested : 0;
					const sourceTurn = typeof snapshot.data.sourceTurnIndex === "number" ? snapshot.data.sourceTurnIndex : "n/a";
					lines.push(`- requested: ${requested}`);
					lines.push(`- flushed: ${flushed}`);
					lines.push(`- sourceTurnIndex: ${sourceTurn}`);
					if (typeof snapshot.data.error === "string") {
						lines.push(`- error: ${snapshot.data.error}`);
					}
					const flushedLines = formatWritebackCandidates(snapshot.data.flushedCandidates);
					if (flushedLines.length > 0) {
						lines.push("- flushed candidates:");
						lines.push(...flushedLines);
					}
					lines.push("");
					continue;
				}

				if (snapshot.customType === "mongo-memory-conversation") {
					const stored = snapshot.data.stored === true;
					const turnIndex = typeof snapshot.data.turnIndex === "number" ? snapshot.data.turnIndex : "n/a";
					const sessionId = typeof snapshot.data.sessionId === "string" ? snapshot.data.sessionId : "n/a";
					lines.push(`- turnIndex: ${turnIndex}`);
					lines.push(`- sessionId: ${sessionId}`);
					lines.push(`- stored: ${stored}`);
					if (typeof snapshot.data.exchangeId === "string") {
						lines.push(`- exchangeId: ${snapshot.data.exchangeId}`);
					}
					if (typeof snapshot.data.reason === "string") {
						lines.push(`- reason: ${snapshot.data.reason}`);
					}
					if (typeof snapshot.data.error === "string") {
						lines.push(`- error: ${snapshot.data.error}`);
					}
					lines.push("");
					continue;
				}

				if (snapshot.customType === "mongo-memory-prune") {
					const found = typeof snapshot.data.found === "number" ? snapshot.data.found : 0;
					const shown = typeof snapshot.data.shown === "number" ? snapshot.data.shown : 0;
					const dryRun = snapshot.data.dryRun === true;
					const updated = typeof snapshot.data.updated === "number" ? snapshot.data.updated : 0;
					const failed = typeof snapshot.data.failed === "number" ? snapshot.data.failed : 0;
					lines.push(`- found: ${found}`);
					lines.push(`- shown: ${shown}`);
					lines.push(`- dryRun: ${dryRun}`);
					lines.push(`- updated: ${updated}`);
					lines.push(`- failed: ${failed}`);
					if (Array.isArray(snapshot.data.items)) {
						for (const item of snapshot.data.items.slice(0, 8)) {
							if (!isObject(item) || typeof item.memoryId !== "string") {
								continue;
							}
							const reasons = Array.isArray(item.reasons)
								? item.reasons.filter((reason): reason is string => typeof reason === "string").join(", ")
								: "";
							lines.push(`  - ${item.memoryId}${reasons.length > 0 ? ` (${reasons})` : ""}`);
						}
					}
					lines.push("");
					continue;
				}

				if (snapshot.customType === "mongo-memory-settings") {
					const persistedSecrets = typeof snapshot.data.allowSecrets === "boolean" ? snapshot.data.allowSecrets : undefined;
					const source = typeof snapshot.data.source === "string" ? snapshot.data.source : "unknown";
					lines.push(`- allowSecrets: ${persistedSecrets === undefined ? "n/a" : persistedSecrets ? "allow" : "block"}`);
					lines.push(`- source: ${source}`);
					if (typeof snapshot.data.updatedAt === "string") {
						lines.push(`- updatedAt: ${snapshot.data.updatedAt}`);
					}
					lines.push("");
					continue;
				}

				const extracted = typeof snapshot.data.extracted === "number" ? snapshot.data.extracted : 0;
				const confident = typeof snapshot.data.confident === "number" ? snapshot.data.confident : 0;
				const stored = typeof snapshot.data.stored === "number" ? snapshot.data.stored : 0;
				const dropped = typeof snapshot.data.dedupedDropped === "number" ? snapshot.data.dedupedDropped : 0;
				lines.push(`- extracted: ${extracted}`);
				lines.push(`- confident: ${confident}`);
				lines.push(`- dedupedDropped: ${dropped}`);
				lines.push(`- stored: ${stored}`);
				if (typeof snapshot.data.reason === "string") {
					lines.push(`- reason: ${snapshot.data.reason}`);
				}
				if (typeof snapshot.data.error === "string") {
					lines.push(`- error: ${snapshot.data.error}`);
				}

				const storedLines = formatWritebackCandidates(
					"storedCandidates" in snapshot.data ? snapshot.data.storedCandidates : snapshot.data.candidates,
				);
				if (storedLines.length > 0) {
					lines.push("- candidates:");
					lines.push(...storedLines);
				}
				if (Array.isArray(snapshot.data.dedupedDroppedDetails) && snapshot.data.dedupedDroppedDetails.length > 0) {
					lines.push("- deduped candidates:");
					for (const item of snapshot.data.dedupedDroppedDetails) {
						if (!isObject(item)) {
							continue;
						}
						const reason = typeof item.reason === "string" ? item.reason : "deduped";
						const content = typeof item.content === "string" ? item.content : "(unknown)";
						lines.push(`  - ${reason}: ${content}`);
					}
				}
				lines.push("");
			}

			const output = truncateOutput(lines.join("\n")).text;
			pi.sendMessage(
				{
					customType: "mongo-memory-debug",
					content: output,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.registerCommand("memory-prune-noise", {
		description:
			"Usage: /memory-prune-noise [--apply] [--include-uncertain] [--limit N]. Scan noisy/test memories (dry-run by default).",
		getArgumentCompletions: (prefix) =>
			filterCommandCompletions(prefix, [
				{ value: "--apply", description: "Tag high-confidence noisy entries (non-destructive metadata update)" },
				{ value: "--include-uncertain", description: "Include uncertain matches in apply/report" },
				{ value: "--limit 20", description: "Show up to 20 candidates (default)" },
				{ value: "--limit 50", description: "Show up to 50 candidates" },
			]),
		handler: async (args, ctx) => {
			if (!getMemoryToken().trim()) {
				ctx.ui.notify("Missing MONGO_MEMORY_TOKEN (or MCP_MEMORY_TOKEN)", "error");
				return;
			}

			const apply = /\b--apply\b/i.test(args);
			const includeUncertain = /\b--include-uncertain\b/i.test(args);
			const limitMatch = args.match(/(?:--limit\s+)?(\d+)/i);
			const limit = limitMatch
				? Math.max(1, Math.min(80, Number.parseInt(limitMatch[1], 10)))
				: 20;
			const candidates = await collectNoiseMemoryCandidates(client, limit);
			if (candidates.length === 0) {
				ctx.ui.notify("memory-prune-noise: no likely noisy memories found.", "info");
				return;
			}

			const selected = candidates.slice(0, limit);
			const highConfidence = selected.filter((item) => isHighConfidenceNoise(item));
			const uncertain = selected.filter((item) => !isHighConfidenceNoise(item));
			const actionable = includeUncertain ? selected : highConfidence;

			let updated: string[] = [];
			let failed: Array<{ memoryId: string; error: string }> = [];
			if (apply && actionable.length > 0) {
				const applied = await applyNoiseTags(client, actionable);
				updated = applied.updated;
				failed = applied.failed;
			}

			const lines: string[] = [];
			lines.push("Mongo memory prune-noise report");
			lines.push(`Total likely noisy memories found: ${candidates.length}`);
			lines.push(`Showing: ${selected.length}`);
			lines.push(`High-confidence noisy: ${highConfidence.length}`);
			lines.push(`Uncertain noisy: ${uncertain.length}`);
			if (!apply) {
				lines.push("No memories were modified (dry-run report only).");
				lines.push("Use --apply to tag high-confidence noisy entries (non-destructive). Use --include-uncertain to include all shown entries.");
			} else {
				lines.push(`Applied tags to: ${updated.length}`);
				lines.push(`Failed updates: ${failed.length}`);
				if (!includeUncertain && uncertain.length > 0) {
					lines.push(`Skipped uncertain entries: ${uncertain.length} (use --include-uncertain to include them).`);
				}
			}
			lines.push("");

			for (const item of selected) {
				const level = isHighConfidenceNoise(item) ? "high" : "uncertain";
				lines.push(`- [${item.memoryId}] domain:${item.domain} type:${item.memoryType} confidence:${level}`);
				lines.push(`  reasons: ${item.reasons.join(", ")}`);
				lines.push(`  about: ${summarizeMemoryTopic(item.content, 20)}`);
				lines.push(`  inspect: memory_get(memoryId=\"${item.memoryId}\")`);
			}

			if (failed.length > 0) {
				lines.push("");
				lines.push("Update failures:");
				for (const item of failed.slice(0, 10)) {
					lines.push(`- ${item.memoryId}: ${item.error}`);
				}
			}

			pi.appendEntry("mongo-memory-prune", {
				mode,
				secrets: allowSecrets ? "allow" : "block",
				found: candidates.length,
				shown: selected.length,
				highConfidence: highConfidence.length,
				uncertain: uncertain.length,
				dryRun: !apply,
				apply,
				includeUncertain,
				updated: updated.length,
				failed: failed.length,
				items: selected.map((item) => ({
					memoryId: item.memoryId,
					reasons: item.reasons,
					confidence: isHighConfidenceNoise(item) ? "high" : "uncertain",
				})),
				generatedAt: new Date().toISOString(),
			});

			pi.sendMessage(
				{
					customType: "mongo-memory-prune",
					content: truncateOutput(lines.join("\n")).text,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.registerCommand("memory-flush", {
		description: "Usage: /memory-flush [count]. Persist latest assist-mode memory suggestions now",
		getArgumentCompletions: (prefix) =>
			filterCommandCompletions(prefix, [
				{ value: "1", description: "Flush one suggestion" },
				{ value: "3", description: "Flush three suggestions" },
				{ value: "5", description: "Flush five suggestions" },
			]),
		handler: async (args, ctx) => {
			if (!getMemoryToken().trim()) {
				ctx.ui.notify("Missing MONGO_MEMORY_TOKEN (or MCP_MEMORY_TOKEN)", "error");
				return;
			}

			const suggestion = readLatestWritebackSuggestion(ctx);
			if (!suggestion) {
				ctx.ui.notify("No memory write-back suggestion found to flush.", "info");
				return;
			}

			const requestedArg = Number.parseInt(args.trim(), 10);
			const requested =
				Number.isFinite(requestedArg) && requestedArg > 0
					? Math.min(requestedArg, suggestion.candidates.length)
					: suggestion.candidates.length;
			const config = getWritebackModeConfig(mode);
			const toFlush = suggestion.candidates.slice(0, requested);
			const dedupe = await dropDuplicateWriteCandidates(client, toFlush, config.duplicateSimilarityThreshold);
			const selected = dedupe.kept;
			const nowIso = new Date().toISOString();

			if (selected.length === 0) {
				pi.appendEntry("mongo-memory-flush", {
					sourceEntryId: suggestion.entryId,
					sourceTurnIndex: suggestion.turnIndex,
					requested,
					flushed: 0,
					dedupedDropped: dedupe.dropped.length,
					dedupedDroppedDetails: summarizeDroppedCandidates(dedupe.dropped),
					reason: "all flush candidates deduplicated",
					generatedAt: nowIso,
				});
				ctx.ui.notify("memory-flush: nothing new to persist after dedupe.", "info");
				return;
			}

			const memories: Array<Record<string, unknown>> = selected.map((candidate) => ({
				content: candidate.content,
				domain: candidate.domain,
				memoryType: candidate.memoryType,
				metadata: {
					source: "pi-memory-autopilot-manual-flush",
					mode,
					kind: candidate.kind,
					reason: candidate.reason,
					confidence: candidate.confidence,
					extractedFrom: candidate.source,
					projectPath: ctx.cwd,
					sourceSuggestionEntryId: suggestion.entryId,
					sourceTurnIndex: suggestion.turnIndex,
					timestamp: nowIso,
				},
			}));

			const storeResult = await safeCallTool(client, "bulkCreateMemories", {
				memories,
				stopOnError: false,
			});

			if (!storeResult.ok) {
				pi.appendEntry("mongo-memory-flush", {
					sourceEntryId: suggestion.entryId,
					sourceTurnIndex: suggestion.turnIndex,
					requested,
					flushed: 0,
					dedupedDropped: dedupe.dropped.length,
					dedupedDroppedDetails: summarizeDroppedCandidates(dedupe.dropped),
					error: storeResult.error,
					generatedAt: nowIso,
				});
				ctx.ui.notify(`memory-flush failed: ${storeResult.error}`, "error");
				return;
			}

			pi.appendEntry("mongo-memory-flush", {
				sourceEntryId: suggestion.entryId,
				sourceTurnIndex: suggestion.turnIndex,
				requested,
				flushed: selected.length,
				dedupedDropped: dedupe.dropped.length,
				dedupedDroppedDetails: summarizeDroppedCandidates(dedupe.dropped),
				flushedCandidates: selected,
				generatedAt: nowIso,
			});
			ctx.ui.notify(`memory-flush persisted ${selected.length} candidate(s).`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const persistedSettings = readLatestPersistedAutopilotSettings(ctx);
		if (persistedSettings?.mode) {
			mode = normalizeMode(persistedSettings.mode);
		}
		if (typeof persistedSettings?.allowSecrets === "boolean") {
			allowSecrets = persistedSettings.allowSecrets;
		}

		const flagValue = pi.getFlag("memory-mode");
		if (typeof flagValue === "string") {
			mode = normalizeMode(flagValue);
		}
		if (hasCliFlag("memory-allow-secrets")) {
			const secretFlagValue = pi.getFlag("memory-allow-secrets");
			if (typeof secretFlagValue === "boolean") {
				allowSecrets = secretFlagValue;
			}
		}
		updateModeStatus(ctx);
	});

	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description: "Recall task-relevant memory pointers with ranking and retrieval trace metadata.",
		parameters: MemoryRecallParams,
		async execute(_toolCallId, params: MemoryRecallParams, signal, onUpdate) {
			if (!getMemoryToken().trim()) {
				return missingTokenResult();
			}

			onUpdate?.({ content: [{ type: "text", text: "Recalling memory candidates..." }] });

			const scope = params.scope ?? {};
			const limit = params.limit ?? 8;
			try {
				const recall = await runRecall(client, params.query, scope, limit, signal);
				const selected = recall.ranked.slice(0, limit);

				const lines: string[] = [];
				lines.push(`Memory recall results for query: ${params.query}`);
				lines.push("Pointer-first output. Hydrate full details only when necessary via memory_get(memoryId=\"...\").");
				if (selected.length === 0) {
					lines.push("No ranked memory hits found.");
				} else {
					lines.push(`Top memory pointers (${selected.length}):`);
					for (const item of selected) {
						lines.push(buildMemoryLine(item));
					}
				}

				if (recall.conversations.length > 0) {
					lines.push("");
					lines.push(`Conversation hits (${Math.min(limit, recall.conversations.length)}):`);
					for (const convo of recall.conversations.slice(0, limit)) {
						lines.push(buildConversationLine(convo));
					}
				}

				const output = truncateOutput(lines.join("\n"));
				return {
					content: [{ type: "text", text: output.text }],
					details: {
						query: params.query,
						count: selected.length,
						queryTelemetry: recall.queryTelemetry,
						retrievalTrace: selected.map((item) => ({
							memoryId: item.memoryId,
							score: item.scores.final,
							why: item.whySelected,
						})),
						truncated: output.truncated,
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerTool({
		name: "memory_store",
		label: "Memory Store",
		description: "Store durable facts, decisions, and procedures with classification metadata.",
		parameters: MemoryStoreParams,
		async execute(_toolCallId, params: MemoryStoreParams, signal, onUpdate) {
			if (!getMemoryToken().trim()) {
				return missingTokenResult();
			}

			const facts = (params.facts ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
			const decisions = (params.decisions ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
			const procedures = (params.procedures ?? []).map((item) => item.trim()).filter((item) => item.length > 0);

			if (facts.length + decisions.length + procedures.length === 0) {
				return {
					content: [{ type: "text", text: "No memory items provided. Pass facts, decisions, and/or procedures." }],
					isError: true,
					details: {},
				};
			}

			const domain = params.domain ?? "technical";
			const metadataBase: Record<string, unknown> = {
				source: "pi-memory-autopilot",
				projectPath: params.projectPath,
				sessionId: params.sessionId,
			};

			const memories: Array<Record<string, unknown>> = [];
			for (const fact of facts) {
				memories.push({
					content: fact,
					domain,
					memoryType: "long-term",
					metadata: { ...metadataBase, kind: "fact" },
				});
			}
			for (const decision of decisions) {
				memories.push({
					content: decision,
					domain,
					memoryType: "long-term",
					metadata: { ...metadataBase, kind: "decision", importance: "high" },
				});
			}
			for (const procedure of procedures) {
				memories.push({
					content: procedure,
					domain,
					memoryType: "procedural",
					metadata: { ...metadataBase, kind: "procedure" },
				});
			}

			onUpdate?.({ content: [{ type: "text", text: `Storing ${memories.length} memory items...` }] });
			const result = await safeCallTool(
				client,
				"bulkCreateMemories",
				{
					memories,
					stopOnError: false,
				},
				signal,
			);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.error }],
					isError: true,
					details: {},
				};
			}

			const output = truncateOutput(result.text || "Memory store request completed.");
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					stored: memories.length,
					facts: facts.length,
					decisions: decisions.length,
					procedures: procedures.length,
					truncated: output.truncated,
				},
			};
		},
	});

	pi.registerTool({
		name: "memory_recent",
		label: "Memory Recent",
		description: "Get recent conversation continuity context, optionally scoped by project path.",
		parameters: MemoryRecentParams,
		async execute(_toolCallId, params: MemoryRecentParams, signal) {
			if (!getMemoryToken().trim()) {
				return missingTokenResult();
			}

			const limit = params.limit ?? 20;
			try {
				const recent = await getRecentConversations(client, params.projectPath, limit, signal);
				const lines: string[] = [];
				lines.push(`Recent memory continuity (${params.projectPath ? "project" : "global"} scope):`);
				if (recent.items.length === 0) {
					lines.push("No recent conversations found.");
				} else {
					for (const item of recent.items.slice(0, limit)) {
						lines.push(buildConversationLine(item));
					}
				}
				const output = truncateOutput(lines.join("\n"));
				return {
					content: [{ type: "text", text: output.text }],
					details: {
						count: recent.items.length,
						projectPath: params.projectPath,
						truncated: output.truncated,
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerTool({
		name: "memory_get",
		label: "Memory Get",
		description: "Hydrate a memory pointer by ID and optionally fetch related pointers.",
		parameters: MemoryGetParams,
		async execute(_toolCallId, params: MemoryGetParams, signal, onUpdate) {
			if (!getMemoryToken().trim()) {
				return missingTokenResult();
			}

			onUpdate?.({ content: [{ type: "text", text: `Hydrating memory ${params.memoryId}...` }] });

			const hydrated = await safeCallTool(
				client,
				"retrieveMemory",
				{ memoryId: params.memoryId },
				signal,
			);
			if (!hydrated.ok) {
				return {
					content: [{ type: "text", text: hydrated.error }],
					isError: true,
					details: {},
				};
			}

			const lines: string[] = [];
			lines.push(`Hydrated memory: ${params.memoryId}`);
			lines.push("");
			lines.push(hydrated.text || "No memory content returned.");

			let relatedText: string | undefined;
			if (params.includeRelated === true) {
				const related = await safeCallTool(
					client,
					"traverseGraph",
					{
						memoryId: params.memoryId,
						maxDepth: 1,
						minStrength: 0.3,
						includeMetadata: false,
					},
					signal,
				);
				if (related.ok) {
					relatedText = related.text;
					lines.push("");
					lines.push(`Related pointers (depth=1, requested limit=${params.relatedLimit ?? 5}):`);
					lines.push(related.text || "No related graph output returned.");
				}
			}

			const output = truncateOutput(lines.join("\n"));
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					memoryId: params.memoryId,
					hydrated: true,
					includeRelated: params.includeRelated === true,
					relatedIncluded: relatedText !== undefined,
					truncated: output.truncated,
				},
			};
		},
	});

	pi.registerTool({
		name: "memory_update",
		label: "Memory Update",
		description: "Patch an existing memory entry by ID.",
		parameters: MemoryUpdateParams,
		async execute(_toolCallId, params: MemoryUpdateParams, signal) {
			if (!getMemoryToken().trim()) {
				return missingTokenResult();
			}

			const callArgs: Record<string, unknown> = {
				memoryId: params.memoryId,
				...params.patch,
			};
			const result = await safeCallTool(client, "updateMemory", callArgs, signal);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.error }],
					isError: true,
					details: {},
				};
			}

			const output = truncateOutput(result.text || "Memory update request completed.");
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					memoryId: params.memoryId,
					truncated: output.truncated,
				},
			};
		},
	});

	pi.registerTool({
		name: "memory_stats",
		label: "Memory Stats",
		description: "Get memory usage and distribution statistics.",
		parameters: MemoryStatsParams,
		async execute(_toolCallId, params: MemoryStatsParams, signal) {
			if (!getMemoryToken().trim()) {
				return missingTokenResult();
			}

			const result = await safeCallTool(
				client,
				"getMemoryStats",
				params.userId ? { userId: params.userId } : {},
				signal,
			);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.error }],
					isError: true,
					details: {},
				};
			}

			const output = truncateOutput(result.text || "No memory stats returned.");
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					userId: params.userId,
					truncated: output.truncated,
				},
			};
		},
	});

	pi.on("turn_end", async (event, ctx) => {
		if (mode === "off" || !getMemoryToken().trim()) {
			return;
		}

		const assistantText = readTextContent(event.message.content);
		const userText = readLatestUserMessageText(ctx);
		if (!assistantText.trim() && !userText.trim()) {
			return;
		}

		const nowIso = new Date().toISOString();
		const sessionId = ctx.sessionManager.getSessionId();
		const userFingerprint = normalizeForCompare(userText).slice(0, 220);
		if (!sessionId || sessionId.trim().length === 0) {
			pi.appendEntry("mongo-memory-conversation", {
				turnIndex: event.turnIndex,
				sessionId: "",
				stored: false,
				reason: "missing sessionId",
				generatedAt: nowIso,
			});
		} else if (hasStoredConversationForTurn(ctx, sessionId, event.turnIndex)) {
			pi.appendEntry("mongo-memory-conversation", {
				turnIndex: event.turnIndex,
				sessionId,
				stored: false,
				reason: "already stored for turn",
				generatedAt: nowIso,
			});
		} else if (userFingerprint.length > 0 && hasRecentConversationUserFingerprint(ctx, sessionId, userFingerprint)) {
			pi.appendEntry("mongo-memory-conversation", {
				turnIndex: event.turnIndex,
				sessionId,
				stored: false,
				reason: "duplicate user prompt fingerprint",
				generatedAt: nowIso,
			});
		} else if (!allowSecrets && (containsSecretLikeContent(userText) || containsSecretLikeContent(assistantText))) {
			pi.appendEntry("mongo-memory-conversation", {
				turnIndex: event.turnIndex,
				sessionId,
				stored: false,
				reason: "secret-like content detected",
				generatedAt: nowIso,
			});
		} else if (isLowValueMetaContent(userText) && isLowValueMetaContent(assistantText)) {
			pi.appendEntry("mongo-memory-conversation", {
				turnIndex: event.turnIndex,
				sessionId,
				stored: false,
				reason: "low-value meta turn",
				generatedAt: nowIso,
			});
		} else {
			const raw = composeRawConversation(userText, assistantText, event.toolResults);
			const curated = composeCuratedConversation(userText, assistantText);
			const conversationStoreResult = await safeCallTool(
				client,
				"storeConversationExchange",
				{
					sessionId,
					projectPath: ctx.cwd,
					turnNumber: event.turnIndex,
					timestamp: nowIso,
					raw,
					curated,
					domain: inferDomain(`${userText}\n${assistantText}`),
					tags: ["pi-memory-autopilot", "conversation-continuity", "phase3"],
				},
			);

			if (conversationStoreResult.ok) {
				pi.appendEntry("mongo-memory-conversation", {
					turnIndex: event.turnIndex,
					sessionId,
					stored: true,
					exchangeId: extractConversationExchangeId(conversationStoreResult.text),
					summary: curated.summary,
					userFingerprint,
					generatedAt: nowIso,
				});
			} else {
				pi.appendEntry("mongo-memory-conversation", {
					turnIndex: event.turnIndex,
					sessionId,
					stored: false,
					error: conversationStoreResult.error,
					generatedAt: nowIso,
				});
			}
		}

		const writebackConfig = getWritebackModeConfig(mode);
		if (writebackConfig.maxCandidatesPerTurn <= 0 || !assistantText.trim()) {
			return;
		}

		const extracted = extractWriteCandidates(userText, assistantText, allowSecrets);
		const confident = extracted.filter((candidate) => candidate.confidence >= writebackConfig.minConfidence);
		if (confident.length === 0) {
			return;
		}

		const recentFingerprints = collectRecentCandidateFingerprints(ctx, 40);
		const localDedupeDropped: Array<{ candidate: ExtractedWriteCandidate; reason: string }> = [];
		const locallyUnique: ExtractedWriteCandidate[] = [];
		for (const candidate of confident) {
			const fingerprint = normalizeForCompare(canonicalizeMemoryStatement(candidate.content));
			if (recentFingerprints.has(fingerprint)) {
				localDedupeDropped.push({ candidate, reason: "local-session duplicate" });
				continue;
			}
			locallyUnique.push(candidate);
		}

		const dedupeInput = locallyUnique.slice(0, Math.max(6, writebackConfig.maxCandidatesPerTurn * 2));
		const dedupe = await dropDuplicateWriteCandidates(
			client,
			dedupeInput,
			writebackConfig.duplicateSimilarityThreshold,
		);
		const droppedCandidates = [...localDedupeDropped, ...dedupe.dropped];
		const selected = dedupe.kept.slice(0, writebackConfig.maxCandidatesPerTurn);

		if (selected.length === 0) {
			pi.appendEntry("mongo-memory-writeback", {
				turnIndex: event.turnIndex,
				mode,
				extracted: extracted.length,
				confident: confident.length,
				dedupedDropped: droppedCandidates.length,
				dedupedDroppedDetails: summarizeDroppedCandidates(droppedCandidates),
				stored: 0,
				reason: "all candidates deduplicated",
				generatedAt: nowIso,
			});
			return;
		}

		if (!writebackConfig.autoPersist) {
			pi.appendEntry("mongo-memory-writeback-suggestion", {
				turnIndex: event.turnIndex,
				mode,
				extracted: extracted.length,
				confident: confident.length,
				dedupedDropped: droppedCandidates.length,
				candidates: selected,
				dedupedDroppedDetails: summarizeDroppedCandidates(droppedCandidates),
				generatedAt: nowIso,
			});
			if (ctx.hasUI) {
				ctx.ui.notify(`Memory assist: ${selected.length} candidate(s) extracted (not auto-stored in assist mode).`, "info");
			}
			return;
		}

		const memories: Array<Record<string, unknown>> = selected.map((candidate) => ({
			content: candidate.content,
			domain: candidate.domain,
			memoryType: candidate.memoryType,
			metadata: {
				source: "pi-memory-autopilot-writeback",
				mode,
				kind: candidate.kind,
				reason: candidate.reason,
				confidence: candidate.confidence,
				extractedFrom: candidate.source,
				projectPath: ctx.cwd,
				turnIndex: event.turnIndex,
				timestamp: nowIso,
			},
		}));

		const storeResult = await safeCallTool(
			client,
			"bulkCreateMemories",
			{
				memories,
				stopOnError: false,
			},
		);

		if (!storeResult.ok) {
			pi.appendEntry("mongo-memory-writeback", {
				turnIndex: event.turnIndex,
				mode,
				extracted: extracted.length,
				confident: confident.length,
				dedupedDropped: droppedCandidates.length,
				dedupedDroppedDetails: summarizeDroppedCandidates(droppedCandidates),
				stored: 0,
				error: storeResult.error,
				generatedAt: nowIso,
			});
			if (ctx.hasUI) {
				ctx.ui.notify(`Memory write-back failed: ${storeResult.error}`, "warning");
			}
			return;
		}

		pi.appendEntry("mongo-memory-writeback", {
			turnIndex: event.turnIndex,
			mode,
			extracted: extracted.length,
			confident: confident.length,
			dedupedDropped: droppedCandidates.length,
			dedupedDroppedDetails: summarizeDroppedCandidates(droppedCandidates),
			stored: selected.length,
			storedCandidates: selected,
			generatedAt: nowIso,
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (mode === "off") {
			return;
		}
		if (!getMemoryToken().trim()) {
			return;
		}

		try {
			const recall = await runRecall(
				client,
				event.prompt,
				{
					projectPath: ctx.cwd,
					includeConversations: false,
					includeRecommendations: true,
				},
				12,
			);
			const continuity = await getContinuityConversations(
				client,
				ctx.cwd,
				ctx.sessionManager.getSessionId(),
				event.prompt,
				24,
			);
			const recent = await getRecentConversations(client, ctx.cwd, 20);
			const conversationPool = mergeConversationCandidates([continuity.items, recent.items, recall.conversations], 24);
			const packet = composeContextPacket(event.prompt, ctx.cwd, mode, ctx.model?.contextWindow, recall, conversationPool);
			if (!packet) {
				return;
			}

			const packetDetails = {
				...packet.details,
				continuityTrace: continuity.trace,
				queryTelemetry: {
					recall: recall.queryTelemetry,
					continuity: continuity.trace.queryTelemetry,
				},
			};

			pi.appendEntry("mongo-memory-packet", {
				generatedAt: new Date().toISOString(),
				details: packetDetails,
			});

			return {
				message: {
					customType: "mongo-memory-context-packet",
					content: packet.text,
					details: packetDetails,
					display: false,
				},
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const fallbackQuery = sanitizeSearchQuery(event.prompt);
			const fallbackPacket = composeFallbackContextPacket(
				event.prompt,
				ctx.cwd,
				mode,
				ctx.model?.contextWindow,
				errorMessage,
				fallbackQuery.telemetry,
			);
			const fallbackDetails = {
				...fallbackPacket.details,
				fallback: true,
				fallbackReason: errorMessage,
				queryTelemetry: {
					recall: fallbackQuery.telemetry,
				},
			};

			pi.appendEntry("mongo-memory-packet", {
				generatedAt: new Date().toISOString(),
				details: fallbackDetails,
				fallbackReason: errorMessage,
			});

			if (ctx.hasUI) {
				ctx.ui.notify(`Mongo memory recall unavailable; using fallback context packet: ${errorMessage}`, "warning");
			}
			return {
				message: {
					customType: "mongo-memory-context-packet",
					content: fallbackPacket.text,
					details: fallbackDetails,
					display: false,
				},
			};
		}
	});
}
