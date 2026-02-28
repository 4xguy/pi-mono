/**
 * Mongo Memory MCP (HTTP) Bridge
 *
 * Connects pi to an HTTP-based MCP server using bearer token auth.
 *
 * Env vars (preferred):
 * - MONGO_MEMORY_URL (default: https://mem.icvida.com/mcp)
 * - MONGO_MEMORY_TOKEN (required)
 * - MONGO_MEMORY_PROTOCOL_VERSION (default: 2025-03-26)
 *
 * Backward-compatible aliases:
 * - MCP_MEMORY_URL
 * - MCP_MEMORY_TOKEN
 * - MCP_MEMORY_PROTOCOL_VERSION
 *
 * Tools:
 * - mongo_memory_list_tools
 * - mongo_memory_call
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const DEFAULT_URL = "https://mem.icvida.com/mcp";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const MAX_TOOLS_LIST = 200;

function getMemoryUrl(): string {
	return process.env.MONGO_MEMORY_URL || process.env.MCP_MEMORY_URL || DEFAULT_URL;
}

function getMemoryToken(): string {
	return process.env.MONGO_MEMORY_TOKEN || process.env.MCP_MEMORY_TOKEN || "";
}

function getMemoryProtocolVersion(): string {
	return process.env.MONGO_MEMORY_PROTOCOL_VERSION || process.env.MCP_MEMORY_PROTOCOL_VERSION || DEFAULT_PROTOCOL_VERSION;
}

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

interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

interface ToolsListResult {
	tools?: McpToolInfo[];
	nextCursor?: string;
}

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
	serverInfo?: {
		name?: string;
		version?: string;
	};
	capabilities?: unknown;
}

interface RpcEnvelope {
	headers: Headers;
	response: JsonRpcResponse;
}

interface MemoryToolDetails {
	url: string;
	sessionId?: string;
	requestId: number;
}

const ListToolsParams = Type.Object({
	refresh: Type.Optional(Type.Boolean({ description: "Ignore cache and fetch tools from server." })),
});

type ListToolsParams = Static<typeof ListToolsParams>;

const CallToolParams = Type.Object({
	toolName: Type.String({ description: "MCP tool name from tools/list." }),
	arguments: Type.Optional(
		Type.Object({}, { additionalProperties: true, description: "Tool arguments object." }),
	),
	output: Type.Optional(
		StringEnum([
			"summary",
			"raw",
		] as const, {
			description: "summary = concise text output, raw = include raw JSON payload.",
		}),
	),
});

type CallToolParams = Static<typeof CallToolParams>;

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

	const ssePayloads = extractSseDataPayloads(text);
	for (let index = ssePayloads.length - 1; index >= 0; index -= 1) {
		const payload = ssePayloads[index];
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

function renderJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function toToolsListResult(value: unknown): ToolsListResult {
	if (!isObject(value)) {
		return {};
	}
	const toolsRaw = Array.isArray(value.tools) ? value.tools : [];
	const tools: McpToolInfo[] = [];
	for (const item of toolsRaw) {
		if (!isObject(item)) {
			continue;
		}
		const name = item.name;
		if (typeof name !== "string" || name.trim().length === 0) {
			continue;
		}
		tools.push({
			name,
			description: typeof item.description === "string" ? item.description : undefined,
			inputSchema: item.inputSchema,
		});
	}
	return {
		tools,
		nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : undefined,
	};
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

class McpHttpClient {
	private readonly url: string;
	private readonly token: string;
	private readonly protocolVersion: string;
	private sessionId: string | undefined;
	private initialized = false;
	private requestCounter = 1;
	private toolsCache: McpToolInfo[] | undefined;

	public constructor(url: string, token: string, protocolVersion: string) {
		this.url = url;
		this.token = token;
		this.protocolVersion = protocolVersion;
	}

	public getSessionId(): string | undefined {
		return this.sessionId;
	}

	public nextRequestId(): number {
		const id = this.requestCounter;
		this.requestCounter += 1;
		return id;
	}

	private async post(method: string, params: unknown, id?: number, signal?: AbortSignal): Promise<RpcEnvelope | undefined> {
		const body = id === undefined
			? { jsonrpc: "2.0", method, params }
			: { jsonrpc: "2.0", id, method, params };

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

		if (response.status === 202) {
			return undefined;
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
		return {
			headers: response.headers,
			response: rpc,
		};
	}

	public async ensureInitialized(signal?: AbortSignal): Promise<InitializeResult> {
		if (this.initialized) {
			return {};
		}

		const requestId = this.nextRequestId();
		const init = await this.post(
			"initialize",
			{
				protocolVersion: this.protocolVersion,
				capabilities: {},
				clientInfo: {
					name: "pi-mongo-memory-http-extension",
					version: "0.1.0",
				},
			},
			requestId,
			signal,
		);

		const initResult = init?.response && "result" in init.response ? (init.response.result as InitializeResult) : {};
		await this.post("notifications/initialized", {}, undefined, signal);
		this.initialized = true;
		return initResult;
	}

	public async listTools(refresh: boolean, signal?: AbortSignal): Promise<McpToolInfo[]> {
		if (!refresh && this.toolsCache) {
			return this.toolsCache;
		}

		await this.ensureInitialized(signal);
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;

		for (;;) {
			const requestId = this.nextRequestId();
			const envelope = await this.post("tools/list", cursor ? { cursor } : {}, requestId, signal);
			const result = toToolsListResult(
				envelope?.response && "result" in envelope.response ? envelope.response.result : undefined,
			);
			for (const tool of result.tools ?? []) {
				tools.push(tool);
				if (tools.length >= MAX_TOOLS_LIST) {
					this.toolsCache = tools;
					return tools;
				}
			}
			if (!result.nextCursor) {
				break;
			}
			cursor = result.nextCursor;
		}

		this.toolsCache = tools;
		return tools;
	}

	public async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ result: ToolCallResult; requestId: number }> {
		await this.ensureInitialized(signal);
		const requestId = this.nextRequestId();
		const envelope = await this.post(
			"tools/call",
			{
				name,
				arguments: args,
			},
			requestId,
			signal,
		);
		const result = toToolCallResult(
			envelope?.response && "result" in envelope.response ? envelope.response.result : undefined,
		);
		return { result, requestId };
	}
}

export default function mcpMemoryHttpExtension(pi: ExtensionAPI) {
	const client = new McpHttpClient(
		getMemoryUrl(),
		getMemoryToken(),
		getMemoryProtocolVersion(),
	);

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

	function details(requestId: number): MemoryToolDetails {
		return {
			url: getMemoryUrl(),
			sessionId: client.getSessionId(),
			requestId,
		};
	}

	pi.registerTool({
		name: "mongo_memory_list_tools",
		label: "Mongo Memory List Tools",
		description:
			"List tools exposed by the Mongo Memory MCP server over HTTP. Requires MONGO_MEMORY_TOKEN (or MCP_MEMORY_TOKEN). Optional MONGO_MEMORY_URL (default: https://mem.icvida.com/mcp).",
		parameters: ListToolsParams,
		async execute(_toolCallId, params: ListToolsParams, signal, onUpdate) {
			if (!getMemoryToken().trim()) {
				return missingTokenResult();
			}

			onUpdate?.({ content: [{ type: "text", text: "Connecting to MCP server and listing tools..." }] });

			try {
				const tools = await client.listTools(params.refresh ?? false, signal);
				const lines: string[] = [];
				if (tools.length === 0) {
					lines.push("No tools returned by MCP server.");
				} else {
					lines.push(`MCP tools (${tools.length}):`);
					for (const tool of tools) {
						lines.push(`- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`);
					}
				}

				const rawOutput = lines.join("\n");
				const truncation = truncateHead(rawOutput, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				let output = truncation.content;
				if (truncation.truncated) {
					output += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
				}

				return {
					content: [{ type: "text", text: output }],
					details: {
						...details(0),
						toolCount: tools.length,
						truncated: truncation.truncated,
					},
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: error instanceof Error ? error.message : String(error),
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerTool({
		name: "mongo_memory_call",
		label: "Mongo Memory Call",
		description:
			"Call a specific tool on the Mongo Memory MCP server over HTTP. First call mongo_memory_list_tools to discover tool names. Requires MONGO_MEMORY_TOKEN (or MCP_MEMORY_TOKEN).",
		parameters: CallToolParams,
		async execute(_toolCallId, params: CallToolParams, signal, onUpdate) {
			if (!getMemoryToken().trim()) {
				return missingTokenResult();
			}

			onUpdate?.({ content: [{ type: "text", text: `Calling MCP tool: ${params.toolName}` }] });

			const args = isObject(params.arguments)
				? params.arguments
				: ({} as Record<string, unknown>);

			try {
				const { result, requestId } = await client.callTool(params.toolName, args, signal);
				const contentText = flattenToolContent(result);
				let output = contentText.length > 0 ? contentText : "Tool call completed with no text content.";

				if ((params.output ?? "summary") === "raw") {
					output += `\n\nRaw result:\n${renderJson(result)}`;
				} else if (result.structuredContent !== undefined) {
					output += `\n\nStructured content:\n${renderJson(result.structuredContent)}`;
				}

				const truncation = truncateHead(output, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				let finalText = truncation.content;
				if (truncation.truncated) {
					finalText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
				}

				return {
					content: [{ type: "text", text: finalText }],
					isError: result.isError ?? false,
					details: {
						...details(requestId),
						toolName: params.toolName,
						truncated: truncation.truncated,
					},
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: error instanceof Error ? error.message : String(error),
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	});

	const commandCompletions = (prefix: string): Array<{ value: string; label: string; description?: string }> | null => {
		const options = [
			{ value: "refresh", description: "Ignore cache and fetch tools from server" },
		] as const;
		const normalized = prefix.trim().toLowerCase();
		const mapped = options.map((option) => ({
			value: option.value,
			label: option.value,
			description: option.description,
		}));
		if (normalized.length === 0) return mapped;
		const filtered = mapped.filter((item) => item.value.startsWith(normalized));
		return filtered.length > 0 ? filtered : null;
	};

	pi.registerCommand("mongo-memory-tools", {
		description: "Usage: /mongo-memory-tools [refresh]. List Mongo Memory MCP server tools in a notification",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => {
			if (!getMemoryToken().trim()) {
				ctx.ui.notify("Missing MONGO_MEMORY_TOKEN (or MCP_MEMORY_TOKEN)", "error");
				return;
			}

			const normalizedArgs = args.trim().toLowerCase();
			if (normalizedArgs.length > 0 && normalizedArgs !== "refresh") {
				ctx.ui.notify("Usage: /mongo-memory-tools [refresh]", "error");
				return;
			}

			try {
				const refresh = normalizedArgs === "refresh";
				const tools = await client.listTools(refresh);
				const text = tools.length === 0 ? "No MCP tools found" : tools.map((tool) => tool.name).join(", ");
				ctx.ui.notify(text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
