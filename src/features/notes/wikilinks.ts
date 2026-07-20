/**
 * Small, UI-independent helpers for Obsidian-style wiki links.
 *
 * A target first resolves to a note ID (exact, case-sensitive — autocomplete
 * writes IDs verbatim). If no ID matches, a trimmed, case-insensitive title
 * match is used so `[[calculus]]` still resolves to the note titled
 * "Calculus" while the original casing is preserved for display. Titles that
 * collide case-insensitively resolve to the lexicographically smallest note
 * ID so every caller gets the same graph.
 */

export interface WikiLink {
  /** The complete source text, including the surrounding brackets. */
  raw: string;
  /** The trimmed note ID or note title used as the link target. */
  target: string;
  /** Optional in-note heading from a `Note#Heading` destination. */
  heading?: string;
  /** The optional, trimmed display label after the first `|`. */
  label: string | undefined;
  /** Zero-based, inclusive character offset in the source markdown. */
  start: number;
  /** Zero-based, exclusive character offset in the source markdown. */
  end: number;
}

export interface WikiLinkNoteReference {
  id: string;
  title: string;
}

export interface WikiLinkNoteContent extends WikiLinkNoteReference {
  content: string;
}

/** A note ID to title/content map, suitable for building a link graph. */
export type WikiLinkNoteContentMap =
  | ReadonlyMap<string, Omit<WikiLinkNoteContent, 'id'>>
  | Readonly<Record<string, Omit<WikiLinkNoteContent, 'id'>>>;

export type WikiLinkMatchKind = 'id' | 'title' | null;

export interface WikiLinkTargetResolution {
  target: string;
  noteId: string | null;
  matchedBy: WikiLinkMatchKind;
  /** True when several note titles matched and the stable first ID was used. */
  ambiguous: boolean;
  /** All matching IDs in deterministic order. */
  candidateIds: readonly string[];
}

export interface ResolvedWikiLink extends WikiLink {
  resolution: WikiLinkTargetResolution;
}

export interface WikiLinkRelationship {
  sourceId: string;
  targetId: string;
  link: WikiLink;
  resolution: WikiLinkTargetResolution;
}

export interface UnresolvedWikiLink {
  sourceId: string;
  link: WikiLink;
  resolution: WikiLinkTargetResolution;
}

export interface WikiLinkRelationships {
  /** Each supplied note ID is present, even when it has no outbound links. */
  outboundByNoteId: Readonly<Record<string, readonly WikiLinkRelationship[]>>;
  /** Each supplied note ID is present, even when nothing links to it. */
  inboundByNoteId: Readonly<Record<string, readonly WikiLinkRelationship[]>>;
  unresolved: readonly UnresolvedWikiLink[];
}

export interface WikiLinkIndex {
  resolve(target: string): WikiLinkTargetResolution;
}

export interface MarkdownTextRange {
  start: number;
  end: number;
}

type TextRange = MarkdownTextRange;

interface OpenFence {
  marker: '`' | '~';
  length: number;
  start: number;
}

const WIKI_LINK_PATTERN = /\[\[([^\]\r\n]+?)\]\]/g;
/**
 * `[label](note://id?query#heading)`：id 不吃 `?` / `#`，heading 捕获进第 3 组，
 * 供 `WikiLink.heading` 使用（B10：此前 hash 被并入 id，导致解析失败且丢失 heading）。
 */
const NOTE_MENTION_PATTERN = /\[([^\]\r\n]+)\]\(note:\/\/([^\s)?#]+)(?:\?[^\s)#]*)?(?:#([^\s)]*))?\)/g;

const compareIds = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

function openingFence(line: string): Pick<OpenFence, 'marker' | 'length'> | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return {
    marker: match[1][0] as '`' | '~',
    length: match[1].length,
  };
}

function closesFence(line: string, fence: OpenFence): boolean {
  const markerPattern = fence.marker === '`' ? '`+' : '~+';
  const match = new RegExp(`^ {0,3}(${markerPattern})[ \\t]*$`).exec(line);
  return Boolean(match && match[1].length >= fence.length);
}

function fencedCodeRanges(markdown: string): TextRange[] {
  const ranges: TextRange[] = [];
  let openFence: OpenFence | null = null;
  let offset = 0;

  while (offset < markdown.length) {
    const newline = markdown.indexOf('\n', offset);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const nextOffset = newline === -1 ? markdown.length : newline + 1;
    const line = markdown.slice(offset, lineEnd).replace(/\r$/, '');

    if (openFence) {
      if (closesFence(line, openFence)) {
        ranges.push({ start: openFence.start, end: nextOffset });
        openFence = null;
      }
    } else {
      const opener = openingFence(line);
      if (opener) {
        openFence = { ...opener, start: offset };
      }
    }

    offset = nextOffset;
  }

  if (openFence) {
    ranges.push({ start: openFence.start, end: markdown.length });
  }

  return ranges;
}

function isEscaped(markdown: string, start: number): boolean {
  let slashCount = 0;
  for (let cursor = start - 1; cursor >= 0 && markdown[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

/**
 * Inline code spans (`` `...` ``) that appear outside fenced code blocks.
 * Follows the CommonMark pairing rule: a run of N backticks opens a span and
 * the next run of exactly N backticks closes it; unmatched runs stay literal.
 */
function inlineCodeRanges(markdown: string, fencedRanges: TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  let fenceIndex = 0;
  let cursor = 0;

  while (cursor < markdown.length) {
    while (fenceIndex < fencedRanges.length && fencedRanges[fenceIndex].end <= cursor) {
      fenceIndex += 1;
    }
    if (
      fenceIndex < fencedRanges.length
      && cursor >= fencedRanges[fenceIndex].start
      && cursor < fencedRanges[fenceIndex].end
    ) {
      cursor = fencedRanges[fenceIndex].end;
      continue;
    }

    if (markdown[cursor] !== '`' || isEscaped(markdown, cursor)) {
      cursor += 1;
      continue;
    }

    let openerEnd = cursor;
    while (openerEnd < markdown.length && markdown[openerEnd] === '`') openerEnd += 1;
    const runLength = openerEnd - cursor;

    // A code span never crosses into a fenced block or across a blank line
    // (CommonMark)；避免游离反引号把后续大段文本误判为 code。
    const fenceLimit = fenceIndex < fencedRanges.length
      ? fencedRanges[fenceIndex].start
      : markdown.length;
    const blankOffset = markdown.slice(openerEnd, fenceLimit).search(/\n[ \t]*\r?\n/);
    const searchLimit = blankOffset >= 0 ? openerEnd + blankOffset : fenceLimit;
    let probe = openerEnd;
    let closerEnd = -1;
    while (probe < searchLimit) {
      if (markdown[probe] !== '`') {
        probe += 1;
        continue;
      }
      let runEnd = probe;
      while (runEnd < searchLimit && markdown[runEnd] === '`') runEnd += 1;
      if (runEnd - probe === runLength) {
        closerEnd = runEnd;
        break;
      }
      probe = runEnd;
    }

    if (closerEnd >= 0) {
      ranges.push({ start: cursor, end: closerEnd });
      cursor = closerEnd;
    } else {
      cursor = openerEnd;
    }
  }

  return ranges;
}

/** Fenced blocks plus inline code spans, sorted; links inside never parse. */
export function markdownCodeRanges(markdown: string): MarkdownTextRange[] {
  const fencedRanges = fencedCodeRanges(markdown);
  return [...fencedRanges, ...inlineCodeRanges(markdown, fencedRanges)]
    .sort((left, right) => left.start - right.start);
}

const codeRanges = markdownCodeRanges;

/**
 * Parses inline wiki links while leaving Markdown code alone: both fenced
 * blocks and inline code spans are skipped, matching the editor's remark
 * layer (which only visits plain text nodes) and Obsidian behaviour.
 */
export function parseWikiLinks(markdown: string): WikiLink[] {
  const links: WikiLink[] = [];
  const skippedRanges = codeRanges(markdown);
  let rangeIndex = 0;

  WIKI_LINK_PATTERN.lastIndex = 0;
  for (let match = WIKI_LINK_PATTERN.exec(markdown); match; match = WIKI_LINK_PATTERN.exec(markdown)) {
    const start = match.index;
    while (rangeIndex < skippedRanges.length && skippedRanges[rangeIndex].end <= start) {
      rangeIndex += 1;
    }
    if (
      isEscaped(markdown, start)
      || (rangeIndex < skippedRanges.length
        && start >= skippedRanges[rangeIndex].start
        && start < skippedRanges[rangeIndex].end)
    ) {
      continue;
    }

    const source = match[1];
    const separator = source.indexOf('|');
    const destination = (separator === -1 ? source : source.slice(0, separator)).trim();
    const headingSeparator = destination.indexOf('#');
    const target = (headingSeparator < 0 ? destination : destination.slice(0, headingSeparator)).trim();
    const heading = headingSeparator < 0 ? '' : destination.slice(headingSeparator + 1).trim();
    if (!target) continue;

    links.push({
      raw: match[0],
      target,
      ...(heading ? { heading } : {}),
      label: separator === -1 ? undefined : source.slice(separator + 1).trim(),
      start,
      end: start + match[0].length,
    });
  }

  return links;
}

/**
 * Parse the Markdown representation produced by the `@` note mention menu.
 * Returning the same shape as wiki links keeps backlinks and snippets on one
 * product-level link index even though the editor uses a regular link mark.
 */
export function parseNoteMentions(markdown: string): WikiLink[] {
  const links: WikiLink[] = [];
  const skippedRanges = codeRanges(markdown);
  let rangeIndex = 0;

  NOTE_MENTION_PATTERN.lastIndex = 0;
  for (let match = NOTE_MENTION_PATTERN.exec(markdown); match; match = NOTE_MENTION_PATTERN.exec(markdown)) {
    const start = match.index;
    while (rangeIndex < skippedRanges.length && skippedRanges[rangeIndex].end <= start) rangeIndex += 1;
    if (
      isEscaped(markdown, start)
      || (rangeIndex < skippedRanges.length
        && start >= skippedRanges[rangeIndex].start
        && start < skippedRanges[rangeIndex].end)
    ) continue;

    const target = match[2]?.trim();
    if (!target) continue;
    const heading = decodeMentionHeading(match[3]);
    links.push({
      raw: match[0],
      target,
      ...(heading ? { heading } : {}),
      label: match[1]?.trim() || undefined,
      start,
      end: start + match[0].length,
    });
  }
  return links;
}

/** URL fragments may arrive percent-encoded; fall back to the raw text. */
function decodeMentionHeading(fragment: string | undefined): string {
  const trimmed = fragment?.trim() ?? '';
  if (!trimmed) return '';
  try {
    return decodeURIComponent(trimmed).trim();
  } catch {
    return trimmed;
  }
}

/** All first-class note references, ordered by their source position. */
export function parseNoteLinks(markdown: string): WikiLink[] {
  return [...parseWikiLinks(markdown), ...parseNoteMentions(markdown)]
    .sort((left, right) => left.start - right.start);
}

/** Shared title normalization: trim + case fold, aligned with autocomplete. */
export function normalizeWikiLinkTitle(title: string): string {
  return title.trim().toLocaleLowerCase();
}

/**
 * Builds a reusable resolver. IDs are matched before titles (exact match, so
 * autocomplete-written IDs always win), then titles are matched after
 * trimming and case folding both the user-provided target and stored title.
 */
export function createWikiLinkIndex(notes: Iterable<WikiLinkNoteReference>): WikiLinkIndex {
  const notesById = new Map<string, WikiLinkNoteReference>();
  for (const note of notes) {
    if (!note || typeof note.id !== 'string' || typeof note.title !== 'string' || !note.id) continue;
    notesById.set(note.id, note);
  }

  const titleToIds = new Map<string, string[]>();
  for (const id of Array.from(notesById.keys()).sort(compareIds)) {
    const title = notesById.get(id)?.title;
    const titleKey = title ? normalizeWikiLinkTitle(title) : '';
    if (!titleKey) continue;
    const ids = titleToIds.get(titleKey) ?? [];
    ids.push(id);
    titleToIds.set(titleKey, ids);
  }

  return {
    resolve(target: string): WikiLinkTargetResolution {
      const normalizedTarget = target.trim();
      if (!normalizedTarget) {
        return {
          target: normalizedTarget,
          noteId: null,
          matchedBy: null,
          ambiguous: false,
          candidateIds: [],
        };
      }

      if (notesById.has(normalizedTarget)) {
        return {
          target: normalizedTarget,
          noteId: normalizedTarget,
          matchedBy: 'id',
          ambiguous: false,
          candidateIds: [normalizedTarget],
        };
      }

      const candidateIds = titleToIds.get(normalizeWikiLinkTitle(normalizedTarget)) ?? [];
      return {
        target: normalizedTarget,
        noteId: candidateIds[0] ?? null,
        matchedBy: candidateIds.length > 0 ? 'title' : null,
        ambiguous: candidateIds.length > 1,
        candidateIds: candidateIds.slice(),
      };
    },
  };
}

/** Resolves every parseable wiki link in a Markdown document. */
export function resolveWikiLinks(
  markdown: string,
  notes: Iterable<WikiLinkNoteReference>
): ResolvedWikiLink[] {
  const index = createWikiLinkIndex(notes);
  return parseNoteLinks(markdown).map((link) => ({
    ...link,
    resolution: index.resolve(link.target),
  }));
}

function noteContentsFromMap(noteContents: WikiLinkNoteContentMap): WikiLinkNoteContent[] {
  const entries = noteContents instanceof Map
    ? Array.from(noteContents.entries())
    : Object.entries(noteContents);

  return entries
    .filter((entry): entry is [string, Omit<WikiLinkNoteContent, 'id'>] => {
      const [id, value] = entry;
      return Boolean(
        id
        && value
        && typeof value.title === 'string'
        && typeof value.content === 'string'
      );
    })
    .map(([id, value]) => ({ id, title: value.title, content: value.content }))
    .sort((left, right) => compareIds(left.id, right.id));
}

/**
 * Finds every outbound and inbound relationship in a supplied note-content
 * map. Repeated links are preserved so consumers can show occurrence counts.
 */
export function getWikiLinkRelationships(noteContents: WikiLinkNoteContentMap): WikiLinkRelationships {
  const notes = noteContentsFromMap(noteContents);
  const index = createWikiLinkIndex(notes);
  const outboundByNoteId: Record<string, WikiLinkRelationship[]> = Object.create(null);
  const inboundByNoteId: Record<string, WikiLinkRelationship[]> = Object.create(null);
  const unresolved: UnresolvedWikiLink[] = [];

  for (const note of notes) {
    outboundByNoteId[note.id] = [];
    inboundByNoteId[note.id] = [];
  }

  for (const note of notes) {
    for (const link of parseNoteLinks(note.content)) {
      const resolution = index.resolve(link.target);
      if (!resolution.noteId) {
        unresolved.push({ sourceId: note.id, link, resolution });
        continue;
      }

      const relationship: WikiLinkRelationship = {
        sourceId: note.id,
        targetId: resolution.noteId,
        link,
        resolution,
      };
      outboundByNoteId[note.id].push(relationship);
      inboundByNoteId[resolution.noteId].push(relationship);
    }
  }

  return { outboundByNoteId, inboundByNoteId, unresolved };
}
