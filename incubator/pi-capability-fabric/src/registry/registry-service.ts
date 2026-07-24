import { join } from "node:path";
import type {
  CapabilityManifestDocument,
  CapabilityRegistryEntry,
} from "../contracts/capability.ts";
import type { ProfileDocument } from "../contracts/profile.ts";
import type { RunDocument } from "../contracts/run.ts";
import { parseCapabilityManifestDocument } from "../contracts/validators.ts";
import { CapabilityRegistryRepository } from "../repositories/capability-registry-repo.ts";
import { ProfileRepository } from "../repositories/profile-repo.ts";
import { RunRepository } from "../repositories/run-repo.ts";
import { fileExists, readTextFile } from "../storage/files.ts";
import { type FabricPaths, getFabricPaths } from "../storage/paths.ts";
import { decodeYaml } from "../storage/yaml.ts";
import { type ResolveCapabilitiesOptions, resolveCapabilities } from "./resolver.ts";

export interface ListCapabilitiesOptions {
  status?: CapabilityRegistryEntry["status"];
  tag?: string;
  query?: string;
}

export interface CapabilityWithManifest {
  entry: CapabilityRegistryEntry;
  manifest: CapabilityManifestDocument;
}

export class RegistryService {
  readonly capabilityRegistry: CapabilityRegistryRepository;
  readonly profiles: ProfileRepository;
  readonly runs: RunRepository;

  constructor(readonly paths: FabricPaths = getFabricPaths()) {
    this.capabilityRegistry = new CapabilityRegistryRepository(paths);
    this.profiles = new ProfileRepository(paths);
    this.runs = new RunRepository(paths);
  }

  async listCapabilities(options: ListCapabilitiesOptions = {}): Promise<CapabilityRegistryEntry[]> {
    const entries = await this.capabilityRegistry.listCapabilityEntries();

    return entries.filter((entry) => {
      if (options.status && entry.status !== options.status) {
        return false;
      }

      if (options.tag && !entry.tags.includes(options.tag)) {
        return false;
      }

      if (options.query) {
        const query = options.query.toLowerCase();
        const inId = entry.id.toLowerCase().includes(query);
        const inTags = entry.tags.some((tag) => tag.toLowerCase().includes(query));
        if (!inId && !inTags) {
          return false;
        }
      }

      return true;
    });
  }

  async resolveCapabilityId(idOrAlias: string): Promise<string | undefined> {
    const direct = await this.capabilityRegistry.getCapabilityEntry(idOrAlias);
    if (direct) {
      return direct.id;
    }

    return this.capabilityRegistry.resolveAlias(idOrAlias);
  }

  async loadCapabilityManifest(entry: CapabilityRegistryEntry): Promise<CapabilityManifestDocument> {
    const manifestPath = join(this.paths.root, entry.manifest_path);
    if (!(await fileExists(manifestPath))) {
      throw new Error(`Capability manifest not found: ${manifestPath}`);
    }

    const raw = await readTextFile(manifestPath);
    return parseCapabilityManifestDocument(decodeYaml(raw));
  }

  async getCapability(idOrAlias: string): Promise<CapabilityWithManifest | undefined> {
    const resolvedId = await this.resolveCapabilityId(idOrAlias);
    if (!resolvedId) {
      return undefined;
    }

    const entry = await this.capabilityRegistry.getCapabilityEntry(resolvedId);
    if (!entry) {
      return undefined;
    }

    const manifest = await this.loadCapabilityManifest(entry);
    return { entry, manifest };
  }

  async listProfiles(): Promise<ProfileDocument[]> {
    return this.profiles.listProfiles();
  }

  async listRuns(): Promise<RunDocument[]> {
    return this.runs.listRuns();
  }

  async resolveByTags(options: ResolveCapabilitiesOptions = {}): Promise<CapabilityRegistryEntry[]> {
    const entries = await this.capabilityRegistry.listCapabilityEntries();
    return resolveCapabilities(entries, options).map((resolved) => resolved.entry);
  }
}
