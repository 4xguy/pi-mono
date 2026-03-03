import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { buildCuratedContent, collectTouchedPaths } from "../examples/extensions/subagent/curation.js";
import type { SingleResult } from "../examples/extensions/subagent/types.js";

function assistantTextMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeResult(agent: string, text: string, exitCode = 0): SingleResult {
	return {
		agent,
		agentSource: "user",
		task: `${agent}-task`,
		exitCode,
		messages: [assistantTextMessage(text)],
		stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	};
}

describe("subagent curation", () => {
	it("builds compact single output", () => {
		const content = buildCuratedContent("single", [makeResult("worker", "A".repeat(600))], 120);
		expect(content.length).toBe(120);
		expect(content.endsWith("...")).toBe(true);
	});

	it("builds aggregate summaries for chain/parallel", () => {
		const results = [
			makeResult("scout", "scout findings"),
			makeResult("planner", "plan output"),
			makeResult("worker", "done"),
		];
		expect(buildCuratedContent("chain", results, 500)).toContain("Chain: 3/3 succeeded");
		expect(buildCuratedContent("parallel", results, 500)).toContain("Parallel: 3/3 succeeded");
	});

	it("includes failure metadata in summary lines", () => {
		const failed = makeResult("worker", "failed output", 1);
		failed.integrationError = "apply failed";
		const text = buildCuratedContent("parallel", [failed], 500);
		expect(text).toContain("failed");
		expect(text).toContain("patch:failed");
	});

	it("collects touched paths from tool calls", () => {
		const assistant = {
			...assistantTextMessage("tool activity"),
			content: [
				{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/a.ts" } },
				{ type: "toolCall", id: "2", name: "edit", arguments: { file_path: "src/b.ts" } },
			],
		} as unknown as Message;
		const paths = collectTouchedPaths([assistant]);
		expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
	});
});
