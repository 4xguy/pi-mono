import { join } from "node:path";
import type {
  CapabilityAliasRegistryDocument,
  CapabilityRegistryDocument,
  CapabilityRegistryEntry,
} from "../contracts/capability.js";
import { CAPABILITY_ID_PATTERN, PROFILE_ID_PATTERN, nowIsoTimestamp } from "../contracts/common.js";
import {
  parseCapabilityAliasRegistryDocument,
  parseCapabilityRegistryDocument,
  validateCapabilityRegistryEntry,
} from "../contracts/validators.js";
import { fileExists, readTextFile, writeTextFileAtomic } from "../storage/files.js";
import { type FabricPaths, getFabricPaths } from "../storage/paths.js";
import { decodeYaml, encodeYaml } from "../storage/yaml.js";

function createEmptyCapabilityRegistry(now: string): CapabilityRegistryDocument {
  return {
    schema_version: "1",
    updated_at: now,
    capabilities: [],
  };
}

function createEmptyAliasRegistry(now: string): CapabilityAliasRegistryDocument {
  return {
    schema_version: "1",
    updated_at: now,
    aliases: {},
  };
}

export class CapabilityRegistryRepository {
  private readonly capabilitiesPath: string;
  private readonly aliasesPath: string;

  constructor(private readonly paths: FabricPaths = getFabricPaths()) {
    this.capabilitiesPath = join(this.paths.registryDir, "capabilities.yaml");
    this.aliasesPath = join(this.paths.registryDir, "aliases.yaml");
  }

  async loadCapabilityRegistry(): Promise<CapabilityRegistryDocument> {
    if (!(await fileExists(this.capabilitiesPath))) {
      return createEmptyCapabilityRegistry(nowIsoTimestamp());
    }

    const raw = await readTextFile(this.capabilitiesPath);
    return parseCapabilityRegistryDocument(decodeYaml(raw));
  }

  async saveCapabilityRegistry(document: CapabilityRegistryDocument): Promise<void> {
    const validated = parseCapabilityRegistryDocument(document);
    await writeTextFileAtomic(this.capabilitiesPath, encodeYaml(validated));
  }

  async listCapabilityEntries(): Promise<CapabilityRegistryEntry[]> {
    const registry = await this.loadCapabilityRegistry();
    return [...registry.capabilities].sort((a, b) => a.id.localeCompare(b.id));
  }

  async getCapabilityEntry(capabilityId: string): Promise<CapabilityRegistryEntry | undefined> {
    const entries = await this.listCapabilityEntries();
    return entries.find((entry) => entry.id === capabilityId);
  }

  async upsertCapabilityEntry(entry: CapabilityRegistryEntry): Promise<CapabilityRegistryDocument> {
    const validatedEntry = validateCapabilityRegistryEntry(entry, "entry");
    const registry = await this.loadCapabilityRegistry();

    const existingIndex = registry.capabilities.findIndex((item) => item.id === validatedEntry.id);
    if (existingIndex === -1) {
      registry.capabilities.push(validatedEntry);
    } else {
      registry.capabilities[existingIndex] = validatedEntry;
    }

    registry.capabilities.sort((a, b) => a.id.localeCompare(b.id));
    registry.updated_at = nowIsoTimestamp();

    await this.saveCapabilityRegistry(registry);
    return registry;
  }

  async removeCapabilityEntry(capabilityId: string): Promise<CapabilityRegistryDocument> {
    const registry = await this.loadCapabilityRegistry();
    registry.capabilities = registry.capabilities.filter((entry) => entry.id !== capabilityId);
    registry.updated_at = nowIsoTimestamp();

    await this.saveCapabilityRegistry(registry);
    return registry;
  }

  async loadAliasRegistry(): Promise<CapabilityAliasRegistryDocument> {
    if (!(await fileExists(this.aliasesPath))) {
      return createEmptyAliasRegistry(nowIsoTimestamp());
    }

    const raw = await readTextFile(this.aliasesPath);
    return parseCapabilityAliasRegistryDocument(decodeYaml(raw));
  }

  async saveAliasRegistry(document: CapabilityAliasRegistryDocument): Promise<void> {
    const validated = parseCapabilityAliasRegistryDocument(document);
    await writeTextFileAtomic(this.aliasesPath, encodeYaml(validated));
  }

  async setAlias(alias: string, capabilityId: string): Promise<CapabilityAliasRegistryDocument> {
    if (!PROFILE_ID_PATTERN.test(alias)) {
      throw new Error(`Invalid alias format: ${alias}`);
    }
    if (!CAPABILITY_ID_PATTERN.test(capabilityId)) {
      throw new Error(`Invalid capability id format: ${capabilityId}`);
    }

    const aliases = await this.loadAliasRegistry();
    aliases.aliases[alias] = capabilityId;
    aliases.updated_at = nowIsoTimestamp();

    await this.saveAliasRegistry(aliases);
    return aliases;
  }

  async removeAlias(alias: string): Promise<CapabilityAliasRegistryDocument> {
    const aliases = await this.loadAliasRegistry();
    delete aliases.aliases[alias];
    aliases.updated_at = nowIsoTimestamp();

    await this.saveAliasRegistry(aliases);
    return aliases;
  }

  async resolveAlias(alias: string): Promise<string | undefined> {
    const aliases = await this.loadAliasRegistry();
    return aliases.aliases[alias];
  }
}
