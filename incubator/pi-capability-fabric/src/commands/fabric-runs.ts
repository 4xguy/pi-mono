import type { RunDocument } from "../contracts/run.js";
import { createRegistryService } from "./service.js";
import type { FabricScope } from "../storage/paths.js";

export interface FabricRunsOptions {
  scope?: FabricScope;
  cwd?: string;
  status?: RunDocument["status"];
}

export interface FabricRunsOutput {
  count: number;
  runs: RunDocument[];
}

export async function runFabricRuns(options: FabricRunsOptions = {}): Promise<FabricRunsOutput> {
  const service = createRegistryService(options);
  const runs = await service.listRuns();

  const filtered = options.status ? runs.filter((run) => run.status === options.status) : runs;

  return {
    count: filtered.length,
    runs: filtered,
  };
}
