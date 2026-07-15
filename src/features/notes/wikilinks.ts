/**
 * Small, UI-independent helpers for Obsidian-style wiki links.
 *
 * A target first resolves to a note ID. If no ID matches, an exact trimmed
 * title match is used. Duplicate titles resolve to the lexicographically
 * smallest note ID so every caller gets the same graph.
 */

export interface WikiLink {
  /** The complete source text, including the surrounding brackets. */
  raw: string;
  /** The trimmed note ID or note title used as the link target. */
  target: string;
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

interface TextRange {
  start: number;
  end: number;
}

interface OpenFence {
  marker: '`' | '~';
  length: number;
  start: number;
}

const WIKI_LINK_PATTERN = /\[\[([^\]\r\n]+?)\]\]/g;

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
 * Parses inline wiki links while leaving fenced Markdown code blocks alone.
 * Inline code remains eligible because it is regular prose from the parser's
 * perspective; callers that need a different policy can filter the result.
 */
export function parseWikiLinks(markdown: string): WikiLink[] {
  const links: WikiLink[] = [];
  const fencedRanges = fencedCodeRanges(markdown);
  let rangeIndex = 0;

  WIKI_LINK_PATTERN.lastIndex = 0;
  for (let match = WIKI_LINK_PATTERN.exec(markdown); match; match = WIKI_LINK_PATTERN.exec(markdown)) {
    const start = match.index;
    while (rangeIndex < fencedRanges.length && fencedRanges[rangeIndex].end <= start) {
      rangeIndex += 1;
    }
    if (
      isEscaped(markdown, start)
      || (rangeIndex < fencedRanges.length
        && start >= fencedRanges[rangeIndex].start
        && start < fencedRanges[rangeIndex].end)
    ) {
      continue;
    }

    const source = match[1];
    const separator = source.indexOf('|');
    const target = (separator === -1 ? source : source.slice(0, separator)).trim();
    if (!target) continue;

    links.push({
      raw: match[0],
      target,
      label: separator === -1 ? undefined : source.slice(separator + 1).trim(),
      start,
      end: start + match[0].length,
    });
  }

  return links;
}

/**
 * Builds a reusable resolver. IDs are matched before titles, and matching is
 * exact after trimming the user-provided target and stored title.
 */
export function createWikiLinkIndex(notes: Iterable<WikiLinkNoteReference>): WikiLinkIndex {
  const notesById = new Map<string, WikiLinkNoteReference>();
  for (const note of notes) {
    if (!note || typeof note.id !== 'string' || typeof note.title !== 'string' || !note.id) continue;
    notesById.set(note.id, note);
  }

  const titleToIds = new Map<string, string[]>();
  for (const id of Array.from(notesById.keys()).sort(compareIds)) {
    const title = notesById.get(id)?.title.trim();
    if (!title) continue;
    const ids = titleToIds.get(title) ?? [];
    ids.push(id);
    titleToIds.set(title, ids);
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

      const candidateIds = titleToIds.get(normalizedTarget) ?? [];
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
  return parseWikiLinks(markdown).map((link) => ({
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
    for (const link of parseWikiLinks(note.content)) {
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
