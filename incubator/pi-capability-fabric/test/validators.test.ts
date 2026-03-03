import { describe, expect, it } from "vitest";
import { ContractValidationError } from "../src/contracts/common.js";
import {
  parseCapabilityManifestDocument,
  parseCapabilityRegistryDocument,
  parseCapabilityValidationReportDocument,
  parseRunDocument,
  parseRunEventDocument,
} from "../src/contracts/validators.js";

describe("contracts validators", () => {
  it("parses a valid capability manifest", () => {
    const manifest = parseCapabilityManifestDocument({
      schema_version: "1",
      id: "google.calendar.events",
      name: "Google Calendar Events",
      status: "promoted",
      version: "0.1.0",
      language: "typescript",
      entrypoint: "capabilities/google.calendar.events/index.ts",
      description: "List events",
      tags: ["google", "calendar"],
      auth: {
        provider: "google-oauth",
        scopes: ["calendar.readonly"],
      },
      policy: {
        network: true,
        filesystem_write: false,
        timeout_sec: 90,
      },
      interfaces: {
        input_schema: "capabilities/google.calendar.events/input.schema.json",
        output_schema: "capabilities/google.calendar.events/output.schema.json",
      },
      quality: {
        success_rate: 0.95,
        runs: 25,
        last_validated_at: "2026-02-27T15:00:00.000Z",
      },
      provenance: {
        created_by: "foundry",
        source_refs: ["docs/google-calendar-api"],
      },
      created_at: "2026-02-27T14:00:00.000Z",
      last_updated: "2026-02-27T15:00:00.000Z",
    });

    expect(manifest.id).toBe("google.calendar.events");
    expect(manifest.status).toBe("promoted");
  });

  it("rejects duplicate capability ids in registry", () => {
    expect(() =>
      parseCapabilityRegistryDocument({
        schema_version: "1",
        updated_at: "2026-02-27T15:00:00.000Z",
        capabilities: [
          {
            id: "google.calendar.events",
            latest_version: "0.1.0",
            status: "promoted",
            tags: ["google"],
            manifest_path: "capabilities/google.calendar.events/manifest.yaml",
          },
          {
            id: "google.calendar.events",
            latest_version: "0.1.1",
            status: "promoted",
            tags: ["google", "calendar"],
            manifest_path: "capabilities/google.calendar.events/manifest.yaml",
          },
        ],
      }),
    ).toThrowError(ContractValidationError);
  });

  it("requires ended_at for terminal run statuses", () => {
    expect(() =>
      parseRunDocument({
        schema_version: "1",
        run_id: "run_20260227_150000_001",
        type: "runtime",
        status: "failed",
        started_at: "2026-02-27T15:00:00.000Z",
        ended_at: null,
        profile: "default",
        parent_run_id: null,
        worker: {
          id: "worker-1",
          pid: 1234,
        },
        capabilities_used: ["google.calendar.events@0.1.0"],
        artifacts: [],
        error: "boom",
      }),
    ).toThrowError(ContractValidationError);
  });

  it("rejects absolute file paths in manifest", () => {
    expect(() =>
      parseCapabilityManifestDocument({
        schema_version: "1",
        id: "google.calendar.events",
        name: "Google Calendar Events",
        status: "promoted",
        version: "0.1.0",
        language: "typescript",
        entrypoint: "/etc/passwd",
        description: "List events",
        tags: ["google"],
        auth: {
          provider: "google-oauth",
          scopes: ["calendar.readonly"],
        },
        policy: {
          network: true,
          filesystem_write: false,
          timeout_sec: 90,
        },
        interfaces: {
          input_schema: "capabilities/google.calendar.events/input.schema.json",
          output_schema: "capabilities/google.calendar.events/output.schema.json",
        },
        quality: {
          success_rate: 0.95,
          runs: 25,
          last_validated_at: "2026-02-27T15:00:00.000Z",
        },
        provenance: {
          created_by: "foundry",
          source_refs: ["docs/google-calendar-api"],
        },
        created_at: "2026-02-27T14:00:00.000Z",
        last_updated: "2026-02-27T15:00:00.000Z",
      }),
    ).toThrowError(ContractValidationError);
  });

  it("rejects run capability refs without version", () => {
    expect(() =>
      parseRunDocument({
        schema_version: "1",
        run_id: "run_20260227_150000_001",
        type: "runtime",
        status: "running",
        started_at: "2026-02-27T15:00:00.000Z",
        ended_at: null,
        profile: "default",
        parent_run_id: null,
        worker: {
          id: "worker-1",
          pid: 1234,
        },
        capabilities_used: ["google.calendar.events"],
        artifacts: [],
        error: null,
      }),
    ).toThrowError(ContractValidationError);
  });

  it("parses a valid validation report", () => {
    const report = parseCapabilityValidationReportDocument({
      schema_version: "1",
      capability_id: "google.calendar.events",
      version: "v0001",
      validated_at: "2026-02-27T15:00:00.000Z",
      checks: {
        syntax: true,
        smoke: true,
        contract: true,
        policy: true,
      },
      result: "pass",
      runtime_run_id: "run_20260227_150000_001",
    });

    expect(report.result).toBe("pass");
  });

  it("parses valid run events", () => {
    const event = parseRunEventDocument({
      schema_version: "1",
      run_id: "run_20260227_150000_001",
      event_type: "run_started",
      timestamp: "2026-02-27T15:00:01.000Z",
      payload: {
        message: "started",
      },
    });

    expect(event.event_type).toBe("run_started");
  });
});
