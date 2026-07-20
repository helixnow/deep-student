/**
 * Obsidian-style "unlinked mentions": plain-text occurrences of a note title
 * inside another note's markdown that are not already part of a wiki link,
 * an `@` note mention, or a code span/fence.
 */

import {
  markdownCodeRanges,
  parseNoteLinks,
  type MarkdownTextRange,
} from './wikilinks';

export interface UnlinkedMention {
  /** Zero-based, inclusive character offset in the source markdown. */
  start: number;
  /** Zero-based, exclusive character offset in the source markdown. */
  end: number;
  /** The matched source text with its original casing. */
  text: string;
}

export interface FindUnlinkedMentionsOptions {
  /** Stop after this many matches. Defaults to unlimited. */
  maxMentions?: number;
}

/** Titles shorter than this produce too much noise to be useful. */
export const UNLINKED_MENTION_MIN_TITLE_LENGTH = 2;

const ASCII_WORD_CHAR = /[A-Za-z0-9_]/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ASCII-word boundary check so `Calculus` never matches inside `Calculusish`,
 * while CJK titles (no ASCII word chars at the edges) still match mid-text.
 */
function isBoundaryClean(content: string, start: number, end: number): boolean {
  const first = content[start];
  const last = content[end - 1];
  const before = start > 0 ? content[start - 1] : '';
  const after = end < content.length ? content[end] : '';
  if (before && first && ASCII_WORD_CHAR.test(before) && ASCII_WORD_CHAR.test(first)) return false;
  if (after && last && ASCII_WORD_CHAR.test(after) && ASCII_WORD_CHAR.test(last)) return false;
  return true;
}

function excludedRanges(markdown: string): MarkdownTextRange[] {
  const ranges: MarkdownTextRange[] = [...markdownCodeRanges(markdown)];
  for (const link of parseNoteLinks(markdown)) {
    ranges.push({ start: link.start, end: link.end });
  }
  return ranges.sort((left, right) => left.start - right.start);
}

/**
 * Finds case-insensitive plain-text occurrences of `title` in `markdown`,
 * skipping code and every range already covered by a first-class note link.
 */
export function findUnlinkedMentions(
  markdown: string,
  title: string,
  options?: FindUnlinkedMentionsOptions,
): UnlinkedMention[] {
  const needle = title.trim();
  if (!markdown || needle.length < UNLINKED_MENTION_MIN_TITLE_LENGTH) return [];

  const maxMentions = options?.maxMentions ?? Number.POSITIVE_INFINITY;
  if (maxMentions <= 0) return [];

  const skipped = excludedRanges(markdown);
  const pattern = new RegExp(escapeRegExp(needle), 'gi');
  const mentions: UnlinkedMention[] = [];
  let rangeIndex = 0;

  for (let match = pattern.exec(markdown); match; match = pattern.exec(markdown)) {
    const start = match.index;
    const end = start + match[0].length;

    while (rangeIndex < skipped.length && skipped[rangeIndex].end <= start) {
      rangeIndex += 1;
    }
    const overlapsSkipped = rangeIndex < skipped.length
      && start < skipped[rangeIndex].end
      && end > skipped[rangeIndex].start;
    if (overlapsSkipped || !isBoundaryClean(markdown, start, end)) continue;

    mentions.push({ start, end, text: match[0] });
    if (mentions.length >= maxMentions) break;
  }

  return mentions;
}
