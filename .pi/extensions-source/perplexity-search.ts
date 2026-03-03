/**
 * Perplexity Search Tool
 *
 * Adds a `perplexity_search` tool that queries Perplexity's API and returns
 * a concise answer plus citations.
 *
 * Required env var:
 *   PERPLEXITY_API_KEY
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

const API_URL = "https://api.perplexity.ai/chat/completions";
const MODELS = ["sonar", "sonar-pro"] as const;
const RECENCY_FILTERS = ["day", "week", "month", "year"] as const;
const DEFAULT_MODEL = "sonar";
const DEFAULT_MAX_CITATIONS = 5;

type SearchModel = (typeof MODELS)[number];
type RecencyFilter = (typeof RECENCY_FILTERS)[number];

const TOOL_PARAMS = Type.Object({
	query: Type.String({ description: "Search query." }),
	model: Type.Optional(StringEnum(MODELS)),
	recency: Type.Optional(StringEnum(RECENCY_FILTERS)),
	maxCitations: Type.Optional(
		Type.Integer({
			description: "Maximum number of citation URLs to include in the output (0-20).",
			minimum: 0,
			maximum: 20,
		}),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

interface PerplexityRequestMessage {
	role: "system" | "user";
	content: string;
}

interface PerplexityRequestBody {
	model: SearchModel;
	messages: PerplexityRequestMessage[];
	search_recency_filter?: RecencyFilter;
}

interface PerplexityChoice {
	message?: {
		content?: string;
	};
}

interface PerplexitySearchResult {
	title?: string;
	url?: string;
	date?: string;
}

interface PerplexityUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}

interface PerplexityResponse {
	choices?: PerplexityChoice[];
	citations?: string[];
	search_results?: PerplexitySearchResult[];
	usage?: PerplexityUsage;
}

interface PerplexityErrorResponse {
	error?: {
		message?: string;
	};
}

interface PerplexityToolDetails {
	query: string;
	model: SearchModel;
	recency?: RecencyFilter;
	citations: string[];
	usage?: PerplexityUsage;
	truncated: boolean;
}

function parseResponse(text: string): PerplexityResponse {
	const data = JSON.parse(text) as PerplexityResponse;
	return data;
}

function parseErrorMessage(text: string, status: number): string {
	const fallback = `Perplexity request failed with status ${status}.`;
	if (!text.trim()) {
		return fallback;
	}

	try {
		const data = JSON.parse(text) as PerplexityErrorResponse;
		const message = data.error?.message;
		if (typeof message === "string" && message.trim().length > 0) {
			return message;
		}
	} catch {
		// Ignore parse failures and fall back to raw response text.
	}

	return `${fallback} ${text.trim()}`;
}

function clampMaxCitations(value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_MAX_CITATIONS;
	}
	return Math.max(0, Math.min(20, Math.floor(value)));
}

function extractAnswer(response: PerplexityResponse): string | undefined {
	const content = response.choices?.[0]?.message?.content;
	if (!content) {
		return undefined;
	}
	const trimmed = content.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function extractCitations(response: PerplexityResponse): string[] {
	const urls = new Set<string>();

	for (const citation of response.citations ?? []) {
		const url = citation.trim();
		if (url.length > 0) {
			urls.add(url);
		}
	}

	for (const result of response.search_results ?? []) {
		const url = result.url?.trim();
		if (url && url.length > 0) {
			urls.add(url);
		}
	}

	return [...urls];
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "perplexity_search",
		label: "Perplexity Search",
		description: `Search the web using Perplexity (models: sonar, sonar-pro). Returns answer text and citations. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Requires PERPLEXITY_API_KEY.`,
		parameters: TOOL_PARAMS,
		async execute(_toolCallId, params: ToolParams, signal, onUpdate) {
			const apiKey = process.env.PERPLEXITY_API_KEY;
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "Missing PERPLEXITY_API_KEY. Set it in your environment and retry.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const model: SearchModel = params.model ?? DEFAULT_MODEL;
			const maxCitations = clampMaxCitations(params.maxCitations);

			onUpdate?.({
				content: [{ type: "text", text: `Searching with Perplexity ${model}...` }],
				details: { query: params.query, model },
			});

			const requestBody: PerplexityRequestBody = {
				model,
				messages: [
					{
						role: "system",
						content: "You are a web search assistant. Give concise, factual answers with references.",
					},
					{ role: "user", content: params.query },
				],
			};

			if (params.recency) {
				requestBody.search_recency_filter = params.recency;
			}

			const response = await fetch(API_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(requestBody),
				signal,
			});

			const raw = await response.text();

			if (!response.ok) {
				return {
					content: [{ type: "text", text: parseErrorMessage(raw, response.status) }],
					isError: true,
					details: {},
				};
			}

			let parsed: PerplexityResponse;
			try {
				parsed = parseResponse(raw);
			} catch {
				return {
					content: [{ type: "text", text: "Perplexity returned invalid JSON." }],
					isError: true,
					details: {},
				};
			}

			const answer = extractAnswer(parsed);
			if (!answer) {
				return {
					content: [{ type: "text", text: "Perplexity response did not contain an answer." }],
					isError: true,
					details: {},
				};
			}

			const citations = extractCitations(parsed).slice(0, maxCitations);
			let output = answer;

			if (citations.length > 0) {
				output += "\n\nSources:";
				for (const [index, url] of citations.entries()) {
					output += `\n${index + 1}. ${url}`;
				}
			}

			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let finalText = truncation.content;
			if (truncation.truncated) {
				finalText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
			}

			const details: PerplexityToolDetails = {
				query: params.query,
				model,
				recency: params.recency,
				citations,
				usage: parsed.usage,
				truncated: truncation.truncated,
			};

			return {
				content: [{ type: "text", text: finalText }],
				details,
			};
		},
	});
}
