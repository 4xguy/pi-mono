import type { TimestampedDocument, VersionedDocument } from "./common.js";

export interface ProfilePolicyDefaults {
  require_promoted_capabilities: boolean;
  max_parallel_workers: number;
}

export interface ProfileDocument extends VersionedDocument, TimestampedDocument {
  id: string;
  name: string;
  system_prompt: string;
  allowed_tags: string[];
  default_policies: ProfilePolicyDefaults;
}
