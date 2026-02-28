import type { EventType, VersionedDocument } from "./common.js";

export interface RunEventDocument extends VersionedDocument {
  run_id: string;
  event_type: EventType;
  timestamp: string;
  payload: Record<string, unknown>;
}
