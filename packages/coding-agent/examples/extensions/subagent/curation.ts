import type { Message, TextContent } from "@mariozechner/pi-ai";
import type { SingleResult, SubagentExecutionMode } from "./types.js";

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function firstAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") {
				return (part as TextContent).text;
			}
		}
	}
	return "";
}

function summarizeResultLine(result: SingleResult, maxChars: number): string {
	const status = result.exitCode === 0 ? "ok" : "failed";
	const output = firstAssistantText(result.messages);
	const preview = output.length > 0 ? truncate(output.replace(/\s+/g, " "), maxChars) : "(no output)";
	const patch = result.patchApplied ? " patch:applied" : result.integrationError ? " patch:failed" : "";
	const retry = result.retried ? " retry" : "";
	return `[${result.agent}] ${status}${patch}${retry} ${preview}`;
}

export function buildCuratedContent(mode: SubagentExecutionMode, results: SingleResult[], maxChars: number): string {
	if (results.length === 0) return "(no output)";

	if (mode === "single") {
		const output = firstAssistantText(results[0].messages);
		if (!output) return "(no output)";
		return truncate(output, maxChars);
	}

	if (mode === "chain") {
		const successCount = results.filter((result) => result.exitCode === 0).length;
		const lines = results.map((result) => summarizeResultLine(result, 180));
		return truncate(`Chain: ${successCount}/${results.length} succeeded\n\n${lines.join("\n")}`, maxChars);
	}

	const successCount = results.filter((result) => result.exitCode === 0).length;
	const lines = results.map((result) => summarizeResultLine(result, 180));
	return truncate(`Parallel: ${successCount}/${results.length} succeeded\n\n${lines.join("\n")}`, maxChars);
}

export function collectTouchedPaths(messages: Message[]): string[] {
	const paths = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const args = part.arguments as Record<string, unknown>;
			const candidate = args.path ?? args.file_path;
			if (typeof candidate === "string" && candidate.length > 0) {
				paths.add(candidate);
			}
		}
	}
	return [...paths].sort();
}
