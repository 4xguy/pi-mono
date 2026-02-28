import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileDocument } from "../contracts/profile.js";
import { nowIsoTimestamp } from "../contracts/common.js";
import { parseProfileDocument } from "../contracts/validators.js";
import { fileExists, readTextFile, writeTextFileAtomic } from "../storage/files.js";
import { type FabricPaths, getFabricPaths } from "../storage/paths.js";
import { decodeYaml, encodeYaml } from "../storage/yaml.js";

export class ProfileRepository {
  constructor(private readonly paths: FabricPaths = getFabricPaths()) {}

  private getProfilePath(profileId: string): string {
    return join(this.paths.profilesDir, `${profileId}.yaml`);
  }

  async listProfileIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.paths.profilesDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
        .map((entry) => entry.name.replace(/\.yaml$/, ""))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  async listProfiles(): Promise<ProfileDocument[]> {
    const ids = await this.listProfileIds();
    const profiles: ProfileDocument[] = [];

    for (const id of ids) {
      const profile = await this.loadProfile(id);
      if (profile) {
        profiles.push(profile);
      }
    }

    return profiles;
  }

  async loadProfile(profileId: string): Promise<ProfileDocument | undefined> {
    const path = this.getProfilePath(profileId);
    if (!(await fileExists(path))) {
      return undefined;
    }

    const raw = await readTextFile(path);
    return parseProfileDocument(decodeYaml(raw));
  }

  async saveProfile(document: ProfileDocument): Promise<ProfileDocument> {
    const validated = parseProfileDocument(document);
    const path = this.getProfilePath(validated.id);

    const existing = await this.loadProfile(validated.id);
    const now = nowIsoTimestamp();

    const normalized: ProfileDocument = {
      ...validated,
      created_at: existing?.created_at ?? validated.created_at,
      last_updated: now,
    };

    await writeTextFileAtomic(path, encodeYaml(normalized));
    return normalized;
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    const path = this.getProfilePath(profileId);
    if (!(await fileExists(path))) {
      return false;
    }

    await unlink(path);
    return true;
  }
}
