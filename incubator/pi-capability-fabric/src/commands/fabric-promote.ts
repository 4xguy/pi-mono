import type {
  CapabilityManifestDocument,
  CapabilityRegistryEntry,
  CapabilityValidationReportDocument,
} from "../contracts/capability.js";
import type { RunDocument } from "../contracts/run.js";
import { createFoundryService } from "./service.js";
import type { FabricScope } from "../storage/paths.js";

export interface FabricPromoteOptions {
  scope?: FabricScope;
  cwd?: string;
  capabilityIdOrAlias: string;
}

export interface FabricPromoteOutput {
  run: RunDocument;
  entry: CapabilityRegistryEntry;
  manifest: CapabilityManifestDocument;
  report: CapabilityValidationReportDocument;
}

export async function runFabricPromote(options: FabricPromoteOptions): Promise<FabricPromoteOutput> {
  const foundry = createFoundryService(options);
  const result = await foundry.promoteCapability({
    capabilityIdOrAlias: options.capabilityIdOrAlias,
  });

  return {
    run: result.run,
    entry: result.entry,
    manifest: result.manifest,
    report: result.report,
  };
}
