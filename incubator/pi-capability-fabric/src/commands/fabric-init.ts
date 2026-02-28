import { bootstrapCapabilityFabric } from "../bootstrap.js";
import type { FabricScope } from "../storage/paths.js";

export interface FabricInitOptions {
  scope?: FabricScope;
  cwd?: string;
}

export interface FabricInitOutput {
  root: string;
  scope: FabricScope;
  createdFiles: string[];
  existingFiles: string[];
}

export async function runFabricInit(options: FabricInitOptions = {}): Promise<FabricInitOutput> {
  const { paths, seededFiles } = await bootstrapCapabilityFabric({
    scope: options.scope,
    cwd: options.cwd,
  });

  const createdFiles = seededFiles.filter((file) => file.created).map((file) => file.path);
  const existingFiles = seededFiles.filter((file) => !file.created).map((file) => file.path);

  return {
    root: paths.root,
    scope: paths.scope,
    createdFiles,
    existingFiles,
  };
}
