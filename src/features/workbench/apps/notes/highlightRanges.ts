export interface HighlightRange {
  start: number;
  end: number;
}

/** Escape characters that are special inside a RegExp character class / pattern. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: HighlightRange[] = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

/**
 * Compute case-insensitive highlight ranges for every query token.
 * Multi-word queries highlight each token independently; overlapping hits are merged.
 * Matching uses literal substring search (CJK-safe); regex metacharacters are escaped
 * when a RegExp is built, so they never become operators.
 */
export function highlightRanges(text: string, query: string): HighlightRange[] {
  if (!text || !query.trim()) return [];

  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const ranges: HighlightRange[] = [];
  for (const token of tokens) {
    // Build a case-insensitive literal matcher (metacharacters escaped).
    const pattern = new RegExp(escapeRegExp(token), 'gi');
    let match = pattern.exec(text);
    while (match) {
      const start = match.index;
      const end = start + match[0].length;
      if (end > start) ranges.push({ start, end });
      // Avoid zero-length infinite loops on empty matches.
      if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
      match = pattern.exec(text);
    }
  }

  return mergeRanges(ranges);
}
