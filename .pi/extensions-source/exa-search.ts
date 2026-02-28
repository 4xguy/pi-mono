/**
 * Exa Search Tool
 *
 * Adds an `exa_search` tool that queries Exa's web search API and returns
 * ranked results with links and snippets.
 *
 * Required env var:
 *   EXA_API_KEY
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

const API_URL = "https://api.exa.ai/search";
const SEARCH_TYPES = ["neural", "keyword"] as const;
const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_MAX_CITATIONS = 5;
const MAX_SNIPPET_CHARS = 320;

type SearchType = (typeof SEARCH_TYPES)[number];

const TOOL_PARAMS = Type.Object({
	query: Type.String({ description: "Search query." }),
	searchType: Type.Optional(StringEnum(SEARCH_TYPES)),
	numResults: Type.Optional(
		Type.Integer({
			description: "Number of results to return (1-20).",
			minimum: 1,
			maximum: 20,
		}),
	),
	maxCitations: Type.Optional(
		Type.Integer({
			description: "Maximum number of citation URLs to include in the output (0-20).",
			minimum: 0,
			maximum: 20,
		}),
	),
	includeDomains: Type.Optional(
		Type.Array(Type.String({ description: "Domain to include, e.g. example.com" })),
	),
	excludeDomains: Type.Optional(
		Type.Array(Type.String({ description: "Domain to exclude, e.g. pinterest.com" })),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

interface ExaSearchRequest {
	query: string;
	numResults: number;
	type?: SearchType;
	includeDomains?: string[];
	excludeDomains?: string[];
}

interface ExaSearchResult {
	title?: string;
	url?: string;
	publishedDate?: string;
	text?: string;
	author?: string;
}

interface ExaSearchResponse {
	results?: ExaSearchResult[];
	requestId?: string;
	error?: string;
	tag?: string;
}

interface ExaToolResultItem {
	title: string;
	url: string;
	publishedDate?: string;
	snippet?: string;
}

interface ExaToolDetails {
	query: string;
	searchType?: SearchType;
	numResults: number;
	returnedResults: number;
	citations: string[];
	requestId?: string;
	truncated: boolean;
	results: ExaToolResultItem[];
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined) {
		return fallback;
	}
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeSnippet(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (!singleLine) {
		return undefined;
	}
	if (singleLine.length <= MAX_SNIPPET_CHARS) {
		return singleLine;
	}
	return `${singleLine.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

function parseErrorMessage(raw: string, status: number): string {
	const fallback = `Exa request failed with status ${status}.`;
	if (!raw.trim()) {
		return fallback;
	}

	try {
		const parsed = JSON.parse(raw) as ExaSearchResponse;
		if (parsed.error && parsed.error.trim().length > 0) {
			return parsed.error;
		}
	} catch {
		// Ignore parse failures and fall back to raw text.
	}

	return `${fallback} ${raw.trim()}`;
}

function safeParseResponse(raw: string): ExaSearchResponse | undefined {
	try {
		return JSON.parse(raw) as ExaSearchResponse;
	} catch {
		return undefined;
	}
}

function formatResults(query: string, items: ExaToolResultItem[], citations: string[]): string {
	if (items.length === 0) {
		return `No results found for: ${query}`;
	}

	let output = `Top results for: ${query}`;
	for (const [index, item] of items.entries()) {
		output += `\n\n${index + 1}. ${item.title}`;
		output += `\n   ${item.url}`;
		if (item.publishedDate) {
			output += `\n   Published: ${item.publishedDate}`;
		}
		if (item.snippet) {
			output += `\n   Snippet: ${item.snippet}`;
		}
	}

	if (citations.length > 0) {
		output += "\n\nSources:";
		for (const [index, url] of citations.entries()) {
			output += `\n${index + 1}. ${url}`;
		}
	}

	return output;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description: `Search the web using Exa AI. Returns ranked results with URLs and short snippets. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Requires EXA_API_KEY.`,
		parameters: TOOL_PARAMS,
		async execute(_toolCallId, params: ToolParams, signal, onUpdate) {
			const apiKey = process.env.EXA_API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text", text: "Missing EXA_API_KEY. Set it in your environment and retry." }],
					isError: true,
					details: {},
				};
			}

			const numResults = clamp(params.numResults, DEFAULT_NUM_RESULTS, 1, 20);
			const maxCitations = clamp(params.maxCitations, DEFAULT_MAX_CITATIONS, 0, 20);

			onUpdate?.({
				content: [{ type: "text", text: `Searching Exa for: ${params.query}` }],
				details: { query: params.query, numResults, searchType: params.searchType },
			});

			const requestBody: ExaSearchRequest = {
				query: params.query,
				numResults,
			};
			if (params.searchType) {
				requestBody.type = params.searchType;
			}
			if (params.includeDomains && params.includeDomains.length > 0) {
				requestBody.includeDomains = params.includeDomains;
			}
			if (params.excludeDomains && params.excludeDomains.length > 0) {
				requestBody.excludeDomains = params.excludeDomains;
			}

			const response = await fetch(API_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": apiKey,
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

			const parsed = safeParseResponse(raw);
			if (!parsed) {
				return {
					content: [{ type: "text", text: "Exa returned invalid JSON." }],
					isError: true,
					details: {},
				};
			}

			const results = Array.isArray(parsed.results) ? parsed.results : [];
			const normalizedItems: ExaToolResultItem[] = results.map((result, index) => {
				const title = result.title?.trim();
				const fallbackTitle = `Result ${index + 1}`;
				const url = result.url?.trim() ?? "";
				return {
					title: title && title.length > 0 ? title : fallbackTitle,
					url,
					publishedDate: result.publishedDate?.trim(),
					snippet: normalizeSnippet(result.text),
				};
			});

			const citations: string[] = [];
			for (const item of normalizedItems) {
				if (item.url.length === 0) {
					continue;
				}
				if (!citations.includes(item.url)) {
					citations.push(item.url);
				}
				if (citations.length >= maxCitations) {
					break;
				}
			}

			const formatted = formatResults(params.query, normalizedItems, citations);
			const truncation = truncateHead(formatted, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let finalText = truncation.content;
			if (truncation.truncated) {
				finalText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
			}

			const details: ExaToolDetails = {
				query: params.query,
				searchType: params.searchType,
				numResults,
				returnedResults: normalizedItems.length,
				citations,
				requestId: parsed.requestId,
				truncated: truncation.truncated,
				results: normalizedItems,
			};

			return {
				content: [{ type: "text", text: finalText }],
				details,
			};
		},
	});
}
