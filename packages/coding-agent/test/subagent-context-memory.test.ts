import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSharedContextPacket,
	createSharedContextStore,
	type SharedContextMode,
	type TaskHandoffEnvelope,
} from "../examples/extensions/subagent/context-memory.js";

describe("subagent shared context memory", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "subagent-memory-test-"));
		tempDirs.push(dir);
		return dir;
	}

	function makeEnvelope(partial?: Partial<TaskHandoffEnvelope>): TaskHandoffEnvelope {
		return {
			runId: partial?.runId ?? "run-1",
			taskId: partial?.taskId ?? "task-1",
			parentTaskId: partial?.parentTaskId,
			agent: partial?.agent ?? "worker",
			task: partial?.task ?? "Inspect auth code",
			mode: partial?.mode ?? "single",
			depth: partial?.depth ?? 1,
			createdAtMs: partial?.createdAtMs ?? Date.now(),
		};
	}

	it("writes and reads dispatch/observation entries from file-backed ledger", () => {
		const cwd = makeTempDir();
		const store = createSharedContextStore({ cwd, runId: "run-1" });
		store.appendDispatch(makeEnvelope(), "shared-read");
		store.appendObservation("task-1", "worker", "success", "Found auth middleware in src/auth.ts");

		const entries = store.readRecent(10);
		expect(entries.length).toBe(2);
		expect(entries[0]?.type).toBe("dispatch");
		expect(entries[1]?.type).toBe("observation");

		const ledgerPath = store.getLedgerPath();
		const raw = readFileSync(ledgerPath, "utf-8");
		expect(raw.includes('"type":"dispatch"')).toBe(true);
		expect(raw.includes('"type":"observation"')).toBe(true);
	});

	it("buildSharedContextPacket returns empty packet for isolated mode", () => {
		const packet = buildSharedContextPacket("isolated", makeEnvelope(), []);
		expect(packet).toBe("");
	});

	it("buildSharedContextPacket includes run/task metadata and recent entries", () => {
		const cwd = makeTempDir();
		const store = createSharedContextStore({ cwd, runId: "run-1" });
		store.appendDispatch(makeEnvelope({ taskId: "task-1", agent: "scout" }), "shared-read");
		store.appendObservation("task-1", "scout", "success", "Located provider mappings in stream.ts");

		const packet = buildSharedContextPacket("shared-read", makeEnvelope({ taskId: "task-2" }), store.readRecent(5));
		expect(packet.includes("run_id: run-1")).toBe(true);
		expect(packet.includes("task_id: task-2")).toBe(true);
		expect(packet.includes("recent_entries:")).toBe(true);
		expect(packet.includes("dispatch scout task:task-1")).toBe(true);
		expect(packet.includes("success scout task:task-1")).toBe(true);
	});

	it("readRecent applies limit to returned entries", () => {
		const cwd = makeTempDir();
		const store = createSharedContextStore({ cwd, runId: "run-1" });
		for (let i = 0; i < 6; i++) {
			store.appendObservation(`task-${i}`, "worker", "success", `summary-${i}`);
		}

		const entries = store.readRecent(3);
		expect(entries.length).toBe(3);
		expect(entries[0]?.type).toBe("observation");
		expect(entries[0] && "taskId" in entries[0] ? entries[0].taskId : "").toBe("task-3");
		expect(entries[2] && "taskId" in entries[2] ? entries[2].taskId : "").toBe("task-5");
	});

	it("supports explicit shared-write mode dispatch logging", () => {
		const cwd = makeTempDir();
		const store = createSharedContextStore({ cwd, runId: "run-2" });
		const mode: SharedContextMode = "shared-write";
		store.appendDispatch(makeEnvelope({ runId: "run-2", taskId: "task-x" }), mode);

		const entries = store.readRecent(5);
		expect(entries.length).toBe(1);
		expect(entries[0]?.type).toBe("dispatch");
		if (entries[0]?.type === "dispatch") {
			expect(entries[0].contextMode).toBe("shared-write");
		}
	});
});
