import type { CapabilityLanguage } from "../contracts/common.js";
import type { CapabilityManifestDocument, CapabilityRegistryEntry } from "../contracts/capability.js";
import type { RunDocument } from "../contracts/run.js";
import { createFoundryService } from "./service.js";
import type { FabricScope } from "../storage/paths.js";

export interface FabricBuildOptions {
  scope?: FabricScope;
  cwd?: string;
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

export interface FabricBuildOutput {
  run: RunDocument;
  entry: CapabilityRegistryEntry;
  manifest: CapabilityManifestDocument;
  createdPaths: string[];
}

export async function runFabricBuild(options: FabricBuildOptions): Promise<FabricBuildOutput> {
  const foundry = createFoundryService(options);
  const result = await foundry.buildCapability({
    capabilityId: options.capabilityId,
    name: options.name,
    language: options.language,
    description: options.description,
    tags: options.tags,
    version: options.version,
    alias: options.alias,
    authProvider: options.authProvider,
    authScopes: options.authScopes,
  });

  return {
    run: result.run,
    entry: result.entry,
    manifest: result.manifest,
    createdPaths: result.createdPaths,
  };
}
