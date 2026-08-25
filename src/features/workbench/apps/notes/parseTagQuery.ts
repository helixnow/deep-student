export interface ParsedTagQuery {
  /** Remaining free-text after `tag:` tokens are removed. */
  textQuery: string;
  /** Deduplicated tag names in first-seen order (original casing preserved). */
  tags: string[];
}

export interface ParsedPropFilter {
  /** Property key as typed (matching is case-insensitive). */
  key: string;
  /** Required value; quoted values may contain spaces. */
  value: string;
}

export interface ParsedSearchQuery extends ParsedTagQuery {
  /** `path:` tokens — every one must substring-match the resource path. */
  paths: string[];
  /**
   * Generic `key:value` tokens (anything other than tag/path). Reserved for
   * note custom properties: every pair must match `metadata.props[key]`.
   */
  props: ParsedPropFilter[];
}

/**
 * 统一搜索操作符解析：`tag:x`、`path:folder`、任意 `key:value`（属性预留）。
 * - 值支持引号包裹（可含空格）：`tag:"multi word"`、`status:"in progress"`
 * - URL 防误伤：`http://…` 这类"值以 / 开头"的裸 token 不当作操作符
 *  （path:/folder 是合法的，仅对未知 key 生效该守卫）
 */
export function parseSearchOperators(query: string): ParsedSearchQuery {
  const tags: string[] = [];
  const paths: string[] = [];
  const props: ParsedPropFilter[] = [];
  const seenTags = new Set<string>();
  const seenPaths = new Set<string>();
  const seenProps = new Set<string>();

  const textQuery = query
    .replace(
      /(^|\s)([\p{L}\p{N}_][\p{L}\p{N}_-]*):("([^"]*)"|([^\s]+))/gu,
      (full, lead: string, rawKey: string, _group: string, quoted?: string, bare?: string) => {
        const value = (quoted ?? bare ?? '').trim();
        const key = rawKey.toLocaleLowerCase();
        if (!value) return lead ? ' ' : '';
        if (key === 'tag') {
          const dedupe = value.toLocaleLowerCase();
          if (!seenTags.has(dedupe)) {
            seenTags.add(dedupe);
            tags.push(value);
          }
          return lead ? ' ' : '';
        }
        if (key === 'path') {
          const dedupe = value.toLocaleLowerCase();
          if (!seenPaths.has(dedupe)) {
            seenPaths.add(dedupe);
            paths.push(value);
          }
          return lead ? ' ' : '';
        }
        // 未知 key 且值以 / 开头：多半是 URL（http://…），保留为普通文本
        if (quoted === undefined && value.startsWith('/')) return full;
        const dedupe = `${key}\u0000${value.toLocaleLowerCase()}`;
        if (!seenProps.has(dedupe)) {
          seenProps.add(dedupe);
          props.push({ key: rawKey, value });
        }
        return lead ? ' ' : '';
      },
    )
    .replace(/\s+/g, ' ')
    .trim();

  return { textQuery, tags, paths, props };
}

/** Remove one `key:value` operator token (case-insensitive) from a query string. */
export function removeOperatorFromQuery(query: string, key: string, value: string): string {
  const escape = (raw: string) => raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return query
    .replace(
      new RegExp(`(^|\\s)${escape(key)}:(?:"${escape(value)}"|${escape(value)})(?=\\s|$)`, 'gi'),
      '$1',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Intersection: every `path:` token must substring-match the haystack (case-insensitive). */
export function pathMatchesFilters(pathHaystack: string, requiredPaths: readonly string[]): boolean {
  if (requiredPaths.length === 0) return true;
  const haystack = pathHaystack.toLocaleLowerCase();
  return requiredPaths.every((path) => haystack.includes(path.trim().toLocaleLowerCase()));
}

/** Read the custom `props` object from node metadata when present. */
export function getNodeProps(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const raw = metadata?.props;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/**
 * Intersection: every `key:value` pair must match a custom property
 * (key case-insensitive; value matches by case-insensitive containment).
 */
export function nodeMatchesProps(
  metadata: Record<string, unknown> | undefined,
  requiredProps: readonly ParsedPropFilter[],
): boolean {
  if (requiredProps.length === 0) return true;
  const props = getNodeProps(metadata);
  const byKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(props)) {
    byKey.set(key.trim().toLocaleLowerCase(), value);
  }
  return requiredProps.every(({ key, value }) => {
    const actual = byKey.get(key.trim().toLocaleLowerCase());
    if (actual === undefined || actual === null) return false;
    return String(actual).toLocaleLowerCase().includes(value.trim().toLocaleLowerCase());
  });
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
