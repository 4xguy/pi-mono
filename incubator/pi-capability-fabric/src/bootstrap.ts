import type { FabricPathOptions, FabricPaths } from "./storage/paths.ts";
import { getFabricPaths } from "./storage/paths.ts";
import { ensureDirectories } from "./storage/files.ts";
import { seedFabricFiles, type SeedResult } from "./registry/seed.ts";

export interface BootstrapResult {
  paths: FabricPaths;
  seededFiles: SeedResult[];
}

export async function bootstrapCapabilityFabric(options: FabricPathOptions = {}): Promise<BootstrapResult> {
  const paths = getFabricPaths(options);

  await ensureDirectories([
    paths.root,
    paths.registryDir,
    paths.capabilitiesDir,
    paths.profilesDir,
    paths.runsDir,
    paths.handoffsDir,
    paths.policiesDir,
  ]);

  const seededFiles = await seedFabricFiles(paths);

  return {
    paths,
    seededFiles,
  };
}
