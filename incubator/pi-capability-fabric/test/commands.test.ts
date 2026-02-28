import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFabricInit } from "../src/commands/fabric-init.js";
import { runFabricList } from "../src/commands/fabric-list.js";
import { runFabricProfiles } from "../src/commands/fabric-profiles.js";
import { runFabricRun } from "../src/commands/fabric-run.js";
import { runFabricRuns } from "../src/commands/fabric-runs.js";
import { runFabricShow } from "../src/commands/fabric-show.js";
import type {
  CapabilityManifestDocument,
  CapabilityRegistryEntry,
} from "../src/contracts/capability.js";
import type { RunDocument } from "../src/contracts/run.js";
import { CapabilityRegistryRepository } from "../src/repositories/capability-registry-repo.js";
import { RunRepository } from "../src/repositories/run-repo.js";
import { writeTextFileAtomic } from "../src/storage/files.js";
import { getFabricPaths } from "../src/storage/paths.js";
import { encodeYaml } from "../src/storage/yaml.js";
import { createTempDir, removeTempDir } from "./helpers.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((path) => removeTempDir(path)));
});

function capabilityEntry(): CapabilityRegistryEntry {
  return {
    id: "github.issues.search",
    latest_version: "0.2.0",
    status: "tested",
    tags: ["github", "issues"],
    manifest_path: "capabilities/github.issues.search/manifest.yaml",
  };
}

function capabilityManifest(): CapabilityManifestDocument {
  return {
    schema_version: "1",
    id: "github.issues.search",
    name: "GitHub Issue Search",
    status: "tested",
    version: "0.2.0",
    language: "typescript",
    entrypoint: "capabilities/github.issues.search/index.ts",
    description: "Search repository issues",
    tags: ["github", "issues"],
    auth: {
      provider: "github-token",
      scopes: ["repo"],
    },
    policy: {
      network: true,
      filesystem_write: false,
      timeout_sec: 60,
    },
    interfaces: {
      input_schema: "capabilities/github.issues.search/input.schema.json",
      output_schema: "capabilities/github.issues.search/output.schema.json",
    },
    quality: {
      success_rate: 0.9,
      runs: 10,
      last_validated_at: "2026-02-27T15:00:00.000Z",
    },
    provenance: {
      created_by: "foundry",
      source_refs: ["docs/github-search-api"],
    },
    created_at: "2026-02-27T14:40:00.000Z",
    last_updated: "2026-02-27T15:00:00.000Z",
  };
}

function runDocument(): RunDocument {
  return {
    schema_version: "1",
    run_id: "run_20260227_151500_002",
    type: "runtime",
    status: "running",
    started_at: "2026-02-27T15:15:00.000Z",
    ended_at: null,
    profile: "default",
    parent_run_id: null,
    worker: {
      id: "worker-runtime-2",
      pid: null,
    },
    capabilities_used: ["github.issues.search@0.2.0"],
    artifacts: [],
    error: null,
  };
}

function runtimeScript(): string {
  return [
    'import { readFileSync } from "node:fs";',
    "const input = JSON.parse(readFileSync(0, 'utf8'));",
    "console.log(JSON.stringify({ ok: true, input }));",
    "",
  ].join("\n");
}

describe("commands", () => {
  it("returns list/show/profiles/runs output", async () => {
    const cwd = await createTempDir("pi-cap-fabric-cmd-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });

    const paths = getFabricPaths({ scope: "project", cwd });
    const registryRepo = new CapabilityRegistryRepository(paths);
    const entry = capabilityEntry();

    await registryRepo.upsertCapabilityEntry(entry);
    await registryRepo.setAlias("gh-issues", entry.id);

    await writeTextFileAtomic(join(paths.root, entry.manifest_path), encodeYaml(capabilityManifest()));

    const runRepo = new RunRepository(paths);
    await runRepo.createRun(runDocument());

    const listOutput = await runFabricList({ scope: "project", cwd, status: "tested" });
    expect(listOutput.count).toBe(1);
    expect(listOutput.capabilities[0]?.id).toBe("github.issues.search");

    const showOutput = await runFabricShow("gh-issues", { scope: "project", cwd });
    expect(showOutput.capability?.entry.id).toBe("github.issues.search");

    const profilesOutput = await runFabricProfiles({ scope: "project", cwd });
    expect(profilesOutput.count).toBe(1);
    expect(profilesOutput.profiles[0]?.id).toBe("default");

    const runningRuns = await runFabricRuns({ scope: "project", cwd, status: "running" });
    expect(runningRuns.count).toBe(1);
    expect(runningRuns.runs[0]?.run_id).toBe("run_20260227_151500_002");
  });

  it("runs a capability via runtime command", async () => {
    const cwd = await createTempDir("pi-cap-fabric-cmd-run-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });

    const paths = getFabricPaths({ scope: "project", cwd });
    const registryRepo = new CapabilityRegistryRepository(paths);
    const entry = capabilityEntry();

    await registryRepo.upsertCapabilityEntry(entry);
    await registryRepo.setAlias("gh-issues", entry.id);
    await writeTextFileAtomic(join(paths.root, entry.manifest_path), encodeYaml(capabilityManifest()));
    await writeTextFileAtomic(join(paths.root, "capabilities/github.issues.search/index.ts"), runtimeScript());

    const result = await runFabricRun("gh-issues", {
      scope: "project",
      cwd,
      input: {
        query: "bug",
      },
      allowUnpromoted: true,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      ok: true,
      input: {
        query: "bug",
      },
    });

    const runsOutput = await runFabricRuns({ scope: "project", cwd, status: "completed" });
    expect(runsOutput.count).toBe(1);
  });
});
