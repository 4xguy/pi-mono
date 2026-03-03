import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "./worktree.js";

export interface PatchApplyResult {
	ok: boolean;
	error?: string;
}

function writePatchTempFile(patch: string): { dir: string; filePath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-patch-"));
	const filePath = path.join(dir, "changes.patch");
	fs.writeFileSync(filePath, patch, "utf-8");
	return { dir, filePath };
}

function cleanupPatchTempFile(temp: { dir: string; filePath: string }): void {
	try {
		if (fs.existsSync(temp.filePath)) fs.unlinkSync(temp.filePath);
	} catch {
		// ignore
	}
	try {
		if (fs.existsSync(temp.dir)) fs.rmdirSync(temp.dir);
	} catch {
		// ignore
	}
}

export async function applyPatchToRepo(cwd: string, patch: string, timeoutMs: number): Promise<PatchApplyResult> {
	if (!patch.trim()) return { ok: true };

	const temp = writePatchTempFile(patch);
	try {
		const result = await runCommand("git", ["apply", "--3way", "--whitespace=nowarn", temp.filePath], cwd, timeoutMs);
		if (result.ok) return { ok: true };
		return {
			ok: false,
			error: result.stderr || result.stdout || "Failed to apply patch",
		};
	} finally {
		cleanupPatchTempFile(temp);
	}
}
