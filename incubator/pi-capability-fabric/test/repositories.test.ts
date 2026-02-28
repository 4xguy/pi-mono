import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFabricInit } from "../src/commands/fabric-init.js";
import type { CapabilityManifestDocument, CapabilityRegistryEntry } from "../src/contracts/capability.js";
import type { ProfileDocument } from "../src/contracts/profile.js";
import type { RunDocument } from "../src/contracts/run.js";
import type { RunEventDocument } from "../src/contracts/event.js";
import { CapabilityRegistryRepository } from "../src/repositories/capability-registry-repo.js";
import { ProfileRepository } from "../src/repositories/profile-repo.js";
import { RunRepository } from "../src/repositories/run-repo.js";
import { RegistryService } from "../src/registry/registry-service.js";
import { getFabricPaths } from "../src/storage/paths.js";
import { writeTextFileAtomic } from "../src/storage/files.js";
import { encodeYaml } from "../src/storage/yaml.js";
import { createTempDir, removeTempDir } from "./helpers.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((path) => removeTempDir(path)));
});

function makeCapabilityEntry(): CapabilityRegistryEntry {
  return {
    id: "google.calendar.events",
    latest_version: "0.1.0",
    status: "promoted",
    tags: ["google", "calendar"],
    manifest_path: "capabilities/google.calendar.events/manifest.yaml",
  };
}

function makeManifest(): CapabilityManifestDocument {
  return {
    schema_version: "1",
    id: "google.calendar.events",
    name: "Google Calendar Events",
    status: "promoted",
    version: "0.1.0",
    language: "typescript",
    entrypoint: "capabilities/google.calendar.events/index.ts",
    description: "Lists calendar events",
    tags: ["google", "calendar"],
    auth: {
      provider: "google-oauth",
      scopes: ["calendar.readonly"],
    },
    policy: {
      network: true,
      filesystem_write: false,
      timeout_sec: 120,
    },
    interfaces: {
      input_schema: "capabilities/google.calendar.events/input.schema.json",
      output_schema: "capabilities/google.calendar.events/output.schema.json",
    },
    quality: {
      success_rate: 1,
      runs: 1,
      last_validated_at: "2026-02-27T15:00:00.000Z",
    },
    provenance: {
      created_by: "foundry",
      source_refs: ["docs/google-calendar-api"],
    },
    created_at: "2026-02-27T14:59:00.000Z",
    last_updated: "2026-02-27T15:00:00.000Z",
  };
}

function makeProfile(): ProfileDocument {
  return {
    schema_version: "1",
    id: "planner",
    name: "Planner",
    system_prompt: "Plan and coordinate work.",
    allowed_tags: ["google"],
    default_policies: {
      require_promoted_capabilities: true,
      max_parallel_workers: 4,
    },
    created_at: "2026-02-27T15:00:00.000Z",
    last_updated: "2026-02-27T15:00:00.000Z",
  };
}

function makeRun(): RunDocument {
  return {
    schema_version: "1",
    run_id: "run_20260227_150000_001",
    type: "runtime",
    status: "running",
    started_at: "2026-02-27T15:00:00.000Z",
    ended_at: null,
    profile: "default",
    parent_run_id: null,
    worker: {
      id: "worker-runtime-1",
      pid: null,
    },
    capabilities_used: ["google.calendar.events@0.1.0"],
    artifacts: [],
    error: null,
  };
}

function makeEvent(): RunEventDocument {
  return {
    schema_version: "1",
    run_id: "run_20260227_150000_001",
    event_type: "run_started",
    timestamp: "2026-02-27T15:00:01.000Z",
    payload: {
      stage: "runtime",
    },
  };
}

describe("repositories", () => {
  it("manages capability registry + alias + manifest resolution", async () => {
    const cwd = await createTempDir("pi-cap-fabric-repo-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });

    const paths = getFabricPaths({ scope: "project", cwd });
    const registryRepo = new CapabilityRegistryRepository(paths);

    const entry = makeCapabilityEntry();
    await registryRepo.upsertCapabilityEntry(entry);
    await registryRepo.setAlias("calendar", entry.id);

    const manifest = makeManifest();
    await writeTextFileAtomic(join(paths.root, entry.manifest_path), encodeYaml(manifest));

    const service = new RegistryService(paths);
    const capability = await service.getCapability("calendar");

    expect(capability?.entry.id).toBe(entry.id);
    expect(capability?.manifest.name).toBe("Google Calendar Events");

    const resolved = await registryRepo.resolveAlias("calendar");
    expect(resolved).toBe(entry.id);
  });

  it("saves, lists, and deletes profiles", async () => {
    const cwd = await createTempDir("pi-cap-fabric-profile-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });

    const paths = getFabricPaths({ scope: "project", cwd });
    const profileRepo = new ProfileRepository(paths);

    const saved = await profileRepo.saveProfile(makeProfile());
    expect(saved.id).toBe("planner");

    const loaded = await profileRepo.loadProfile("planner");
    expect(loaded?.name).toBe("Planner");

    const ids = await profileRepo.listProfileIds();
    expect(ids).toContain("planner");
    expect(ids).toContain("default");

    const deleted = await profileRepo.deleteProfile("planner");
    expect(deleted).toBe(true);
    const missing = await profileRepo.loadProfile("planner");
    expect(missing).toBeUndefined();
  });

  it("persists runs and JSONL events", async () => {
    const cwd = await createTempDir("pi-cap-fabric-run-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });

    const paths = getFabricPaths({ scope: "project", cwd });
    const runRepo = new RunRepository(paths);

    await runRepo.createRun(makeRun());
    await runRepo.appendEvent("run_20260227_150000_001", makeEvent());

    const events = await runRepo.loadEvents("run_20260227_150000_001");
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("run_started");

    const updated = await runRepo.markRunStatus("run_20260227_150000_001", "completed");
    expect(updated.status).toBe("completed");
    expect(updated.ended_at).not.toBeNull();

    const runs = await runRepo.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.run_id).toBe("run_20260227_150000_001");
  });
});
