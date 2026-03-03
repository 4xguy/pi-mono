import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createWorktree,
	detectGitRepoRoot,
	getWorktreePatch,
	hasWorktreeChanges,
	removeWorktree,
	runCommand,
} from "../examples/extensions/subagent/worktree.js";

const tempDirs: string[] = [];
const timeoutMs = 30_000;

async function git(cwd: string, args: string[]): Promise<void> {
	const result = await runCommand("git", args, cwd, timeoutMs);
	if (!result.ok) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
}

function createTempRepo(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-worktree-test-"));
	tempDirs.push(repo);
	return repo;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("subagent worktree", () => {
	it("creates isolated worktree and generates patch", async () => {
		const repo = createTempRepo();
		await git(repo, ["init"]);
		await git(repo, ["config", "user.email", "test@example.com"]);
		await git(repo, ["config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(repo, "file.txt"), "hello\n", "utf-8");
		await git(repo, ["add", "file.txt"]);
		await git(repo, ["commit", "-m", "init"]);

		const root = await detectGitRepoRoot(repo, timeoutMs);
		expect(root).toBe(repo);

		const created = await createWorktree(repo, timeoutMs);
		expect(created.handle).toBeDefined();
		if (!created.handle) throw new Error("worktree creation failed");

		const worktree = created.handle;
		const worktreeFile = path.join(worktree.path, "file.txt");
		expect(fs.existsSync(worktreeFile)).toBe(true);

		fs.writeFileSync(worktreeFile, "hello\nfrom worktree\n", "utf-8");
		expect(await hasWorktreeChanges(worktree.path, timeoutMs)).toBe(true);

		const patch = await getWorktreePatch(worktree.path, timeoutMs);
		expect(patch.error).toBeUndefined();
		expect(patch.patch).toContain("from worktree");

		await removeWorktree(worktree.repoRoot, worktree.path, timeoutMs);
		expect(fs.existsSync(worktree.path)).toBe(false);
	});
});
