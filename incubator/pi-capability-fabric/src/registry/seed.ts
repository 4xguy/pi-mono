import { join } from "node:path";
import { nowIsoTimestamp } from "../contracts/common.js";
import type { FabricPaths } from "../storage/paths.js";
import { writeTextFileIfMissing } from "../storage/files.js";

export interface SeedResult {
  path: string;
  created: boolean;
}

function capabilitiesRegistrySeed(now: string): string {
  return [
    'schema_version: "1"',
    `updated_at: "${now}"`,
    "capabilities: []",
    "",
  ].join("\n");
}

function aliasesRegistrySeed(now: string): string {
  return [
    'schema_version: "1"',
    `updated_at: "${now}"`,
    "aliases: {}",
    "",
  ].join("\n");
}

function defaultPolicySeed(now: string): string {
  return [
    'schema_version: "1"',
    `created_at: "${now}"`,
    `last_updated: "${now}"`,
    "require_promoted_capabilities: true",
    "max_parallel_workers: 3",
    "",
  ].join("\n");
}

function defaultProfileSeed(now: string): string {
  return [
    'schema_version: "1"',
    'id: "default"',
    'name: "Default"',
    `created_at: "${now}"`,
    `last_updated: "${now}"`,
    'system_prompt: "You are a general-purpose capability runtime profile."',
    "allowed_tags: []",
    "default_policies:",
    "  require_promoted_capabilities: true",
    "  max_parallel_workers: 3",
    "",
  ].join("\n");
}

export async function seedFabricFiles(paths: FabricPaths): Promise<SeedResult[]> {
  const now = nowIsoTimestamp();

  const targets: Array<{ path: string; content: string }> = [
    {
      path: join(paths.registryDir, "capabilities.yaml"),
      content: capabilitiesRegistrySeed(now),
    },
    {
      path: join(paths.registryDir, "aliases.yaml"),
      content: aliasesRegistrySeed(now),
    },
    {
      path: join(paths.policiesDir, "default.yaml"),
      content: defaultPolicySeed(now),
    },
    {
      path: join(paths.profilesDir, "default.yaml"),
      content: defaultProfileSeed(now),
    },
  ];

  const results: SeedResult[] = [];

  for (const target of targets) {
    const created = await writeTextFileIfMissing(target.path, target.content);
    results.push({ path: target.path, created });
  }

  return results;
}
