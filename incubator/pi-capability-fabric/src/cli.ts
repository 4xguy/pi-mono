#!/usr/bin/env node

import { runFabricInit } from "./commands/fabric-init.js";
import { runFabricList } from "./commands/fabric-list.js";
import { runFabricProfiles } from "./commands/fabric-profiles.js";
import { runFabricRun } from "./commands/fabric-run.js";
import { runFabricRuns } from "./commands/fabric-runs.js";
import { runFabricShow } from "./commands/fabric-show.js";
import { CAPABILITY_STATUSES, RUN_STATUSES } from "./contracts/common.js";
import type { FabricScope } from "./storage/paths.js";

function printHelp(): void {
  console.log(`Pi Capability Fabric (incubator)

Usage:
  fabric init [--scope <project|global>]
  fabric list [--scope <project|global>] [--status <status>] [--tag <tag>] [--query <text>]
  fabric show <capability-id-or-alias> [--scope <project|global>]
  fabric run <capability-id-or-alias> --input <json> [--profile <profile-id>] [--allow-unpromoted] [--scope <project|global>]
  fabric profiles [--scope <project|global>]
  fabric runs [--scope <project|global>] [--status <status>]

Status values:
  capabilities: ${CAPABILITY_STATUSES.join(", ")}
  runs: ${RUN_STATUSES.join(", ")}
`);
}

function parseOptionalFlag(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseScope(args: string[]): FabricScope | undefined {
  const value = parseOptionalFlag(args, "--scope");
  if (!value) {
    return undefined;
  }

  if (value === "project" || value === "global") {
    return value;
  }

  throw new Error("--scope must be either 'project' or 'global'");
}

function parseCapabilityStatus(args: string[]): (typeof CAPABILITY_STATUSES)[number] | undefined {
  const value = parseOptionalFlag(args, "--status");
  if (!value) {
    return undefined;
  }

  const status = value as (typeof CAPABILITY_STATUSES)[number];
  if (!CAPABILITY_STATUSES.includes(status)) {
    throw new Error(`--status must be one of: ${CAPABILITY_STATUSES.join(", ")}`);
  }

  return status;
}

function parseRunStatus(args: string[]): (typeof RUN_STATUSES)[number] | undefined {
  const value = parseOptionalFlag(args, "--status");
  if (!value) {
    return undefined;
  }

  const status = value as (typeof RUN_STATUSES)[number];
  if (!RUN_STATUSES.includes(status)) {
    throw new Error(`--status must be one of: ${RUN_STATUSES.join(", ")}`);
  }

  return status;
}

function parseJsonInput(args: string[]): unknown {
  const raw = parseOptionalFlag(args, "--input");
  if (!raw) {
    throw new Error("run requires --input <json>");
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for --input: ${message}`);
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    const scope = parseScope(args);
    const result = await runFabricInit({ scope });
    printJson(result);
    return;
  }

  if (command === "list") {
    const scope = parseScope(args);
    const status = parseCapabilityStatus(args);
    const tag = parseOptionalFlag(args, "--tag");
    const query = parseOptionalFlag(args, "--query");

    const result = await runFabricList({ scope, status, tag, query });
    printJson(result);
    return;
  }

  if (command === "show") {
    const idOrAlias = args[1];
    if (!idOrAlias) {
      throw new Error("show requires <capability-id-or-alias>");
    }

    const scope = parseScope(args);
    const result = await runFabricShow(idOrAlias, { scope });
    printJson(result);
    return;
  }

  if (command === "run") {
    const idOrAlias = args[1];
    if (!idOrAlias) {
      throw new Error("run requires <capability-id-or-alias>");
    }

    const scope = parseScope(args);
    const input = parseJsonInput(args);
    const profile = parseOptionalFlag(args, "--profile");
    const allowUnpromoted = hasFlag(args, "--allow-unpromoted");

    const result = await runFabricRun(idOrAlias, {
      scope,
      input,
      profile,
      allowUnpromoted,
    });

    printJson(result);
    return;
  }

  if (command === "profiles") {
    const scope = parseScope(args);
    const result = await runFabricProfiles({ scope });
    printJson(result);
    return;
  }

  if (command === "runs") {
    const scope = parseScope(args);
    const status = parseRunStatus(args);
    const result = await runFabricRuns({ scope, status });
    printJson(result);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
