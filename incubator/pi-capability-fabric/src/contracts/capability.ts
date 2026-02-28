import type {
  CapabilityLanguage,
  CapabilityStatus,
  TimestampedDocument,
  VersionedDocument,
} from "./common.js";

export interface CapabilityRegistryEntry {
  id: string;
  latest_version: string;
  status: CapabilityStatus;
  tags: string[];
  manifest_path: string;
}

export interface CapabilityRegistryDocument extends VersionedDocument {
  updated_at: string;
  capabilities: CapabilityRegistryEntry[];
}

export interface CapabilityAliasRegistryDocument extends VersionedDocument {
  updated_at: string;
  aliases: Record<string, string>;
}

export interface CapabilityAuthDefinition {
  provider: string;
  scopes: string[];
}

export interface CapabilityPolicy {
  network: boolean;
  filesystem_write: boolean;
  timeout_sec: number;
}

export interface CapabilityInterfaces {
  input_schema: string;
  output_schema: string;
}

export interface CapabilityQuality {
  success_rate: number;
  runs: number;
  last_validated_at: string;
}

export interface CapabilityProvenance {
  created_by: string;
  source_refs: string[];
}

export interface CapabilityManifestDocument extends VersionedDocument, TimestampedDocument {
  id: string;
  name: string;
  status: CapabilityStatus;
  version: string;
  language: CapabilityLanguage;
  entrypoint: string;
  description: string;
  tags: string[];
  auth: CapabilityAuthDefinition;
  policy: CapabilityPolicy;
  interfaces: CapabilityInterfaces;
  quality: CapabilityQuality;
  provenance: CapabilityProvenance;
}
