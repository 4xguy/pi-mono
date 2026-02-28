import type { RunStatus, RunType, VersionedDocument } from "./common.js";

export interface RunWorkerInfo {
  id: string;
  pid: number | null;
}

export interface RunDocument extends VersionedDocument {
  run_id: string;
  type: RunType;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  profile: string | null;
  parent_run_id: string | null;
  worker: RunWorkerInfo;
  capabilities_used: string[];
  artifacts: string[];
  error: string | null;
}
