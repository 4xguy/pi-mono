import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunEventDocument } from "../contracts/event.js";
import type { RunDocument } from "../contracts/run.js";
import { nowIsoTimestamp } from "../contracts/common.js";
import { parseRunDocument, parseRunEventDocument } from "../contracts/validators.js";
import {
  appendTextLine,
  fileExists,
  readTextFile,
  writeTextFileAtomic,
  writeTextFileIfMissing,
} from "../storage/files.js";
import { type FabricPaths, getFabricPaths } from "../storage/paths.js";
import { decodeYaml, encodeYaml } from "../storage/yaml.js";

export class RunRepository {
  constructor(private readonly paths: FabricPaths = getFabricPaths()) {}

  private getRunDirectory(runId: string): string {
    return join(this.paths.runsDir, runId);
  }

  private getRunPath(runId: string): string {
    return join(this.getRunDirectory(runId), "run.yaml");
  }

  private getEventsPath(runId: string): string {
    return join(this.getRunDirectory(runId), "events.jsonl");
  }

  async listRunIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.paths.runsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  async listRuns(): Promise<RunDocument[]> {
    const runIds = await this.listRunIds();
    const runs: RunDocument[] = [];

    for (const runId of runIds) {
      const run = await this.loadRun(runId);
      if (run) {
        runs.push(run);
      }
    }

    return runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  async loadRun(runId: string): Promise<RunDocument | undefined> {
    const runPath = this.getRunPath(runId);
    if (!(await fileExists(runPath))) {
      return undefined;
    }

    const raw = await readTextFile(runPath);
    return parseRunDocument(decodeYaml(raw));
  }

  async createRun(document: RunDocument): Promise<RunDocument> {
    const validated = parseRunDocument(document);
    const runDirectory = this.getRunDirectory(validated.run_id);
    const runPath = this.getRunPath(validated.run_id);
    const eventsPath = this.getEventsPath(validated.run_id);

    await mkdir(runDirectory, { recursive: true });
    await writeTextFileAtomic(runPath, encodeYaml(validated));
    await writeTextFileIfMissing(eventsPath, "");

    return validated;
  }

  async saveRun(document: RunDocument): Promise<RunDocument> {
    const validated = parseRunDocument(document);
    const runPath = this.getRunPath(validated.run_id);

    await writeTextFileAtomic(runPath, encodeYaml(validated));
    return validated;
  }

  async markRunStatus(
    runId: string,
    status: RunDocument["status"],
    error: string | null = null,
  ): Promise<RunDocument> {
    const run = await this.loadRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const isTerminal = status === "completed" || status === "failed" || status === "aborted";
    const updated: RunDocument = {
      ...run,
      status,
      ended_at: isTerminal ? nowIsoTimestamp() : run.ended_at,
      error,
    };

    return this.saveRun(updated);
  }

  async appendEvent(runId: string, event: RunEventDocument): Promise<RunEventDocument> {
    const validated = parseRunEventDocument(event);
    if (validated.run_id !== runId) {
      throw new Error(`run_id mismatch: expected ${runId}, got ${validated.run_id}`);
    }

    const eventsPath = this.getEventsPath(runId);
    await appendTextLine(eventsPath, JSON.stringify(validated));

    return validated;
  }

  async loadEvents(runId: string): Promise<RunEventDocument[]> {
    const eventsPath = this.getEventsPath(runId);
    if (!(await fileExists(eventsPath))) {
      return [];
    }

    const raw = await readTextFile(eventsPath);
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);

    const events: RunEventDocument[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line) as unknown;
      events.push(parseRunEventDocument(parsed));
    }

    return events;
  }
}
