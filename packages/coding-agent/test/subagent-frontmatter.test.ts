import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentsFromDir } from "../examples/extensions/subagent/agents.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function createTempAgentsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-frontmatter-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("subagent frontmatter parsing", () => {
	it("parses extended frontmatter fields", () => {
		const dir = createTempAgentsDir();
		const filePath = path.join(dir, "worker.md");
		fs.writeFileSync(
			filePath,
			`---
name: worker
description: Handles implementation
tools: [read, edit, write]
disallowedTools: bash
model: claude-sonnet-4-5
thinking: high
mode: write
writePaths: src/**
isolation: worktree
timeoutMs: 45000
useProactively: true
---
System prompt body
`,
			"utf-8",
		);

		const agents = loadAgentsFromDir(dir, "user");
		expect(agents).toHaveLength(1);
		expect(agents[0].name).toBe("worker");
		expect(agents[0].tools).toEqual(["read", "edit", "write"]);
		expect(agents[0].disallowedTools).toEqual(["bash"]);
		expect(agents[0].thinking).toBe("high");
		expect(agents[0].mode).toBe("write");
		expect(agents[0].writePaths).toEqual(["src/**"]);
		expect(agents[0].isolation).toBe("worktree");
		expect(agents[0].timeoutMs).toBe(45000);
		expect(agents[0].useProactively).toBe(true);
		expect(agents[0].systemPrompt).toContain("System prompt body");
	});

	it("ignores invalid optional field values but keeps valid required fields", () => {
		const dir = createTempAgentsDir();
		const filePath = path.join(dir, "scout.md");
		fs.writeFileSync(
			filePath,
			`---
name: scout
description: Recon
thinking: turbo
mode: destructive
isolation: unknown
timeoutMs: invalid
useProactively: maybe
---
Scout prompt
`,
			"utf-8",
		);

		const agents = loadAgentsFromDir(dir, "user");
		expect(agents).toHaveLength(1);
		expect(agents[0].thinking).toBeUndefined();
		expect(agents[0].mode).toBeUndefined();
		expect(agents[0].isolation).toBeUndefined();
		expect(agents[0].timeoutMs).toBeUndefined();
		expect(agents[0].useProactively).toBeUndefined();
	});
});
