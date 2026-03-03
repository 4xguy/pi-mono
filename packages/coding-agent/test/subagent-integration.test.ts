import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchToRepo } from "../examples/extensions/subagent/integration.js";
import {
	createWorktree,
	getWorktreePatch,
	removeWorktree,
	runCommand,
} from "../examples/extensions/subagent/worktree.js";

const tempDirs: string[] = [];
const timeoutMs = 30_000;

function createTempRepo(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-integration-test-"));
	tempDirs.push(repo);
	return repo;
}

async function git(cwd: string, args: string[]): Promise<void> {
	const result = await runCommand("git", args, cwd, timeoutMs);
	if (!result.ok) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("subagent patch integration", () => {
	it("applies binary patch generated from worktree", async () => {
		const repo = createTempRepo();
		await git(repo, ["init"]);
		await git(repo, ["config", "user.email", "test@example.com"]);
		await git(repo, ["config", "user.name", "Test User"]);

		fs.writeFileSync(path.join(repo, "hello.txt"), "line one\n", "utf-8");
		await git(repo, ["add", "hello.txt"]);
		await git(repo, ["commit", "-m", "init"]);

		const created = await createWorktree(repo, timeoutMs);
		expect(created.handle).toBeDefined();
		if (!created.handle) throw new Error("worktree create failed");

		const worktree = created.handle;
		fs.writeFileSync(path.join(worktree.path, "hello.txt"), "line one\nline two\n", "utf-8");

		const patchResult = await getWorktreePatch(worktree.path, timeoutMs);
		expect(patchResult.error).toBeUndefined();
		expect(patchResult.patch).toContain("line two");

		const applyResult = await applyPatchToRepo(repo, patchResult.patch, timeoutMs);
		expect(applyResult.ok).toBe(true);
		expect(fs.readFileSync(path.join(repo, "hello.txt"), "utf-8")).toContain("line two");

		await removeWorktree(worktree.repoRoot, worktree.path, timeoutMs);
	});
});
