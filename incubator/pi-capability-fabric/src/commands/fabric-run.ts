import type { RunDocument } from "../contracts/run.js";
import type { SandboxExecutionResult } from "../runtime/sandbox.js";
import { createRuntimeService } from "./service.js";
import type { FabricScope } from "../storage/paths.js";

export interface FabricRunOptions {
  scope?: FabricScope;
  cwd?: string;
  profile?: string;
  allowUnpromoted?: boolean;
  input: unknown;
}

export interface FabricRunOutput {
  ok: boolean;
  run: RunDocument;
  output: unknown;
  artifactPath: string | null;
  error: string | null;
  sandbox: SandboxExecutionResult | null;
}

export async function runFabricRun(
  capabilityIdOrAlias: string,
  options: FabricRunOptions,
): Promise<FabricRunOutput> {
  const runtime = createRuntimeService(options);
  const result = await runtime.executeCapability({
    capabilityIdOrAlias,
    input: options.input,
    profileId: options.profile,
    allowUnpromoted: options.allowUnpromoted,
  });

  return {
    ok: result.ok,
    run: result.run,
    output: result.output,
    artifactPath: result.artifactPath,
    error: result.error,
    sandbox: result.sandbox,
  };
}
