export interface ParsedTagQuery {
  /** Remaining free-text after `tag:` tokens are removed. */
  textQuery: string;
  /** Deduplicated tag names in first-seen order (original casing preserved). */
  tags: string[];
}

/**
 * Parse `tag:xxx` / `tag:"multi word"` tokens out of a search query.
 * Intersection semantics: every listed tag must match.
 */
export function parseTagQuery(query: string): ParsedTagQuery {
  const tags: string[] = [];
  const seen = new Set<string>();

  const textQuery = query
    .replace(/(^|\s)tag:("([^"]*)"|([^\s]+))/gi, (_full, lead: string, _group: string, quoted?: string, bare?: string) => {
      const raw = (quoted ?? bare ?? '').trim();
      if (raw) {
        const key = raw.toLocaleLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          tags.push(raw);
        }
      }
      return lead ? ' ' : '';
    })
    .replace(/\s+/g, ' ')
    .trim();

  return { textQuery, tags };
}

/** Remove one `tag:` token (case-insensitive tag name) from a query string. */
export function removeTagFromQuery(query: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return query
    .replace(new RegExp(`(^|\\s)tag:(?:"${escaped}"|${escaped})(?=\\s|$)`, 'gi'), '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read `metadata.tags` from a DSTU node when present. */
export function getNodeTags(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.tags;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** Intersection: every required tag must appear on the node (case-insensitive). */
export function nodeMatchesTags(
  metadata: Record<string, unknown> | undefined,
  requiredTags: readonly string[],
): boolean {
  if (requiredTags.length === 0) return true;
  const have = new Set(getNodeTags(metadata).map((tag) => tag.trim().toLocaleLowerCase()));
  return requiredTags.every((tag) => have.has(tag.trim().toLocaleLowerCase()));
}
