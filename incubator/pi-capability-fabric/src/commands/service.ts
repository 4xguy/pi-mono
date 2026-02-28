import { RegistryService } from "../registry/registry-service.js";
import { RuntimeService } from "../runtime/runtime-service.js";
import { type FabricScope, getFabricPaths } from "../storage/paths.js";

export interface FabricCommandContextOptions {
  scope?: FabricScope;
  cwd?: string;
}

export function createRegistryService(options: FabricCommandContextOptions = {}): RegistryService {
  const paths = getFabricPaths({
    scope: options.scope,
    cwd: options.cwd,
  });

  return new RegistryService(paths);
}

export function createRuntimeService(options: FabricCommandContextOptions = {}): RuntimeService {
  const paths = getFabricPaths({
    scope: options.scope,
    cwd: options.cwd,
  });

  return new RuntimeService({
    paths,
  });
}
