import type { Block, Message } from '../core/types';

export function normalizeMessageSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

export interface MessageSearchMatch {
  messageId: string;
  /** Zero-based occurrence index within the message. */
  occurrenceIndex: number;
}

export interface MessageSearchOccurrence {
  start: number;
  end: number;
}

interface SearchSourceSegment {
  start: number;
  end: number;
  value: string;
}

function getSearchSourceSegments(text: string): SearchSourceSegment[] {
  // Grapheme segmentation keeps combining marks together, so NFKC can
  // correctly match both "e\u0301" and "é" while preserving source offsets.
  const IntlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity: 'grapheme' },
    ) => { segment: (value: string) => Iterable<{ index: number; segment: string }> };
  };
  if (IntlWithSegmenter.Segmenter) {
    const segmenter = new IntlWithSegmenter.Segmenter(undefined, { granularity: 'grapheme' });
    const segments = Array.from(segmenter.segment(text));
    return segments.map((segment, index) => ({
      start: segment.index,
      end: segments[index + 1]?.index ?? text.length,
      value: segment.segment,
    }));
  }

  const segments: SearchSourceSegment[] = [];
  for (let sourceIndex = 0; sourceIndex < text.length;) {
    const codePoint = text.codePointAt(sourceIndex);
    if (codePoint === undefined) break;
    const sourceChar = String.fromCodePoint(codePoint);
    const sourceEnd = sourceIndex + sourceChar.length;
    segments.push({ start: sourceIndex, end: sourceEnd, value: sourceChar });
    sourceIndex = sourceEnd;
  }
  return segments;
}

/**
 * Find non-overlapping occurrences in a text node and map them back to the
 * original string. The search uses the same normalization as message-level
 * matching, while the returned offsets always address the original text.
 */
export function findTextSearchOccurrences(
  text: string,
  query: string,
): MessageSearchOccurrence[] {
  const normalizedQuery = normalizeMessageSearchText(query.trim());
  if (!normalizedQuery || !text) return [];

  let normalizedText = '';
  const sourceRanges: Array<{ start: number; end: number }> = [];

  for (const segment of getSearchSourceSegments(text)) {
    const normalizedChar = normalizeMessageSearchText(segment.value);
    normalizedText += normalizedChar;
    for (let i = 0; i < normalizedChar.length; i += 1) {
      sourceRanges.push({ start: segment.start, end: segment.end });
    }
  }

  const occurrences: MessageSearchOccurrence[] = [];
  let searchStart = 0;
  while (searchStart < normalizedText.length) {
    const matchStart = normalizedText.indexOf(normalizedQuery, searchStart);
    if (matchStart < 0) break;
    const matchEnd = matchStart + normalizedQuery.length;
    const sourceStart = sourceRanges[matchStart]?.start;
    const sourceEnd = sourceRanges[matchEnd - 1]?.end;
    if (sourceStart !== undefined && sourceEnd !== undefined) {
      occurrences.push({ start: sourceStart, end: sourceEnd });
    }
    searchStart = matchEnd;
  }

  return occurrences;
}

function getMessageSearchContents(
  message: Message | undefined,
  blocks: ReadonlyMap<string, Block>,
): string[] {
  if (!message) return [];

  return message.blockIds
    .map((blockId) => blocks.get(blockId)?.content ?? '')
    .filter((content) => Boolean(content.trim()));
}

/**
 * Build the visible conversation text used by search. Runtime errors,
 * tool names, and payloads are intentionally excluded because they are not
 * consistently rendered as searchable message text.
 */
export function getMessageSearchText(
  message: Message | undefined,
  blocks: ReadonlyMap<string, Block>,
): string {
  return getMessageSearchContents(message, blocks).join('\n');
}

export function findMessageSearchMatches(
  messageOrder: readonly string[],
  messageMap: ReadonlyMap<string, Message>,
  blocks: ReadonlyMap<string, Block>,
  query: string,
): MessageSearchMatch[] {
  const normalizedQuery = normalizeMessageSearchText(query.trim());
  if (!normalizedQuery) return [];

  return messageOrder.flatMap((messageId) => {
    const message = messageMap.get(messageId);
    let occurrenceIndex = 0;
    const matches: MessageSearchMatch[] = [];

    for (const content of getMessageSearchContents(message, blocks)) {
      const occurrences = findTextSearchOccurrences(content, normalizedQuery);
      for (const _occurrence of occurrences) {
        matches.push({ messageId, occurrenceIndex });
        occurrenceIndex += 1;
      }
    }

    return matches;
  });
}
