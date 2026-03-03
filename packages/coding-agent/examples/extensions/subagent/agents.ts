/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getAgentDir } from "../../../src/config.js";
import { parseFrontmatter } from "../../../src/utils/frontmatter.js";
import type { IsolationMode, TaskMode } from "./types.js";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	disallowedTools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	mode?: TaskMode;
	writePaths?: string[];
	isolation?: IsolationMode;
	timeoutMs?: number;
	useProactively?: boolean;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

type AgentFrontmatter = {
	name?: string;
	description?: string;
	tools?: string | string[];
	disallowedTools?: string | string[];
	model?: string;
	thinking?: string;
	mode?: string;
	writePaths?: string | string[];
	isolation?: string;
	timeoutMs?: number | string;
	useProactively?: boolean | string;
};

function parseListField(value: string | string[] | undefined): string[] | undefined {
	if (!value) return undefined;
	const rawItems = Array.isArray(value) ? value : value.split(",");
	const normalized = rawItems.map((item) => item.trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

function parseThinking(value: string | undefined): ThinkingLevel | undefined {
	if (!value) return undefined;
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	return undefined;
}

function parseMode(value: string | undefined): TaskMode | undefined {
	if (value === "read" || value === "write" || value === "auto") return value;
	return undefined;
}

function parseIsolation(value: string | undefined): IsolationMode | undefined {
	if (value === "none" || value === "worktree") return value;
	return undefined;
}

function parseTimeoutMs(value: number | string | undefined): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function parseUseProactively(value: boolean | string | undefined): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

export function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseListField(frontmatter.tools),
			disallowedTools: parseListField(frontmatter.disallowedTools),
			model: frontmatter.model,
			thinking: parseThinking(frontmatter.thinking),
			mode: parseMode(frontmatter.mode),
			writePaths: parseListField(frontmatter.writePaths),
			isolation: parseIsolation(frontmatter.isolation),
			timeoutMs: parseTimeoutMs(frontmatter.timeoutMs),
			useProactively: parseUseProactively(frontmatter.useProactively),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
		remaining,
	};
}
