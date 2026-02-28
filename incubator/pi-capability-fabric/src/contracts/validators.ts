import { isAbsolute } from "node:path";
import type {
  CapabilityAliasRegistryDocument,
  CapabilityManifestDocument,
  CapabilityRegistryDocument,
  CapabilityRegistryEntry,
} from "./capability.js";
import type { RunEventDocument } from "./event.js";
import type { ProfileDocument } from "./profile.js";
import type { RunDocument } from "./run.js";
import {
  CAPABILITY_ID_PATTERN,
  CAPABILITY_LANGUAGES,
  CAPABILITY_STATUSES,
  CAPABILITY_VERSION_REF_PATTERN,
  ContractValidationError,
  EVENT_TYPES,
  isRfc3339Timestamp,
  isUnknownRecord,
  PROFILE_ID_PATTERN,
  RUN_ID_PATTERN,
  RUN_STATUSES,
  RUN_TYPES,
  type UnknownRecord,
} from "./common.js";

function expectRecord(value: unknown, fieldPath: string): UnknownRecord {
  if (!isUnknownRecord(value)) {
    throw new ContractValidationError(fieldPath, "expected object");
  }
  return value;
}

function expectString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string") {
    throw new ContractValidationError(fieldPath, "expected string");
  }
  if (!value.trim()) {
    throw new ContractValidationError(fieldPath, "expected non-empty string");
  }
  return value;
}

function expectNullableString(value: unknown, fieldPath: string): string | null {
  if (value === null) {
    return null;
  }
  return expectString(value, fieldPath);
}

function expectBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== "boolean") {
    throw new ContractValidationError(fieldPath, "expected boolean");
  }
  return value;
}

function expectNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ContractValidationError(fieldPath, "expected number");
  }
  return value;
}

function expectNullableNumber(value: unknown, fieldPath: string): number | null {
  if (value === null) {
    return null;
  }
  return expectNumber(value, fieldPath);
}

function expectStringArray(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value)) {
    throw new ContractValidationError(fieldPath, "expected array");
  }

  return value.map((item, index) => expectString(item, `${fieldPath}[${index}]`));
}

function expectRecordOfStrings(value: unknown, fieldPath: string): Record<string, string> {
  const record = expectRecord(value, fieldPath);
  const output: Record<string, string> = {};

  for (const [key, raw] of Object.entries(record)) {
    output[key] = expectString(raw, `${fieldPath}.${key}`);
  }

  return output;
}

function expectEnumValue<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  fieldPath: string,
): T {
  const raw = expectString(value, fieldPath);
  const candidate = raw as T;
  if (!allowedValues.includes(candidate)) {
    throw new ContractValidationError(
      fieldPath,
      `expected one of: ${allowedValues.join(", ")}`,
    );
  }
  return candidate;
}

function expectTimestamp(value: unknown, fieldPath: string): string {
  const timestamp = expectString(value, fieldPath);
  if (!isRfc3339Timestamp(timestamp)) {
    throw new ContractValidationError(fieldPath, "expected RFC3339 timestamp");
  }
  return timestamp;
}

function expectPattern(value: unknown, pattern: RegExp, fieldPath: string, label: string): string {
  const candidate = expectString(value, fieldPath);
  if (!pattern.test(candidate)) {
    throw new ContractValidationError(fieldPath, `expected ${label}`);
  }
  return candidate;
}

function expectSchemaVersion(value: unknown, fieldPath: string): "1" {
  if (value !== "1") {
    throw new ContractValidationError(fieldPath, "expected schema version \"1\"");
  }
  return "1";
}

function expectRelativeFilePath(value: unknown, fieldPath: string): string {
  const candidate = expectString(value, fieldPath);
  if (isAbsolute(candidate)) {
    throw new ContractValidationError(fieldPath, "expected relative path");
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(candidate)) {
    throw new ContractValidationError(fieldPath, "path traversal segments are not allowed");
  }
  return candidate;
}

function expectIntegerRange(value: unknown, fieldPath: string, min: number, max: number): number {
  const numeric = expectNumber(value, fieldPath);
  if (!Number.isInteger(numeric)) {
    throw new ContractValidationError(fieldPath, "expected integer");
  }
  if (numeric < min || numeric > max) {
    throw new ContractValidationError(fieldPath, `expected integer in range ${min}..${max}`);
  }
  return numeric;
}

function parseCapabilityRegistryEntry(value: unknown, fieldPath: string): CapabilityRegistryEntry {
  const record = expectRecord(value, fieldPath);
  const id = expectPattern(record.id, CAPABILITY_ID_PATTERN, `${fieldPath}.id`, "capability_id format");
  const latestVersion = expectString(record.latest_version, `${fieldPath}.latest_version`);
  const status = expectEnumValue(record.status, CAPABILITY_STATUSES, `${fieldPath}.status`);
  const tags = expectStringArray(record.tags, `${fieldPath}.tags`);
  const manifestPath = expectRelativeFilePath(record.manifest_path, `${fieldPath}.manifest_path`);

  return {
    id,
    latest_version: latestVersion,
    status,
    tags,
    manifest_path: manifestPath,
  };
}

function parseRunWorkerInfo(value: unknown, fieldPath: string): RunDocument["worker"] {
  const record = expectRecord(value, fieldPath);
  const id = expectString(record.id, `${fieldPath}.id`);
  const pid = expectNullableNumber(record.pid, `${fieldPath}.pid`);

  if (pid !== null && (!Number.isInteger(pid) || pid < 0)) {
    throw new ContractValidationError(`${fieldPath}.pid`, "expected null or non-negative integer");
  }

  return { id, pid };
}

export function validateCapabilityRegistryEntry(value: unknown, fieldPath: string): CapabilityRegistryEntry {
  return parseCapabilityRegistryEntry(value, fieldPath);
}

export function parseCapabilityRegistryDocument(value: unknown): CapabilityRegistryDocument {
  const record = expectRecord(value, "registry");
  const schemaVersion = expectSchemaVersion(record.schema_version, "registry.schema_version");
  const updatedAt = expectTimestamp(record.updated_at, "registry.updated_at");

  if (!Array.isArray(record.capabilities)) {
    throw new ContractValidationError("registry.capabilities", "expected array");
  }

  const capabilities = record.capabilities.map((entry, index) =>
    parseCapabilityRegistryEntry(entry, `registry.capabilities[${index}]`),
  );

  const seen = new Set<string>();
  for (const entry of capabilities) {
    if (seen.has(entry.id)) {
      throw new ContractValidationError("registry.capabilities", `duplicate capability id: ${entry.id}`);
    }
    seen.add(entry.id);
  }

  return {
    schema_version: schemaVersion,
    updated_at: updatedAt,
    capabilities,
  };
}

export function parseCapabilityAliasRegistryDocument(value: unknown): CapabilityAliasRegistryDocument {
  const record = expectRecord(value, "aliases");
  const schemaVersion = expectSchemaVersion(record.schema_version, "aliases.schema_version");
  const updatedAt = expectTimestamp(record.updated_at, "aliases.updated_at");
  const aliases = expectRecordOfStrings(record.aliases, "aliases.aliases");

  for (const [alias, capabilityId] of Object.entries(aliases)) {
    if (!PROFILE_ID_PATTERN.test(alias)) {
      throw new ContractValidationError(`aliases.aliases.${alias}`, "invalid alias format");
    }
    if (!CAPABILITY_ID_PATTERN.test(capabilityId)) {
      throw new ContractValidationError(`aliases.aliases.${alias}`, "invalid capability id target");
    }
  }

  return {
    schema_version: schemaVersion,
    updated_at: updatedAt,
    aliases,
  };
}

export function parseCapabilityManifestDocument(value: unknown): CapabilityManifestDocument {
  const record = expectRecord(value, "manifest");

  const schemaVersion = expectSchemaVersion(record.schema_version, "manifest.schema_version");
  const id = expectPattern(record.id, CAPABILITY_ID_PATTERN, "manifest.id", "capability_id format");
  const name = expectString(record.name, "manifest.name");
  const status = expectEnumValue(record.status, CAPABILITY_STATUSES, "manifest.status");
  const version = expectString(record.version, "manifest.version");
  const language = expectEnumValue(record.language, CAPABILITY_LANGUAGES, "manifest.language");
  const entrypoint = expectRelativeFilePath(record.entrypoint, "manifest.entrypoint");
  const description = expectString(record.description, "manifest.description");
  const tags = expectStringArray(record.tags, "manifest.tags");

  const authRaw = expectRecord(record.auth, "manifest.auth");
  const auth = {
    provider: expectString(authRaw.provider, "manifest.auth.provider"),
    scopes: expectStringArray(authRaw.scopes, "manifest.auth.scopes"),
  };

  const policyRaw = expectRecord(record.policy, "manifest.policy");
  const policy = {
    network: expectBoolean(policyRaw.network, "manifest.policy.network"),
    filesystem_write: expectBoolean(policyRaw.filesystem_write, "manifest.policy.filesystem_write"),
    timeout_sec: expectIntegerRange(policyRaw.timeout_sec, "manifest.policy.timeout_sec", 1, 3600),
  };

  const interfacesRaw = expectRecord(record.interfaces, "manifest.interfaces");
  const interfaces = {
    input_schema: expectRelativeFilePath(interfacesRaw.input_schema, "manifest.interfaces.input_schema"),
    output_schema: expectRelativeFilePath(interfacesRaw.output_schema, "manifest.interfaces.output_schema"),
  };

  const qualityRaw = expectRecord(record.quality, "manifest.quality");
  const successRate = expectNumber(qualityRaw.success_rate, "manifest.quality.success_rate");
  if (successRate < 0 || successRate > 1) {
    throw new ContractValidationError("manifest.quality.success_rate", "expected number in range 0..1");
  }

  const quality = {
    success_rate: successRate,
    runs: expectIntegerRange(qualityRaw.runs, "manifest.quality.runs", 0, Number.MAX_SAFE_INTEGER),
    last_validated_at: expectTimestamp(qualityRaw.last_validated_at, "manifest.quality.last_validated_at"),
  };

  const provenanceRaw = expectRecord(record.provenance, "manifest.provenance");
  const provenance = {
    created_by: expectString(provenanceRaw.created_by, "manifest.provenance.created_by"),
    source_refs: expectStringArray(provenanceRaw.source_refs, "manifest.provenance.source_refs"),
  };

  const createdAt = expectTimestamp(record.created_at, "manifest.created_at");
  const lastUpdated = expectTimestamp(record.last_updated, "manifest.last_updated");

  return {
    schema_version: schemaVersion,
    id,
    name,
    status,
    version,
    language,
    entrypoint,
    description,
    tags,
    auth,
    policy,
    interfaces,
    quality,
    provenance,
    created_at: createdAt,
    last_updated: lastUpdated,
  };
}

export function parseProfileDocument(value: unknown): ProfileDocument {
  const record = expectRecord(value, "profile");

  const schemaVersion = expectSchemaVersion(record.schema_version, "profile.schema_version");
  const id = expectPattern(record.id, PROFILE_ID_PATTERN, "profile.id", "profile_id format");
  const name = expectString(record.name, "profile.name");
  const systemPrompt = expectString(record.system_prompt, "profile.system_prompt");
  const allowedTags = expectStringArray(record.allowed_tags, "profile.allowed_tags");

  const defaultsRaw = expectRecord(record.default_policies, "profile.default_policies");
  const defaultPolicies = {
    require_promoted_capabilities: expectBoolean(
      defaultsRaw.require_promoted_capabilities,
      "profile.default_policies.require_promoted_capabilities",
    ),
    max_parallel_workers: expectIntegerRange(
      defaultsRaw.max_parallel_workers,
      "profile.default_policies.max_parallel_workers",
      1,
      32,
    ),
  };

  const createdAt = expectTimestamp(record.created_at, "profile.created_at");
  const lastUpdated = expectTimestamp(record.last_updated, "profile.last_updated");

  return {
    schema_version: schemaVersion,
    id,
    name,
    system_prompt: systemPrompt,
    allowed_tags: allowedTags,
    default_policies: defaultPolicies,
    created_at: createdAt,
    last_updated: lastUpdated,
  };
}

export function parseRunDocument(value: unknown): RunDocument {
  const record = expectRecord(value, "run");

  const schemaVersion = expectSchemaVersion(record.schema_version, "run.schema_version");
  const runId = expectPattern(record.run_id, RUN_ID_PATTERN, "run.run_id", "run_id format");
  const runType = expectEnumValue(record.type, RUN_TYPES, "run.type");
  const runStatus = expectEnumValue(record.status, RUN_STATUSES, "run.status");
  const startedAt = expectTimestamp(record.started_at, "run.started_at");
  const endedAtRaw = record.ended_at;
  const endedAt = endedAtRaw === null ? null : expectTimestamp(endedAtRaw, "run.ended_at");
  const profile = expectNullableString(record.profile, "run.profile");
  const parentRunId = expectNullableString(record.parent_run_id, "run.parent_run_id");
  const worker = parseRunWorkerInfo(record.worker, "run.worker");
  const capabilitiesUsed = expectStringArray(record.capabilities_used, "run.capabilities_used");
  const artifacts = expectStringArray(record.artifacts, "run.artifacts");
  const error = expectNullableString(record.error, "run.error");

  if (parentRunId !== null && !RUN_ID_PATTERN.test(parentRunId)) {
    throw new ContractValidationError("run.parent_run_id", "invalid run_id format");
  }

  for (const [index, capabilityRef] of capabilitiesUsed.entries()) {
    if (!CAPABILITY_VERSION_REF_PATTERN.test(capabilityRef)) {
      throw new ContractValidationError(
        `run.capabilities_used[${index}]`,
        'must match "<capability_id>@<version>" format',
      );
    }
  }

  if ((runStatus === "completed" || runStatus === "failed" || runStatus === "aborted") && endedAt === null) {
    throw new ContractValidationError("run.ended_at", `ended_at is required when status=${runStatus}`);
  }

  return {
    schema_version: schemaVersion,
    run_id: runId,
    type: runType,
    status: runStatus,
    started_at: startedAt,
    ended_at: endedAt,
    profile,
    parent_run_id: parentRunId,
    worker,
    capabilities_used: capabilitiesUsed,
    artifacts,
    error,
  };
}

export function parseRunEventDocument(value: unknown): RunEventDocument {
  const record = expectRecord(value, "event");

  const schemaVersion = expectSchemaVersion(record.schema_version, "event.schema_version");
  const runId = expectPattern(record.run_id, RUN_ID_PATTERN, "event.run_id", "run_id format");
  const eventType = expectEnumValue(record.event_type, EVENT_TYPES, "event.event_type");
  const timestamp = expectTimestamp(record.timestamp, "event.timestamp");
  const payload = expectRecord(record.payload, "event.payload");

  return {
    schema_version: schemaVersion,
    run_id: runId,
    event_type: eventType,
    timestamp,
    payload,
  };
}
