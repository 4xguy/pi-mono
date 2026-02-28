export const CAPABILITY_STATUSES = ["draft", "tested", "promoted", "blocked", "deprecated"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const CAPABILITY_LANGUAGES = ["python", "typescript"] as const;
export type CapabilityLanguage = (typeof CAPABILITY_LANGUAGES)[number];

export const RUN_TYPES = ["coordinator", "foundry", "runtime"] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const RUN_STATUSES = ["pending", "running", "completed", "failed", "aborted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const EVENT_TYPES = [
  "run_started",
  "task_assigned",
  "capability_generated",
  "validation_passed",
  "validation_failed",
  "capability_promoted",
  "artifact_emitted",
  "run_completed",
  "run_failed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const CAPABILITY_ID_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)+$/;
export const PROFILE_ID_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
export const RUN_ID_PATTERN = /^run_[0-9]{8}_[0-9]{6}_[0-9]{3,}$/;
export const CAPABILITY_VERSION_REF_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)+@[^\s@]+$/;

export interface VersionedDocument {
  schema_version: "1";
}

export interface TimestampedDocument {
  created_at: string;
  last_updated: string;
}

export type UnknownRecord = Record<string, unknown>;

export class ContractValidationError extends Error {
  readonly fieldPath: string;

  constructor(fieldPath: string, message: string) {
    super(`Contract validation error at "${fieldPath}": ${message}`);
    this.name = "ContractValidationError";
    this.fieldPath = fieldPath;
  }
}

export function nowIsoTimestamp(): string {
  return new Date().toISOString();
}

export function isRfc3339Timestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}
