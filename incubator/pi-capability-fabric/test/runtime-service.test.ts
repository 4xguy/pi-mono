import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFabricInit } from "../src/commands/fabric-init.js";
import type {
  CapabilityManifestDocument,
  CapabilityRegistryEntry,
} from "../src/contracts/capability.js";
import type { ProfileDocument } from "../src/contracts/profile.js";
import { ProfileRepository } from "../src/repositories/profile-repo.js";
import { CapabilityRegistryRepository } from "../src/repositories/capability-registry-repo.js";
import { RunRepository } from "../src/repositories/run-repo.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { readTextFile, writeTextFileAtomic } from "../src/storage/files.js";
import { getFabricPaths } from "../src/storage/paths.js";
import { encodeYaml } from "../src/storage/yaml.js";
import { createTempDir, removeTempDir } from "./helpers.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((path) => removeTempDir(path)));
});

function makeCapabilityEntry(status: CapabilityRegistryEntry["status"] = "promoted"): CapabilityRegistryEntry {
  return {
    id: "runtime.echo.tool",
    latest_version: "0.1.0",
    status,
    tags: ["runtime", "echo"],
    manifest_path: "capabilities/runtime.echo.tool/manifest.yaml",
  };
}

function makeManifest(
  status: CapabilityManifestDocument["status"] = "promoted",
): CapabilityManifestDocument {
  return {
    schema_version: "1",
    id: "runtime.echo.tool",
    name: "Runtime Echo Tool",
    status,
    version: "0.1.0",
    language: "typescript",
    entrypoint: "capabilities/runtime.echo.tool/index.ts",
    description: "Echo input payload",
    tags: ["runtime", "echo"],
    auth: {
      provider: "none",
      scopes: [],
    },
    policy: {
      network: false,
      filesystem_write: false,
      timeout_sec: 30,
    },
    interfaces: {
      input_schema: "capabilities/runtime.echo.tool/input.schema.json",
      output_schema: "capabilities/runtime.echo.tool/output.schema.json",
    },
    quality: {
      success_rate: 1,
      runs: 1,
      last_validated_at: "2026-02-27T15:00:00.000Z",
    },
    provenance: {
      created_by: "foundry",
      source_refs: ["test/runtime"],
    },
    created_at: "2026-02-27T14:59:00.000Z",
    last_updated: "2026-02-27T15:00:00.000Z",
  };
}

function makeProfile(): ProfileDocument {
  return {
    schema_version: "1",
    id: "ops",
    name: "Ops",
    system_prompt: "Operate safely",
    allowed_tags: ["ops"],
    default_policies: {
      require_promoted_capabilities: true,
      max_parallel_workers: 2,
    },
    created_at: "2026-02-27T15:00:00.000Z",
    last_updated: "2026-02-27T15:00:00.000Z",
  };
}

function successScript(): string {
  return [
    'import { readFileSync } from "node:fs";',
    "const input = JSON.parse(readFileSync(0, 'utf8'));",
    "console.log(JSON.stringify({ echoed: input }));",
    "",
  ].join("\n");
}

function failureScript(): string {
  return [
    'throw new Error("intentional runtime failure");',
    "",
  ].join("\n");
}

describe("runtime service", () => {
  it("executes promoted capabilities and writes artifacts/events", async () => {
    const cwd = await createTempDir("pi-cap-fabric-runtime-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });
    const paths = getFabricPaths({ scope: "project", cwd });

    const registryRepo = new CapabilityRegistryRepository(paths);
    const entry = makeCapabilityEntry("promoted");
    await registryRepo.upsertCapabilityEntry(entry);
    await writeTextFileAtomic(join(paths.root, entry.manifest_path), encodeYaml(makeManifest("promoted")));
    await writeTextFileAtomic(join(paths.root, "capabilities/runtime.echo.tool/index.ts"), successScript());

    const runtime = new RuntimeService({ paths });
    const result = await runtime.executeCapability({
      capabilityIdOrAlias: entry.id,
      input: {
        hello: "world",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.run.status).toBe("completed");
    expect(result.output).toEqual({
      echoed: {
        hello: "world",
      },
    });
    expect(result.artifactPath).not.toBeNull();

    const artifactText = await readTextFile(join(paths.root, result.artifactPath ?? ""));
    const artifact = JSON.parse(artifactText) as { output: unknown };
    expect(artifact.output).toEqual({
      echoed: {
        hello: "world",
      },
    });

    const runRepo = new RunRepository(paths);
    const events = await runRepo.loadEvents(result.run.run_id);
    const eventTypes = events.map((event) => event.event_type);
    expect(eventTypes).toContain("run_started");
    expect(eventTypes).toContain("task_assigned");
    expect(eventTypes).toContain("artifact_emitted");
    expect(eventTypes).toContain("run_completed");
  });

  it("enforces promoted-only by default", async () => {
    const cwd = await createTempDir("pi-cap-fabric-runtime-promoted-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });
    const paths = getFabricPaths({ scope: "project", cwd });

    const registryRepo = new CapabilityRegistryRepository(paths);
    const entry = makeCapabilityEntry("tested");
    await registryRepo.upsertCapabilityEntry(entry);
    await writeTextFileAtomic(join(paths.root, entry.manifest_path), encodeYaml(makeManifest("tested")));
    await writeTextFileAtomic(join(paths.root, "capabilities/runtime.echo.tool/index.ts"), successScript());

    const runtime = new RuntimeService({ paths });

    await expect(
      runtime.executeCapability({
        capabilityIdOrAlias: entry.id,
        input: {
          x: 1,
        },
      }),
    ).rejects.toThrow(/promoted status required/);

    const allowed = await runtime.executeCapability({
      capabilityIdOrAlias: entry.id,
      input: {
        x: 1,
      },
      allowUnpromoted: true,
    });

    expect(allowed.ok).toBe(true);
  });

  it("enforces profile tag restrictions", async () => {
    const cwd = await createTempDir("pi-cap-fabric-runtime-profile-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });
    const paths = getFabricPaths({ scope: "project", cwd });

    const registryRepo = new CapabilityRegistryRepository(paths);
    const entry = makeCapabilityEntry("promoted");
    await registryRepo.upsertCapabilityEntry(entry);
    await writeTextFileAtomic(join(paths.root, entry.manifest_path), encodeYaml(makeManifest("promoted")));
    await writeTextFileAtomic(join(paths.root, "capabilities/runtime.echo.tool/index.ts"), successScript());

    const profileRepo = new ProfileRepository(paths);
    await profileRepo.saveProfile(makeProfile());

    const runtime = new RuntimeService({ paths });

    await expect(
      runtime.executeCapability({
        capabilityIdOrAlias: entry.id,
        input: {
          x: 1,
        },
        profileId: "ops",
      }),
    ).rejects.toThrow(/not permitted by profile/);
  });

  it("records failed runs when sandboxed script exits non-zero", async () => {
    const cwd = await createTempDir("pi-cap-fabric-runtime-fail-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });
    const paths = getFabricPaths({ scope: "project", cwd });

    const registryRepo = new CapabilityRegistryRepository(paths);
    const entry = makeCapabilityEntry("promoted");
    await registryRepo.upsertCapabilityEntry(entry);
    await writeTextFileAtomic(join(paths.root, entry.manifest_path), encodeYaml(makeManifest("promoted")));
    await writeTextFileAtomic(join(paths.root, "capabilities/runtime.echo.tool/index.ts"), failureScript());

    const runtime = new RuntimeService({ paths });
    const result = await runtime.executeCapability({
      capabilityIdOrAlias: entry.id,
      input: {
        hello: "failure",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.run.status).toBe("failed");
    expect(result.error).toMatch(/Sandbox process exited with code/);

    const runRepo = new RunRepository(paths);
    const events = await runRepo.loadEvents(result.run.run_id);
    const eventTypes = events.map((event) => event.event_type);
    expect(eventTypes).toContain("run_failed");
  });
});
