import type { CapabilityLanguage } from "../contracts/common.js";

export interface SandboxExecutionSpec {
  language: CapabilityLanguage;
  entrypointPath: string;
  cwd: string;
  input: unknown;
  timeoutSec: number;
  env?: Record<string, string>;
}

export interface SandboxExecutionResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SandboxAdapter {
  execute(spec: SandboxExecutionSpec): Promise<SandboxExecutionResult>;
}
