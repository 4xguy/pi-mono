import type { CapabilityRegistryEntry } from "../contracts/capability.ts";
import { createRegistryService } from "./service.ts";
import type { FabricScope } from "../storage/paths.ts";

export interface FabricListOptions {
  scope?: FabricScope;
  cwd?: string;
  status?: CapabilityRegistryEntry["status"];
  tag?: string;
  query?: string;
}

export interface FabricListOutput {
  count: number;
  capabilities: CapabilityRegistryEntry[];
}

export async function runFabricList(options: FabricListOptions = {}): Promise<FabricListOutput> {
  const service = createRegistryService(options);
  const capabilities = await service.listCapabilities({
    status: options.status,
    tag: options.tag,
    query: options.query,
  });

  return {
    count: capabilities.length,
    capabilities,
  };
}
