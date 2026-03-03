import { join } from "node:path";
import type {
  CapabilityManifestDocument,
  CapabilityRegistryEntry,
  CapabilityValidationReportDocument,
} from "../contracts/capability.js";
import {
  CAPABILITY_ID_PATTERN,
  nowIsoTimestamp,
  type CapabilityLanguage,
  type RunStatus,
} from "../contracts/common.js";
import type { RunEventDocument } from "../contracts/event.js";
import type { RunDocument } from "../contracts/run.js";
import {
  parseCapabilityManifestDocument,
  parseCapabilityValidationReportDocument,
  parseRunDocument,
  parseRunEventDocument,
} from "../contracts/validators.js";
import { RegistryService } from "../registry/registry-service.js";
import { RunRepository } from "../repositories/run-repo.js";
import { RuntimeService } from "../runtime/runtime-service.js";
import { generateRunId } from "../runtime/run-id.js";
import { fileExists, readTextFile, writeTextFileAtomic } from "../storage/files.js";
import { type FabricPaths, getFabricPaths } from "../storage/paths.js";
import { decodeYaml, encodeYaml } from "../storage/yaml.js";

interface FoundryServiceOptions {
  paths?: FabricPaths;
  registryService?: RegistryService;
  runRepository?: RunRepository;
  runtimeService?: RuntimeService;
}

export interface BuildCapabilityOptions {
  capabilityId: string;
  name: string;
  language: CapabilityLanguage;
  description?: string;
  tags?: string[];
  version?: string;
  alias?: string;
  authProvider?: string;
  authScopes?: string[];
}

export interface BuildCapabilityResult {
  run: RunDocument;
  entry: CapabilityRegistryEntry;
  manifest: CapabilityManifestDocument;
  createdPaths: string[];
}

export interface TestCapabilityOptions {
  capabilityIdOrAlias: string;
  input: unknown;
}

export interface TestCapabilityResult {
  run: RunDocument;
  passed: boolean;
  manifest: CapabilityManifestDocument;
  report: CapabilityValidationReportDocument;
  reportPath: string;
  runtimeRunId: string | null;
}

export interface PromoteCapabilityOptions {
  capabilityIdOrAlias: string;
}

export interface PromoteCapabilityResult {
  run: RunDocument;
  entry: CapabilityRegistryEntry;
  manifest: CapabilityManifestDocument;
  report: CapabilityValidationReportDocument;
}

function createEvent(
  runId: string,
  eventType: RunEventDocument["event_type"],
  payload: Record<string, unknown>,
): RunEventDocument {
  return parseRunEventDocument({
    schema_version: "1",
    run_id: runId,
    event_type: eventType,
    timestamp: nowIsoTimestamp(),
    payload,
  });
}

function createFoundryRun(runId: string, capabilityRef: string | null): RunDocument {
  return parseRunDocument({
    schema_version: "1",
    run_id: runId,
    type: "foundry",
    status: "running",
    started_at: nowIsoTimestamp(),
    ended_at: null,
    profile: null,
    parent_run_id: null,
    worker: {
      id: "worker-foundry",
      pid: process.pid,
    },
    capabilities_used: capabilityRef ? [capabilityRef] : [],
    artifacts: [],
    error: null,
  });
}

function createTypeScriptTemplate(capabilityId: string): string {
  return [
    'import { readFileSync } from "node:fs";',
    "",
    "const input = JSON.parse(readFileSync(0, \"utf8\"));",
    "",
    "console.log(",
    "  JSON.stringify({",
    `    capability_id: \"${capabilityId}\",`,
    "    ok: true,",
    "    input,",
    "  }),",
    ");",
    "",
  ].join("\n");
}

function createPythonTemplate(capabilityId: string): string {
  return [
    "import json",
    "import sys",
    "",
    "def main() -> None:",
    "    payload = sys.stdin.read().strip()",
    "    input_data = json.loads(payload) if payload else None",
    "    output = {",
    `        \"capability_id\": \"${capabilityId}\",`,
    "        \"ok\": True,",
    "        \"input\": input_data,",
    "    }",
    "    print(json.dumps(output))",
    "",
    "if __name__ == \"__main__\":",
    "    main()",
    "",
  ].join("\n");
}

function defaultDescription(capabilityId: string): string {
  return `Generated capability ${capabilityId}`;
}

function uniqueTags(tags: string[] | undefined): string[] {
  if (!tags) {
    return [];
  }

  const normalized = tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return [...new Set(normalized)];
}

export class FoundryService {
  readonly paths: FabricPaths;
  readonly registry: RegistryService;
  readonly runs: RunRepository;
  readonly runtime: RuntimeService;

  constructor(options: FoundryServiceOptions = {}) {
    this.paths = options.paths ?? getFabricPaths();
    this.registry = options.registryService ?? new RegistryService(this.paths);
    this.runs = options.runRepository ?? new RunRepository(this.paths);
    this.runtime =
      options.runtimeService ??
      new RuntimeService({
        paths: this.paths,
        registryService: this.registry,
        runRepository: this.runs,
      });
  }

  private async startRun(capabilityRef: string | null, task: string): Promise<RunDocument> {
    const runId = generateRunId();
    const run = createFoundryRun(runId, capabilityRef);

    await this.runs.createRun(run);
    await this.runs.appendEvent(runId, createEvent(runId, "run_started", { task }));
    await this.runs.appendEvent(runId, createEvent(runId, "task_assigned", { task }));

    return run;
  }

  private async finalizeRun(runId: string, status: RunStatus, error: string | null = null): Promise<RunDocument> {
    return this.runs.markRunStatus(runId, status, error);
  }

  private getManifestPath(capabilityId: string): string {
    return `capabilities/${capabilityId}/manifest.yaml`;
  }

  private getValidationReportPath(capabilityId: string, version: string): string {
    return `capabilities/${capabilityId}/versions/${version}/evidence/validation-report.json`;
  }

  private async saveManifest(
    manifestPath: string,
    manifest: CapabilityManifestDocument,
  ): Promise<CapabilityManifestDocument> {
    const validated = parseCapabilityManifestDocument(manifest);
    await writeTextFileAtomic(join(this.paths.root, manifestPath), encodeYaml(validated));
    return validated;
  }

  private async loadManifest(
    entry: CapabilityRegistryEntry,
  ): Promise<CapabilityManifestDocument> {
    const manifestAbsolutePath = join(this.paths.root, entry.manifest_path);
    if (!(await fileExists(manifestAbsolutePath))) {
      throw new Error(`Capability manifest not found: ${manifestAbsolutePath}`);
    }

    const raw = await readTextFile(manifestAbsolutePath);
    return parseCapabilityManifestDocument(decodeYaml(raw));
  }

  async buildCapability(options: BuildCapabilityOptions): Promise<BuildCapabilityResult> {
    if (!CAPABILITY_ID_PATTERN.test(options.capabilityId)) {
      throw new Error(`Invalid capability id format: ${options.capabilityId}`);
    }

    const existing = await this.registry.capabilityRegistry.getCapabilityEntry(options.capabilityId);
    if (existing) {
      throw new Error(`Capability already exists: ${options.capabilityId}`);
    }

    const version = options.version ?? "v0001";
    const capabilityRef = `${options.capabilityId}@${version}`;
    const run = await this.startRun(capabilityRef, "build capability scaffold");

    try {
      const now = nowIsoTimestamp();
      const tags = uniqueTags(options.tags);
      const manifestPath = this.getManifestPath(options.capabilityId);
      const toolFile = options.language === "python" ? "tool.py" : "tool.ts";
      const entrypoint = `versions/${version}/${toolFile}`;
      const inputSchemaPath = `versions/${version}/schema.input.json`;
      const outputSchemaPath = `versions/${version}/schema.output.json`;

      const manifest = parseCapabilityManifestDocument({
        schema_version: "1",
        id: options.capabilityId,
        name: options.name,
        status: "draft",
        version,
        language: options.language,
        entrypoint,
        description: options.description ?? defaultDescription(options.capabilityId),
        tags,
        auth: {
          provider: options.authProvider ?? "none",
          scopes: uniqueTags(options.authScopes),
        },
        policy: {
          network: false,
          filesystem_write: false,
          timeout_sec: 60,
        },
        interfaces: {
          input_schema: inputSchemaPath,
          output_schema: outputSchemaPath,
        },
        quality: {
          success_rate: 0,
          runs: 0,
          last_validated_at: now,
        },
        provenance: {
          created_by: "foundry",
          source_refs: [],
        },
        created_at: now,
        last_updated: now,
      });

      const createdPaths: string[] = [];
      const manifestAbsolutePath = join(this.paths.root, manifestPath);
      await writeTextFileAtomic(manifestAbsolutePath, encodeYaml(manifest));
      createdPaths.push(manifestPath);

      const toolRelativePath = `capabilities/${options.capabilityId}/versions/${version}/${toolFile}`;
      const toolAbsolutePath = join(this.paths.root, toolRelativePath);
      const toolTemplate =
        options.language === "python"
          ? createPythonTemplate(options.capabilityId)
          : createTypeScriptTemplate(options.capabilityId);
      await writeTextFileAtomic(toolAbsolutePath, toolTemplate);
      createdPaths.push(toolRelativePath);

      const inputSchemaRelativePath = `capabilities/${options.capabilityId}/versions/${version}/schema.input.json`;
      await writeTextFileAtomic(
        join(this.paths.root, inputSchemaRelativePath),
        `${JSON.stringify({
          type: "object",
          additionalProperties: true,
        }, null, 2)}\n`,
      );
      createdPaths.push(inputSchemaRelativePath);

      const outputSchemaRelativePath = `capabilities/${options.capabilityId}/versions/${version}/schema.output.json`;
      await writeTextFileAtomic(
        join(this.paths.root, outputSchemaRelativePath),
        `${JSON.stringify({
          type: "object",
          additionalProperties: true,
        }, null, 2)}\n`,
      );
      createdPaths.push(outputSchemaRelativePath);

      const smokeTestRelativePath = `capabilities/${options.capabilityId}/versions/${version}/tests/smoke.yaml`;
      await writeTextFileAtomic(
        join(this.paths.root, smokeTestRelativePath),
        [
          'schema_version: "1"',
          `capability_id: "${options.capabilityId}"`,
          `version: "${version}"`,
          "input:",
          "  sample: true",
          "expect:",
          "  ok: true",
          "",
        ].join("\n"),
      );
      createdPaths.push(smokeTestRelativePath);

      const contractTestRelativePath = `capabilities/${options.capabilityId}/versions/${version}/tests/contract.yaml`;
      await writeTextFileAtomic(
        join(this.paths.root, contractTestRelativePath),
        [
          'schema_version: "1"',
          `capability_id: "${options.capabilityId}"`,
          `version: "${version}"`,
          "notes: verify input/output contract compatibility",
          "",
        ].join("\n"),
      );
      createdPaths.push(contractTestRelativePath);

      const validationReportRelativePath = this.getValidationReportPath(options.capabilityId, version);
      await writeTextFileAtomic(
        join(this.paths.root, validationReportRelativePath),
        `${JSON.stringify(
          {
            schema_version: "1",
            capability_id: options.capabilityId,
            version,
            validated_at: now,
            checks: {
              syntax: false,
              smoke: false,
              contract: false,
              policy: true,
            },
            result: "fail",
            runtime_run_id: null,
          },
          null,
          2,
        )}\n`,
      );
      createdPaths.push(validationReportRelativePath);

      const entry: CapabilityRegistryEntry = {
        id: options.capabilityId,
        latest_version: version,
        status: "draft",
        tags: manifest.tags,
        manifest_path: manifestPath,
      };

      await this.registry.capabilityRegistry.upsertCapabilityEntry(entry);

      if (options.alias) {
        await this.registry.capabilityRegistry.setAlias(options.alias, options.capabilityId);
      }

      await this.runs.appendEvent(
        run.run_id,
        createEvent(run.run_id, "capability_generated", {
          capability_id: options.capabilityId,
          version,
          language: options.language,
        }),
      );

      const completedRun = await this.finalizeRun(run.run_id, "completed");

      return {
        run: completedRun,
        entry,
        manifest,
        createdPaths,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finalizeRun(run.run_id, "failed", message);
      throw error;
    }
  }

  async testCapability(options: TestCapabilityOptions): Promise<TestCapabilityResult> {
    const resolvedId = await this.registry.resolveCapabilityId(options.capabilityIdOrAlias);
    if (!resolvedId) {
      throw new Error(`Capability not found: ${options.capabilityIdOrAlias}`);
    }

    const entry = await this.registry.capabilityRegistry.getCapabilityEntry(resolvedId);
    if (!entry) {
      throw new Error(`Capability entry not found: ${resolvedId}`);
    }

    const manifest = await this.loadManifest(entry);
    const capabilityRef = `${entry.id}@${manifest.version}`;
    const run = await this.startRun(capabilityRef, "validate capability");

    try {
      const runtimeResult = await this.runtime.executeCapability({
        capabilityIdOrAlias: entry.id,
        input: options.input,
        allowUnpromoted: true,
        parentRunId: run.run_id,
      });

      const passed = runtimeResult.ok;
      const now = nowIsoTimestamp();
      const reportRelativePath = this.getValidationReportPath(entry.id, manifest.version);

      const report = parseCapabilityValidationReportDocument({
        schema_version: "1",
        capability_id: entry.id,
        version: manifest.version,
        validated_at: now,
        checks: {
          syntax: true,
          smoke: passed,
          contract: passed,
          policy: true,
        },
        result: passed ? "pass" : "fail",
        runtime_run_id: runtimeResult.run.run_id,
      });

      await writeTextFileAtomic(
        join(this.paths.root, reportRelativePath),
        `${JSON.stringify(report, null, 2)}\n`,
      );

      const previousRuns = manifest.quality.runs;
      const previousSuccesses = manifest.quality.success_rate * previousRuns;
      const newRuns = previousRuns + 1;
      const newSuccesses = previousSuccesses + (passed ? 1 : 0);
      const newSuccessRate = newRuns === 0 ? 0 : newSuccesses / newRuns;

      const nextStatus = passed ? "tested" : "blocked";
      const updatedManifest: CapabilityManifestDocument = parseCapabilityManifestDocument({
        ...manifest,
        status: nextStatus,
        quality: {
          success_rate: Number(newSuccessRate.toFixed(6)),
          runs: newRuns,
          last_validated_at: now,
        },
        last_updated: now,
      });

      await this.saveManifest(entry.manifest_path, updatedManifest);

      const updatedEntry: CapabilityRegistryEntry = {
        ...entry,
        status: nextStatus,
        latest_version: updatedManifest.version,
        tags: updatedManifest.tags,
      };

      await this.registry.capabilityRegistry.upsertCapabilityEntry(updatedEntry);

      await this.runs.appendEvent(
        run.run_id,
        createEvent(run.run_id, passed ? "validation_passed" : "validation_failed", {
          capability_id: entry.id,
          version: updatedManifest.version,
          runtime_run_id: runtimeResult.run.run_id,
        }),
      );

      const completedRun = await this.finalizeRun(run.run_id, "completed");

      return {
        run: completedRun,
        passed,
        manifest: updatedManifest,
        report,
        reportPath: reportRelativePath,
        runtimeRunId: runtimeResult.run.run_id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finalizeRun(run.run_id, "failed", message);
      throw error;
    }
  }

  async promoteCapability(options: PromoteCapabilityOptions): Promise<PromoteCapabilityResult> {
    const resolvedId = await this.registry.resolveCapabilityId(options.capabilityIdOrAlias);
    if (!resolvedId) {
      throw new Error(`Capability not found: ${options.capabilityIdOrAlias}`);
    }

    const entry = await this.registry.capabilityRegistry.getCapabilityEntry(resolvedId);
    if (!entry) {
      throw new Error(`Capability entry not found: ${resolvedId}`);
    }

    const manifest = await this.loadManifest(entry);
    const capabilityRef = `${entry.id}@${manifest.version}`;
    const run = await this.startRun(capabilityRef, "promote capability");

    try {
      if (manifest.status !== "tested") {
        throw new Error(
          `Capability ${entry.id} status=${manifest.status}. tested status required before promotion`,
        );
      }

      const reportRelativePath = this.getValidationReportPath(entry.id, manifest.version);
      const reportAbsolutePath = join(this.paths.root, reportRelativePath);

      if (!(await fileExists(reportAbsolutePath))) {
        throw new Error(`Validation report not found: ${reportRelativePath}`);
      }

      const reportRaw = await readTextFile(reportAbsolutePath);
      const report = parseCapabilityValidationReportDocument(
        JSON.parse(reportRaw) as unknown,
      );

      if (report.result !== "pass") {
        throw new Error(`Validation report result is ${report.result}. pass required before promotion`);
      }

      const now = nowIsoTimestamp();
      const promotedManifest = parseCapabilityManifestDocument({
        ...manifest,
        status: "promoted",
        last_updated: now,
      });

      await this.saveManifest(entry.manifest_path, promotedManifest);

      const promotedEntry: CapabilityRegistryEntry = {
        ...entry,
        status: "promoted",
        latest_version: promotedManifest.version,
        tags: promotedManifest.tags,
      };

      await this.registry.capabilityRegistry.upsertCapabilityEntry(promotedEntry);

      await this.runs.appendEvent(
        run.run_id,
        createEvent(run.run_id, "capability_promoted", {
          capability_id: promotedEntry.id,
          version: promotedManifest.version,
        }),
      );

      const completedRun = await this.finalizeRun(run.run_id, "completed");

      return {
        run: completedRun,
        entry: promotedEntry,
        manifest: promotedManifest,
        report,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finalizeRun(run.run_id, "failed", message);
      throw error;
    }
  }
}
