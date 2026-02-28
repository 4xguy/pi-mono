import type { CapabilityRegistryEntry } from "../contracts/capability.js";

export interface ResolveCapabilitiesOptions {
  tags?: string[];
  promotedOnly?: boolean;
  limit?: number;
}

export interface ResolvedCapability {
  entry: CapabilityRegistryEntry;
  score: number;
  matchedTags: string[];
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) {
    return [];
  }

  const normalized = tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0);
  return [...new Set(normalized)];
}

export function resolveCapabilities(
  entries: CapabilityRegistryEntry[],
  options: ResolveCapabilitiesOptions = {},
): ResolvedCapability[] {
  const tags = normalizeTags(options.tags);
  const promotedOnly = options.promotedOnly ?? true;
  const limit = options.limit ?? 5;

  const filtered = promotedOnly ? entries.filter((entry) => entry.status === "promoted") : entries;

  const scored = filtered
    .map<ResolvedCapability>((entry) => {
      const entryTags = entry.tags.map((tag) => tag.toLowerCase());
      const matchedTags = tags.filter((tag) => entryTags.includes(tag));
      const score = tags.length === 0 ? 0 : matchedTags.length;

      return {
        entry,
        score,
        matchedTags,
      };
    })
    .filter((resolved) => tags.length === 0 || resolved.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.entry.id.localeCompare(b.entry.id);
    });

  return scored.slice(0, Math.max(0, limit));
}
