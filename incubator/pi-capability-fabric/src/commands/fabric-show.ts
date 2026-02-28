import type { CapabilityManifestDocument, CapabilityRegistryEntry } from "../contracts/capability.js";
import { createRegistryService } from "./service.js";
import type { FabricScope } from "../storage/paths.js";

export interface FabricShowOptions {
  scope?: FabricScope;
  cwd?: string;
}

export interface FabricShowOutput {
  capability: {
    entry: CapabilityRegistryEntry;
    manifest: CapabilityManifestDocument;
  } | null;
}

export async function runFabricShow(capabilityIdOrAlias: string, options: FabricShowOptions = {}): Promise<FabricShowOutput> {
  const service = createRegistryService(options);
  const capability = await service.getCapability(capabilityIdOrAlias);

  return {
    capability: capability ? { entry: capability.entry, manifest: capability.manifest } : null,
  };
}
