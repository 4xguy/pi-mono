import type {
  CapabilityManifestDocument,
  CapabilityValidationReportDocument,
} from "../contracts/capability.ts";
import type { RunDocument } from "../contracts/run.ts";
import { createFoundryService } from "./service.ts";
import type { FabricScope } from "../storage/paths.ts";

export interface FabricTestOptions {
  scope?: FabricScope;
  cwd?: string;
  capabilityIdOrAlias: string;
  input: unknown;
}

export interface FabricTestOutput {
  run: RunDocument;
  passed: boolean;
  manifest: CapabilityManifestDocument;
  report: CapabilityValidationReportDocument;
  reportPath: string;
  runtimeRunId: string | null;
}

export async function runFabricTest(options: FabricTestOptions): Promise<FabricTestOutput> {
  const foundry = createFoundryService(options);
  const result = await foundry.testCapability({
    capabilityIdOrAlias: options.capabilityIdOrAlias,
    input: options.input,
  });

  return {
    run: result.run,
    passed: result.passed,
    manifest: result.manifest,
    report: result.report,
    reportPath: result.reportPath,
    runtimeRunId: result.runtimeRunId,
  };
}
