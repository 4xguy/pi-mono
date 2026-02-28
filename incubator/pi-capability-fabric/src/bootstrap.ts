import type { FabricPathOptions, FabricPaths } from "./storage/paths.js";
import { getFabricPaths } from "./storage/paths.js";
import { ensureDirectories } from "./storage/files.js";
import { seedFabricFiles, type SeedResult } from "./registry/seed.js";

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
