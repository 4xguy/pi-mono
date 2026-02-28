import { dirname, join } from "node:path";
import type {
  CapabilityManifestDocument,
  CapabilityRegistryEntry,
} from "../contracts/capability.js";
import { nowIsoTimestamp } from "../contracts/common.js";
import type { RunEventDocument } from "../contracts/event.js";
import type { ProfileDocument } from "../contracts/profile.js";
import type { RunDocument } from "../contracts/run.js";
import { parseRunDocument, parseRunEventDocument } from "../contracts/validators.js";
import { RegistryService } from "../registry/registry-service.js";
import { RunRepository } from "../repositories/run-repo.js";
import { fileExists, writeTextFileAtomic } from "../storage/files.js";
import { type FabricPaths, getFabricPaths } from "../storage/paths.js";
import { generateRunId } from "./run-id.js";
import { LocalProcessSandbox } from "./local-process-sandbox.js";
import type { SandboxAdapter, SandboxExecutionResult } from "./sandbox.js";

interface RuntimeServiceOptions {
  paths?: FabricPaths;
  registryService?: RegistryService;
  runRepository?: RunRepository;
  sandbox?: SandboxAdapter;
}

export interface ExecuteCapabilityOptions {
  capabilityIdOrAlias: string;
  input: unknown;
  profileId?: string | null;
  allowUnpromoted?: boolean;
  parentRunId?: string | null;
  workerId?: string;
}

export interface ExecuteCapabilityResult {
  ok: boolean;
  run: RunDocument;
  output: unknown;
  artifactPath: string | null;
  error: string | null;
  sandbox: SandboxExecutionResult | null;
}

function ensureTagAllowed(profile: ProfileDocument | undefined, manifest: CapabilityManifestDocument): void {
  if (!profile) {
    return;
  }

  if (profile.allowed_tags.length === 0) {
    return;
  }

  const allowed = new Set(profile.allowed_tags);
  const hasMatch = manifest.tags.some((tag) => allowed.has(tag));

  if (!hasMatch) {
    throw new Error(
      `Capability ${manifest.id} is not permitted by profile ${profile.id} allowed_tags policy`,
    );
  }
}

function getCapabilityPathCandidates(
  paths: FabricPaths,
  entry: CapabilityRegistryEntry,
  relativePath: string,
): string[] {
  const manifestAbsolutePath = join(paths.root, entry.manifest_path);
  const manifestDirectory = dirname(manifestAbsolutePath);

  return [join(manifestDirectory, relativePath), join(paths.root, relativePath)];
}

function parseOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return {
      raw_stdout: stdout,
    };
  }
}

function normalizeRunError(result: SandboxExecutionResult): string {
  if (result.timedOut) {
    return `Sandbox execution timed out after ${result.durationMs}ms`;
  }

  const base = `Sandbox process exited with code ${result.exitCode ?? "null"}`;
  const stderr = result.stderr.trim();
  if (!stderr) {
    return base;
  }

  return `${base}: ${stderr}`;
}

function createRunDocument(
  runId: string,
  capability: CapabilityRegistryEntry,
  manifest: CapabilityManifestDocument,
  options: ExecuteCapabilityOptions,
): RunDocument {
  return parseRunDocument({
    schema_version: "1",
    run_id: runId,
    type: "runtime",
    status: "running",
    started_at: nowIsoTimestamp(),
    ended_at: null,
    profile: options.profileId ?? null,
    parent_run_id: options.parentRunId ?? null,
    worker: {
      id: options.workerId ?? "worker-runtime",
      pid: process.pid,
    },
    capabilities_used: [`${capability.id}@${manifest.version}`],
    artifacts: [],
    error: null,
  });
}

function createEvent(runId: string, eventType: RunEventDocument["event_type"], payload: Record<string, unknown>): RunEventDocument {
  return parseRunEventDocument({
    schema_version: "1",
    run_id: runId,
    event_type: eventType,
    timestamp: nowIsoTimestamp(),
    payload,
  });
}

export class RuntimeService {
  readonly paths: FabricPaths;
  readonly registry: RegistryService;
  readonly runs: RunRepository;
  readonly sandbox: SandboxAdapter;

  constructor(options: RuntimeServiceOptions = {}) {
    this.paths = options.paths ?? getFabricPaths();
    this.registry = options.registryService ?? new RegistryService(this.paths);
    this.runs = options.runRepository ?? new RunRepository(this.paths);
    this.sandbox = options.sandbox ?? new LocalProcessSandbox();
  }

  async executeCapability(options: ExecuteCapabilityOptions): Promise<ExecuteCapabilityResult> {
    const capability = await this.registry.getCapability(options.capabilityIdOrAlias);
    if (!capability) {
      throw new Error(`Capability not found: ${options.capabilityIdOrAlias}`);
    }

    const profile = options.profileId ? await this.registry.profiles.loadProfile(options.profileId) : undefined;
    const profileRequiresPromoted = profile?.default_policies.require_promoted_capabilities ?? true;

    const requirePromoted = !options.allowUnpromoted && profileRequiresPromoted;
    if (requirePromoted && capability.entry.status !== "promoted") {
      throw new Error(
        `Capability ${capability.entry.id} is status=${capability.entry.status}; promoted status required`,
      );
    }

    if (options.profileId && !profile) {
      throw new Error(`Profile not found: ${options.profileId}`);
    }

    ensureTagAllowed(profile, capability.manifest);

    const entrypointCandidates = getCapabilityPathCandidates(
      this.paths,
      capability.entry,
      capability.manifest.entrypoint,
    );

    let entrypointPath: string | undefined;
    for (const candidate of entrypointCandidates) {
      if (await fileExists(candidate)) {
        entrypointPath = candidate;
        break;
      }
    }

    if (!entrypointPath) {
      throw new Error(
        `Capability entrypoint not found. Checked: ${entrypointCandidates.join(", ")}`,
      );
    }

    const runId = generateRunId();
    const run = createRunDocument(runId, capability.entry, capability.manifest, options);
    await this.runs.createRun(run);

    await this.runs.appendEvent(
      runId,
      createEvent(runId, "run_started", {
        capability_id: capability.entry.id,
        version: capability.manifest.version,
      }),
    );

    await this.runs.appendEvent(
      runId,
      createEvent(runId, "task_assigned", {
        capability_id: capability.entry.id,
        profile: profile?.id ?? null,
      }),
    );

    const sandboxResult = await this.sandbox.execute({
      language: capability.manifest.language,
      entrypointPath,
      cwd: this.paths.root,
      input: options.input,
      timeoutSec: capability.manifest.policy.timeout_sec,
    });

    if (sandboxResult.timedOut || sandboxResult.exitCode !== 0) {
      const error = normalizeRunError(sandboxResult);
      const failed = await this.runs.markRunStatus(runId, "failed", error);
      await this.runs.appendEvent(
        runId,
        createEvent(runId, "run_failed", {
          error,
        }),
      );

      return {
        ok: false,
        run: failed,
        output: null,
        artifactPath: null,
        error,
        sandbox: sandboxResult,
      };
    }

    const output = parseOutput(sandboxResult.stdout);
    const artifactRelativePath = join("runs", runId, "artifacts", "output.json");
    const artifactAbsolutePath = join(this.paths.root, artifactRelativePath);

    await writeTextFileAtomic(
      artifactAbsolutePath,
      `${JSON.stringify(
        {
          schema_version: "1",
          run_id: runId,
          capability_id: capability.entry.id,
          version: capability.manifest.version,
          output,
          stdout: sandboxResult.stdout,
          stderr: sandboxResult.stderr,
          duration_ms: sandboxResult.durationMs,
          created_at: nowIsoTimestamp(),
        },
        null,
        2,
      )}\n`,
    );

    const completed: RunDocument = parseRunDocument({
      ...run,
      status: "completed",
      ended_at: nowIsoTimestamp(),
      artifacts: [artifactRelativePath],
      error: null,
    });

    await this.runs.saveRun(completed);

    await this.runs.appendEvent(
      runId,
      createEvent(runId, "artifact_emitted", {
        artifact_path: artifactRelativePath,
      }),
    );

    await this.runs.appendEvent(
      runId,
      createEvent(runId, "run_completed", {
        duration_ms: sandboxResult.durationMs,
      }),
    );

    return {
      ok: true,
      run: completed,
      output,
      artifactPath: artifactRelativePath,
      error: null,
      sandbox: sandboxResult,
    };
  }
}
