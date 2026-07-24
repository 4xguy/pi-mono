import type { CapabilityManifestDocument, CapabilityRegistryEntry } from "../contracts/capability.ts";
import { createRegistryService } from "./service.ts";
import type { FabricScope } from "../storage/paths.ts";

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
