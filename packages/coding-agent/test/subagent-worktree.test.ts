import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupWorktreeSession,
	createWorktreeAssignment,
	createWorktreeSession,
	decideExecutionIsolation,
	integrateWorktreeAssignments,
	parseExecutionIsolation,
	resolveWorktreeTaskCwd,
} from "../examples/extensions/subagent/worktree.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("subagent worktree isolation", () => {
	it("parses execution isolation with fallback", () => {
		expect(parseExecutionIsolation("worktree", "auto")).toBe("worktree");
		expect(parseExecutionIsolation("auto", "shared")).toBe("auto");
		expect(parseExecutionIsolation("invalid", "shared")).toBe("shared");
		expect(parseExecutionIsolation(undefined, "worktree")).toBe("worktree");
	});

	it("chooses worktree automatically for parallel write intent", () => {
		const decision = decideExecutionIsolation({
			requestedIsolation: "auto",
			mode: "parallel",
			tasks: [
				{ task: "List files" },
				{ task: "Implement auth refactor and modify schema", agentTools: ["read", "write"] },
			],
		});
		expect(decision.selectedIsolation).toBe("worktree");
		expect(decision.reason).toContain("parallel lane");
	});

	it("chooses shared automatically for parallel read-only intent", () => {
		const decision = decideExecutionIsolation({
			requestedIsolation: "auto",
			mode: "parallel",
			tasks: [{ task: "List files" }, { task: "Find references and summarize" }],
		});
		expect(decision.selectedIsolation).toBe("shared");
		expect(decision.reason).toContain("read-only");
	});

	it("honors explicit isolation overrides", () => {
		const shared = decideExecutionIsolation({
			requestedIsolation: "shared",
			mode: "parallel",
			tasks: [{ task: "Implement change" }, { task: "Implement other change" }],
		});
		expect(shared.selectedIsolation).toBe("shared");

		const worktree = decideExecutionIsolation({
			requestedIsolation: "worktree",
			mode: "single",
			single: { task: "List files" },
		});
		expect(worktree.selectedIsolation).toBe("worktree");
	});

	it("maps task cwd into worktree and warns for out-of-repo paths", () => {
		const repoRoot = "/tmp/repo";
		const worktreePath = "/tmp/worktree";
		const inside = resolveWorktreeTaskCwd(repoRoot, worktreePath, "/tmp/repo/packages/agent");
		expect(inside.cwd).toBe("/tmp/worktree/packages/agent");
		expect(inside.warning).toBeUndefined();

		const outside = resolveWorktreeTaskCwd(repoRoot, worktreePath, "/opt/other");
		expect(outside.cwd).toBe(worktreePath);
		expect(outside.warning).toContain("outside repo root");
	});

	it("creates worktree lanes, integrates patches, and cleans up", () => {
		const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-worktree-"));
		tempDirs.push(repoDir);
		runGit(repoDir, ["init"]);
		runGit(repoDir, ["config", "user.email", "worktree-test@example.com"]);
		runGit(repoDir, ["config", "user.name", "Worktree Test"]);
		fs.writeFileSync(path.join(repoDir, "note.txt"), "base\n", "utf8");
		runGit(repoDir, ["add", "note.txt"]);
		runGit(repoDir, ["commit", "-m", "init"]);

		const session = createWorktreeSession({ cwd: repoDir, runId: "testrun" });
		const assignment = createWorktreeAssignment(session, "parallel-1-worker");

		fs.writeFileSync(path.join(assignment.worktreePath, "note.txt"), "base\nupdated\n", "utf8");
		const reports = integrateWorktreeAssignments(session, [assignment]);
		expect(reports).toHaveLength(1);
		expect(reports[0].status).toBe("applied");

		const rootContent = fs.readFileSync(path.join(repoDir, "note.txt"), "utf8");
		expect(rootContent).toContain("updated");

		const warnings = cleanupWorktreeSession(session);
		expect(warnings).toHaveLength(0);
		expect(fs.existsSync(assignment.worktreePath)).toBe(false);
	});
});

function runGit(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if ((result.status ?? 1) !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	}
}
