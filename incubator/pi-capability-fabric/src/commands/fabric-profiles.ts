import type { ProfileDocument } from "../contracts/profile.ts";
import { createRegistryService } from "./service.ts";
import type { FabricScope } from "../storage/paths.ts";

export interface FabricProfilesOptions {
  scope?: FabricScope;
  cwd?: string;
}

export interface FabricProfilesOutput {
  count: number;
  profiles: ProfileDocument[];
}

export async function runFabricProfiles(options: FabricProfilesOptions = {}): Promise<FabricProfilesOutput> {
  const service = createRegistryService(options);
  const profiles = await service.listProfiles();

  return {
    count: profiles.length,
    profiles,
  };
}
