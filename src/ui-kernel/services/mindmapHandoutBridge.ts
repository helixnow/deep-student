/**
 * Bidirectional MindMap <-> Note Lecture Handout bridge (C7 §2.3 & §3.2).
 *
 * Pure interop module inside `src/features/notes/interop/`:
 * - Compiles any MindMap subtree (including C7 Compound Excerpt Card slots and C3
 *   semantic anchors) into structured Markdown lecture handouts while preserving
 *   all downstream `ds-anchor://v1/...` provenance capsules.
 * - Extracts validated `SemanticAnchor` provenance links and `AnchorEdgeRecord`s
 *   from handout Markdown.
 * - Parses structured handout/note Markdown and note paragraph blocks back into
 *   compound MindMap node drafts and `ExcerptDragPayload`s with block-level anchors.
 *
 * Layer boundary: imports exclusively from `@/ui-kernel/contracts/interop` (zero
 * cross-feature imports into `src/features/mindmap/*`).
 */
import {
  buildAnchorEdgeRecord,
  fnv1a64Hex,
  formatAnchorShortLocator,
  parseSemanticAnchor,
  sanitizeExcerptDragPayload,
  sanitizeSemanticAnchor,
  serializeSemanticAnchor,
  type AnchorEdgeRecord,
  type ExcerptContentKind,
  type ExcerptDragPayload,
  type NoteSemanticAnchor,
  type SemanticAnchor,
} from '@/ui-kernel/contracts/interop';

export interface HandoutNodeExcerptSlot {
  id?: string;
  excerptKind?: ExcerptContentKind;
  text?: string;
  latex?: string;
  imageDataUrl?: string;
  imageAssetId?: string;
  sourceTitle?: string;
  anchor?: SemanticAnchor;
  anchorUri?: string;
}

export interface HandoutMindMapNodeInput {
  id: string;
  text: string;
  note?: string;
  /** C7 compound card personal synthesis note */
  cardNote?: string;
  children?: readonly HandoutMindMapNodeInput[];
  /** C7 compound card multi-source excerpt slots */
  excerpts?: readonly HandoutNodeExcerptSlot[];
  /** C3 node-level semantic provenance anchors */
  anchors?: readonly SemanticAnchor[];
  /** C3 node-level verbatim source quote */
  excerptQuote?: string;
  /** C3 node-level VFS image asset ID */
  imageAssetId?: string;
  /** Inline thumbnail images */
  images?: ReadonlyArray<{ src: string; name?: string }>;
}

export interface CompileHandoutOptions {
  /** Optional source mindmap resourceId for self-backlink generation */
  mindmapId?: string;
  /** Optional source mindmap title */
  mindmapTitle?: string;
  /** Heading level for the subtree root (1..4, default 2 so handouts slot cleanly into notes) */
  baseHeadingLevel?: 1 | 2 | 3 | 4;
  /** Deepest Markdown heading level before switching to nested bullet items (2..6, default 4) */
  maxHeadingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Emit a mindmap node provenance link per section when `mindmapId` is provided */
  includeMindMapNodeBacklinks?: boolean;
}

export interface HandoutProvenanceLink {
  label: string;
  anchorUri: string;
  anchor: SemanticAnchor;
  shortLocator: string;
  /** 1-based line number in the Markdown document */
  lineNumber: number;
  /** Nearest enclosing Markdown heading text, if any */
  sectionHeading?: string;
  /** Nearest enclosing Markdown heading level (1..6), if any */
  sectionLevel?: number;
}

export interface CompiledHandoutResult {
  markdown: string;
  sectionCount: number;
  provenanceLinks: HandoutProvenanceLink[];
  anchorEdges: AnchorEdgeRecord[];
}

export interface CompoundMindMapNodeDraft {
  id: string;
  text: string;
  note?: string;
  excerpts: HandoutNodeExcerptSlot[];
  anchors: SemanticAnchor[];
  excerptQuote?: string;
  imageAssetId?: string;
  images?: Array<{ src: string; name?: string }>;
  sourceNoteAnchor?: NoteSemanticAnchor;
  children: CompoundMindMapNodeDraft[];
}

export interface ParseHandoutToMindMapOptions {
  /** Optional source note resourceId to attach block-level `NoteSemanticAnchor`s */
  noteId?: string;
  /** Optional fallback root title when Markdown has multiple top-level sections */
  noteTitle?: string;
  /** Deterministic ID prefix for drafted nodes (default: `'mm_draft'`) */
  idPrefix?: string;
}

export interface NoteBlockExcerptInput {
  noteId: string;
  noteTitle?: string;
  blockId?: string;
  heading?: string;
  text: string;
  excerptKind?: ExcerptContentKind;
  imageDataUrl?: string;
  createdAt?: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET_RE = /^(\s*)(?:[-*+]|\d+\.)\s+(.+?)\s*$/;
const CITATION_PREFIX_RE = /^(?:—|--|-)\s*/;
const IMAGE_MD_RE = /^!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)\s*$/;

function escapeMarkdownBracketLabel(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function unescapeMarkdownBracketLabel(text: string): string {
  return text.replace(/\\([[\]\\])/g, '$1');
}

/**
 * CommonMark 链接目标里的 `\` + ASCII 标点表示该标点本身。编辑器（Crepe）序列化
 * `ds-anchor://…?node=…&label=…` 时会写成 `…\&label=…`；不还原就会把 node 读成
 * `node_xxx\`，出处匹配随之失效（讲义回写变成新增重复节点）。
 */
function unescapeMarkdownLinkDestination(raw: string): string {
  return raw.replace(/\\([\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E])/g, '$1');
}

function encodeAnchorUriForMarkdown(uri: string): string {
  return uri.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function normalizeSingleLineTitle(raw: string, fallback: string): string {
  const cleaned = raw.replace(/\r\n?/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function formatProvenanceCapsuleLabel(anchor: SemanticAnchor, explicitTitle?: string): string {
  const title = (explicitTitle || anchor.label || '').trim();
  const locator = formatAnchorShortLocator(anchor);
  if (title && locator && title !== locator) {
    return `${title} \u00b7 ${locator}`;
  }
  if (title) return title;
  if (locator) return `${anchor.resourceId} \u00b7 ${locator}`;
  if (anchor.kind === 'qbank' && anchor.questionId) {
    return `${anchor.resourceId} \u00b7 ${anchor.questionId}`;
  }
  if (anchor.kind === 'mindmap' && anchor.nodeId) {
    return `${anchor.resourceId} \u00b7 #${anchor.nodeId.slice(0, 8)}`;
  }
  return anchor.resourceId;
}

/** Formats a single `[Title · Locator](ds-anchor://v1/...)` Markdown capsule. */
export function formatProvenanceCapsuleMarkdown(
  anchorInput: SemanticAnchor,
  explicitTitle?: string,
): string | null {
  const sanitized = sanitizeSemanticAnchor(anchorInput);
  if (!sanitized) return null;
  let uri: string;
  try {
    uri = serializeSemanticAnchor(sanitized);
  } catch {
    return null;
  }
  const label = escapeMarkdownBracketLabel(formatProvenanceCapsuleLabel(sanitized, explicitTitle));
  return `[${label}](${encodeAnchorUriForMarkdown(uri)})`;
}

function resolveSlotAnchor(slot: HandoutNodeExcerptSlot): {
  anchor: SemanticAnchor;
  anchorUri: string;
} | null {
  if (slot.anchor) {
    const sanitized = sanitizeSemanticAnchor(slot.anchor);
    if (sanitized) {
      try {
        return { anchor: sanitized, anchorUri: serializeSemanticAnchor(sanitized) };
      } catch {
        // Fall through to anchorUri fallback if provided.
      }
    }
  }
  if (slot.anchorUri) {
    const parsed = parseSemanticAnchor(slot.anchorUri);
    if (parsed) {
      try {
        return { anchor: parsed, anchorUri: serializeSemanticAnchor(parsed) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function resolveImageUrl(imageDataUrl?: string, imageAssetId?: string): string | undefined {
  const trimmedUrl = imageDataUrl?.trim();
  if (
    trimmedUrl &&
    (trimmedUrl.startsWith('data:image/') ||
      trimmedUrl.startsWith('vfs://') ||
      trimmedUrl.startsWith('https://') ||
      trimmedUrl.startsWith('blob:'))
  ) {
    return trimmedUrl;
  }
  const trimmedAsset = imageAssetId?.trim();
  if (trimmedAsset) {
    return trimmedAsset.startsWith('vfs://') ? trimmedAsset : `vfs://asset/${trimmedAsset}`;
  }
  return undefined;
}

function renderExcerptBlockquote(slot: HandoutNodeExcerptSlot, indent: string): string | null {
  const quoteLines: string[] = [];
  const resolvedImage = resolveImageUrl(slot.imageDataUrl, slot.imageAssetId);
  if (resolvedImage) {
    const imgAlt = escapeMarkdownBracketLabel(
      normalizeSingleLineTitle(slot.sourceTitle || slot.anchor?.label || 'Excerpt', 'Excerpt'),
    );
    quoteLines.push(`![${imgAlt}](${resolvedImage})`);
  }

  const trimmedText = (slot.text ?? '').replace(/\r\n?/g, '\n').trim();
  if (trimmedText) {
    for (const line of trimmedText.split('\n')) {
      quoteLines.push(line);
    }
  }

  const trimmedLatex = (slot.latex ?? '').replace(/\r\n?/g, '\n').trim();
  if (trimmedLatex) {
    const wrappedLatex =
      trimmedLatex.startsWith('$$') && trimmedLatex.endsWith('$$')
        ? trimmedLatex
        : `$$${trimmedLatex}$$`;
    for (const line of wrappedLatex.split('\n')) {
      quoteLines.push(line);
    }
  }

  const resolvedAnchor = resolveSlotAnchor(slot);
  if (resolvedAnchor) {
    const capsule = formatProvenanceCapsuleMarkdown(resolvedAnchor.anchor, slot.sourceTitle);
    if (capsule) {
      quoteLines.push(`\u2014 ${capsule}`);
    }
  }

  if (quoteLines.length === 0) return null;
  return quoteLines.map((line) => (line ? `${indent}> ${line}` : `${indent}>`)).join('\n');
}

function collectNormalizedExcerptsForNode(node: HandoutMindMapNodeInput): {
  slots: HandoutNodeExcerptSlot[];
  remainingAnchors: SemanticAnchor[];
} {
  const emittedAnchorUris = new Set<string>();
  const slots: HandoutNodeExcerptSlot[] = [];

  if (Array.isArray(node.excerpts)) {
    for (const slot of node.excerpts) {
      if (!slot) continue;
      const resolved = resolveSlotAnchor(slot);
      if (resolved) {
        emittedAnchorUris.add(resolved.anchorUri);
      }
      slots.push(slot);
    }
  }

  const validNodeAnchors: Array<{ anchor: SemanticAnchor; uri: string }> = [];
  if (Array.isArray(node.anchors)) {
    for (const rawAnchor of node.anchors) {
      const sanitized = sanitizeSemanticAnchor(rawAnchor);
      if (!sanitized) continue;
      try {
        const uri = serializeSemanticAnchor(sanitized);
        validNodeAnchors.push({ anchor: sanitized, uri });
      } catch {
        // Ignore invalid anchors.
      }
    }
  }

  const nodeQuote = (node.excerptQuote ?? '').trim();
  const primaryImageSrc = node.images?.[0]?.src;
  if ((nodeQuote || node.imageAssetId || primaryImageSrc) && slots.length === 0) {
    const firstAnchor = validNodeAnchors[0];
    if (firstAnchor) {
      emittedAnchorUris.add(firstAnchor.uri);
    }
    slots.push({
      excerptKind: node.imageAssetId || primaryImageSrc ? 'region-image' : 'text',
      text: nodeQuote || undefined,
      imageDataUrl: primaryImageSrc,
      imageAssetId: node.imageAssetId,
      anchor: firstAnchor?.anchor,
      anchorUri: firstAnchor?.uri,
      sourceTitle: firstAnchor?.anchor.label,
    });
  }

  const remainingAnchors: SemanticAnchor[] = [];
  for (const entry of validNodeAnchors) {
    if (!emittedAnchorUris.has(entry.uri)) {
      emittedAnchorUris.add(entry.uri);
      remainingAnchors.push(entry.anchor);
    }
  }

  return { slots, remainingAnchors };
}

/**
 * Compiles a MindMap subtree into a structured lecture handout result with
 * Markdown text, extracted provenance links, and ready-to-persist anchor edges.
 */
export function compileMindMapSubtreeToHandout(
  subtreeRoot: HandoutMindMapNodeInput,
  options: CompileHandoutOptions = {},
): CompiledHandoutResult {
  const baseHeadingLevel = Math.min(4, Math.max(1, options.baseHeadingLevel ?? 2));
  const maxHeadingLevel = Math.min(6, Math.max(baseHeadingLevel, options.maxHeadingLevel ?? 4));
  const mindmapId = options.mindmapId?.trim() || undefined;
  const mindmapTitle = options.mindmapTitle?.trim() || undefined;
  const includeBacklinks = Boolean(options.includeMindMapNodeBacklinks && mindmapId);

  const blocks: string[] = [];
  let sectionCount = 0;

  const visit = (node: HandoutMindMapNodeInput, depth: number) => {
    if (!node || typeof node !== 'object') return;
    sectionCount += 1;

    const title = normalizeSingleLineTitle(node.text ?? '', 'Untitled');
    const headingLevel = baseHeadingLevel + depth;
    const isHeading = headingLevel <= maxHeadingLevel;
    const bulletDepth = isHeading ? 0 : headingLevel - maxHeadingLevel - 1;
    const bulletIndent = isHeading ? '' : '  '.repeat(Math.max(0, bulletDepth));
    const bodyIndent = isHeading ? '' : `${bulletIndent}  `;

    let selfBacklinkCapsule: string | null = null;
    if (includeBacklinks && mindmapId && node.id) {
      selfBacklinkCapsule = formatProvenanceCapsuleMarkdown(
        {
          kind: 'mindmap',
          resourceId: mindmapId,
          nodeId: node.id,
          label: mindmapTitle,
        },
        mindmapTitle,
      );
    }

    if (isHeading) {
      blocks.push(`${'#'.repeat(headingLevel)} ${title}`);
    } else {
      blocks.push(`${bulletIndent}- **${title}**`);
    }

    const combinedNoteParts = [
      (node.cardNote ?? '').replace(/\r\n?/g, '\n').trim(),
      (node.note ?? '').replace(/\r\n?/g, '\n').trim(),
    ].filter(Boolean);
    const trimmedNote = combinedNoteParts.join('\n\n');
    if (trimmedNote) {
      const noteText = trimmedNote
        .split('\n')
        .map((line) => (line ? `${bodyIndent}${line}` : bodyIndent.trimEnd()))
        .join('\n');
      blocks.push(noteText);
    }

    const { slots, remainingAnchors } = collectNormalizedExcerptsForNode(node);
    for (const slot of slots) {
      const rendered = renderExcerptBlockquote(slot, bodyIndent);
      if (rendered) {
        blocks.push(rendered);
      }
    }

    const extraCapsules: string[] = [];
    for (const anchor of remainingAnchors) {
      const capsule = formatProvenanceCapsuleMarkdown(anchor);
      if (capsule) extraCapsules.push(capsule);
    }
    if (selfBacklinkCapsule) {
      extraCapsules.push(selfBacklinkCapsule);
    }
    if (extraCapsules.length > 0) {
      blocks.push(`${bodyIndent}> \u2014 ${extraCapsules.join(' \u00b7 ')}`);
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child, depth + 1);
      }
    }
  };

  visit(subtreeRoot, 0);

  const markdown = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  const provenanceLinks = extractProvenanceLinksFromHandout(markdown);
  const anchorEdges: AnchorEdgeRecord[] = [];

  if (mindmapId) {
    const sourceAnchor: SemanticAnchor = {
      kind: 'mindmap',
      resourceId: mindmapId,
      nodeId: subtreeRoot.id || undefined,
      label: mindmapTitle || normalizeSingleLineTitle(subtreeRoot.text ?? '', mindmapId),
    };
    for (const link of provenanceLinks) {
      if (link.anchor.kind === 'mindmap' && link.anchor.resourceId === mindmapId) {
        continue;
      }
      const edge = buildAnchorEdgeRecord({
        sourceKind: 'mindmap',
        sourceResourceId: mindmapId,
        sourceSubId: subtreeRoot.id || undefined,
        sourceAnchor,
        sourceLabel: link.sectionHeading || subtreeRoot.text,
        targetAnchor: link.anchor,
      });
      if (edge) {
        anchorEdges.push(edge);
      }
    }
  }

  return {
    markdown,
    sectionCount,
    provenanceLinks,
    anchorEdges,
  };
}

/**
 * Compiles any MindMap subtree directly into a structured Markdown lecture handout,
 * preserving all downstream `ds-anchor://v1/...` provenance capsules.
 */
export function compileMindMapSubtreeToHandoutMarkdown(
  subtreeRoot: HandoutMindMapNodeInput,
  options?: CompileHandoutOptions,
): string {
  return compileMindMapSubtreeToHandout(subtreeRoot, options).markdown;
}

interface ScannedMarkdownAnchor {
  rawMatch: string;
  label: string;
  uri: string;
  startIndex: number;
  endIndex: number;
}

function scanAnchorLinksInLine(line: string): ScannedMarkdownAnchor[] {
  const results: ScannedMarkdownAnchor[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    const openBracket = line.indexOf('[', cursor);
    if (openBracket === -1) break;
    if (openBracket > 0 && line[openBracket - 1] === '!') {
      cursor = openBracket + 1;
      continue;
    }

    let i = openBracket + 1;
    let escaped = false;
    let closeBracket = -1;
    while (i < line.length) {
      const ch = line[i];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === ']') {
        closeBracket = i;
        break;
      }
      i += 1;
    }

    if (closeBracket === -1 || line[closeBracket + 1] !== '(') {
      cursor = openBracket + 1;
      continue;
    }

    const urlStart = closeBracket + 2;
    if (!line.startsWith('ds-anchor://v1/', urlStart)) {
      cursor = closeBracket + 1;
      continue;
    }

    let depth = 1;
    let j = urlStart;
    while (j < line.length && depth > 0) {
      const ch = line[j];
      if (ch === ' ' || ch === '\t') break;
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      if (depth > 0) j += 1;
    }

    if (depth !== 0) {
      cursor = urlStart;
      continue;
    }

    const rawLabel = line.slice(openBracket + 1, closeBracket);
    const rawUri = line.slice(urlStart, j);
    results.push({
      rawMatch: line.slice(openBracket, j + 1),
      label: unescapeMarkdownBracketLabel(rawLabel).trim(),
      uri: unescapeMarkdownLinkDestination(rawUri),
      startIndex: openBracket,
      endIndex: j + 1,
    });
    cursor = j + 1;
  }

  return results;
}

/**
 * Extracts and validates all `ds-anchor://v1/...` provenance links from a
 * Markdown handout or note body, preserving section context and 1-based line numbers.
 */
export function extractProvenanceLinksFromHandout(markdown: string): HandoutProvenanceLink[] {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const links: HandoutProvenanceLink[] = [];
  let currentHeading: string | undefined;
  let currentHeadingLevel: number | undefined;
  let inCodeFence = false;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch) {
      currentHeadingLevel = headingMatch[1].length;
      currentHeading = headingMatch[2].trim();
    }

    const scanned = scanAnchorLinksInLine(rawLine);
    for (const item of scanned) {
      const parsed = parseSemanticAnchor(item.uri);
      if (!parsed) continue;
      let canonicalUri: string;
      try {
        canonicalUri = serializeSemanticAnchor(parsed);
      } catch {
        continue;
      }
      links.push({
        label: item.label || formatProvenanceCapsuleLabel(parsed),
        anchorUri: canonicalUri,
        anchor: parsed,
        shortLocator: formatAnchorShortLocator(parsed),
        lineNumber: idx + 1,
        ...(currentHeading ? { sectionHeading: currentHeading } : {}),
        ...(currentHeadingLevel ? { sectionLevel: currentHeadingLevel } : {}),
      });
    }
  }

  return links;
}

/**
 * Derives validated `AnchorEdgeRecord`s from a Note handout to all referenced
 * downstream resources (PDF pages/rects, media timestamps, qbank items, etc.).
 */
export function buildNoteHandoutAnchorEdges(
  noteId: string,
  markdown: string,
  options: { noteTitle?: string; studySpaceId?: string; now?: number } = {},
): AnchorEdgeRecord[] {
  const cleanNoteId = noteId.trim();
  if (!cleanNoteId) return [];

  const links = extractProvenanceLinksFromHandout(markdown);
  const edges: AnchorEdgeRecord[] = [];
  const seenEdgeIds = new Set<string>();

  for (const link of links) {
    const blockSubId = link.sectionHeading
      ? `hd_${fnv1a64Hex(`${cleanNoteId}:${link.sectionHeading}`).slice(0, 12)}`
      : `ln_${link.lineNumber}`;
    const sourceAnchor: NoteSemanticAnchor = {
      kind: 'note',
      resourceId: cleanNoteId,
      blockId: blockSubId,
      heading: link.sectionHeading,
      label: options.noteTitle,
    };
    const record = buildAnchorEdgeRecord(
      {
        sourceKind: 'note',
        sourceResourceId: cleanNoteId,
        sourceSubId: blockSubId,
        sourceAnchor,
        sourceLabel: link.sectionHeading || options.noteTitle || cleanNoteId,
        targetAnchor: link.anchor,
        studySpaceId: options.studySpaceId,
      },
      options.now,
    );
    if (record && !seenEdgeIds.has(record.edgeId)) {
      seenEdgeIds.add(record.edgeId);
      edges.push(record);
    }
  }

  return edges;
}

/**
 * Builds a validated `ExcerptDragPayload` with a persistent block-level
 * `NoteSemanticAnchor` so any Note paragraph/quote block can be dragged into MindMap.
 */
export function buildNoteBlockExcerptPayload(
  input: NoteBlockExcerptInput,
): ExcerptDragPayload | null {
  const cleanNoteId = input.noteId?.trim();
  const cleanText = input.text?.replace(/\r\n?/g, '\n').trim() ?? '';
  if (!cleanNoteId || (!cleanText && !input.imageDataUrl)) return null;

  const blockId =
    input.blockId?.trim() ||
    `blk_${fnv1a64Hex(`${cleanNoteId}:${input.heading ?? ''}:${cleanText}`).slice(0, 12)}`;

  const anchor: NoteSemanticAnchor = {
    kind: 'note',
    resourceId: cleanNoteId,
    blockId,
    ...(input.heading?.trim() ? { heading: input.heading.trim() } : {}),
    ...(input.noteTitle?.trim() ? { label: input.noteTitle.trim() } : {}),
  };

  return sanitizeExcerptDragPayload({
    excerptKind: input.excerptKind ?? (input.imageDataUrl ? 'region-image' : 'text'),
    text: cleanText,
    imageDataUrl: input.imageDataUrl,
    anchor,
    sourceTitle: input.noteTitle?.trim() || undefined,
    createdAt: input.createdAt,
  });
}

function stripBoldWrapper(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('**') && trimmed.endsWith('**') && trimmed.length > 4) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

function parseBlockquoteLinesIntoNode(
  quoteLines: string[],
  target: CompoundMindMapNodeDraft,
): void {
  const bodyLines: string[] = [];
  const latexBlocks: string[] = [];
  let mathLines: string[] | null = null;
  const extractedImages: Array<{ src: string; name?: string }> = [];
  const citationAnchors: Array<{ label: string; anchor: SemanticAnchor; uri: string }> = [];

  for (const raw of quoteLines) {
    const trimmed = raw.trim();
    if (mathLines) {
      if (trimmed.endsWith('$$')) {
        mathLines.push(raw.slice(0, raw.lastIndexOf('$$')));
        latexBlocks.push(mathLines.join('\n').trim());
        mathLines = null;
      } else {
        mathLines.push(raw);
      }
      continue;
    }
    if (!trimmed) {
      if (bodyLines.length > 0) {
        bodyLines.push('');
      }
      continue;
    }

    const imageMatch = IMAGE_MD_RE.exec(trimmed);
    if (imageMatch) {
      extractedImages.push({
        src: imageMatch[2],
        name: unescapeMarkdownBracketLabel(imageMatch[1]) || undefined,
      });
      continue;
    }

    if (trimmed.startsWith('$$')) {
      if (trimmed.endsWith('$$') && trimmed.length >= 4) {
        latexBlocks.push(trimmed.slice(2, -2).trim());
      } else {
        mathLines = [trimmed.slice(2)];
      }
      continue;
    }

    const scannedLinks = scanAnchorLinksInLine(trimmed);
    if (scannedLinks.length > 0 && CITATION_PREFIX_RE.test(trimmed)) {
      const previousCount = citationAnchors.length;
      for (const item of scannedLinks) {
        const parsed = parseSemanticAnchor(item.uri);
        if (!parsed) continue;
        try {
          citationAnchors.push({
            label: item.label,
            anchor: parsed,
            uri: serializeSemanticAnchor(parsed),
          });
        } catch {
          // Skip invalid anchor.
        }
      }
      if (citationAnchors.length > previousCount) continue;
    }

    bodyLines.push(raw);
  }

  if (mathLines) bodyLines.push(`$$${mathLines.join('\n')}`);
  const textBody = bodyLines.join('\n').trim();
  const latexBody = latexBlocks.filter(Boolean).join('\n\n') || undefined;
  const firstImage = extractedImages[0];

  if (extractedImages.length > 0) {
    target.images = [...(target.images ?? []), ...extractedImages];
    if (!target.imageAssetId && firstImage.src.startsWith('vfs://asset/')) {
      target.imageAssetId = firstImage.src.slice('vfs://asset/'.length);
    }
  }

  const existingUris = new Set(
    target.anchors
      .map((a) => {
        try {
          return serializeSemanticAnchor(a);
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  );

  for (const entry of citationAnchors) {
    if (!existingUris.has(entry.uri)) {
      existingUris.add(entry.uri);
      target.anchors.push(entry.anchor);
    }
  }

  if (citationAnchors.length <= 1) {
    const primary = citationAnchors[0];
    const excerptKind: ExcerptContentKind = firstImage
      ? 'region-image'
      : primary?.anchor.kind === 'media'
        ? 'transcript-cue'
        : 'text';
    if (textBody || latexBody || firstImage || primary) {
      target.excerpts.push({
        excerptKind,
        ...(textBody ? { text: textBody } : {}),
        ...(latexBody ? { latex: latexBody } : {}),
        ...(firstImage ? { imageDataUrl: firstImage.src } : {}),
        ...(primary ? { anchor: primary.anchor, anchorUri: primary.uri } : {}),
        ...(primary?.anchor.label ? { sourceTitle: primary.anchor.label } : {}),
      });
      if (textBody && !target.excerptQuote) {
        target.excerptQuote = textBody;
      }
    }
  } else {
    // Multi-capsule provenance line (`> — [A](uri1) · [B](uri2)`): attach text to first, preserve all slots.
    citationAnchors.forEach((entry, index) => {
      target.excerpts.push({
        excerptKind:
          index === 0 && firstImage
            ? 'region-image'
            : entry.anchor.kind === 'media'
              ? 'transcript-cue'
              : 'text',
        ...(index === 0 && textBody ? { text: textBody } : {}),
        ...(index === 0 && latexBody ? { latex: latexBody } : {}),
        ...(index === 0 && firstImage ? { imageDataUrl: firstImage.src } : {}),
        anchor: entry.anchor,
        anchorUri: entry.uri,
        ...(entry.anchor.label ? { sourceTitle: entry.anchor.label } : {}),
      });
    });
    if (textBody && !target.excerptQuote) {
      target.excerptQuote = textBody;
    }
  }
}

/**
 * Parses structured lecture handout / note Markdown back into a hierarchical
 * Compound MindMap node draft tree, preserving headings, nested bullets,
 * personal comprehension notes, excerpt slots, images, LaTeX, and `SemanticAnchor`s.
 */
export function parseHandoutMarkdownToMindMapDraft(
  markdown: string,
  options: ParseHandoutToMindMapOptions = {},
): CompoundMindMapNodeDraft | null {
  if (typeof markdown !== 'string' || !markdown.trim()) return null;

  const idPrefix = options.idPrefix?.trim() || 'mm_draft';
  const noteId = options.noteId?.trim() || undefined;
  const fallbackTitle = normalizeSingleLineTitle(options.noteTitle ?? '', 'Lecture Handout');

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let nextCounter = 1;

  const makeDraftNode = (
    rawTitle: string,
    headingText?: string,
    lineIndex?: number,
  ): CompoundMindMapNodeDraft => {
    const cleanTitle = normalizeSingleLineTitle(stripBoldWrapper(rawTitle), 'Untitled');
    const id = `${idPrefix}_${nextCounter}`;
    nextCounter += 1;

    let sourceNoteAnchor: NoteSemanticAnchor | undefined;
    if (noteId) {
      const blockHash = fnv1a64Hex(`${noteId}:${lineIndex ?? nextCounter}:${cleanTitle}`).slice(
        0,
        12,
      );
      sourceNoteAnchor = {
        kind: 'note',
        resourceId: noteId,
        blockId: `blk_${blockHash}`,
        ...(headingText ? { heading: headingText } : {}),
        ...(options.noteTitle?.trim() ? { label: options.noteTitle.trim() } : {}),
      };
    }

    return {
      id,
      text: cleanTitle,
      excerpts: [],
      anchors: [],
      ...(sourceNoteAnchor ? { sourceNoteAnchor } : {}),
      children: [],
    };
  };

  interface StackEntry {
    rank: number;
    node: CompoundMindMapNodeDraft;
  }

  const topNodes: CompoundMindMapNodeDraft[] = [];
  const stack: StackEntry[] = [];
  const noteBuffers = new Map<CompoundMindMapNodeDraft, string[]>();
  let currentHeadingText: string | undefined;
  let lastHeadingRank = 0;
  let inCodeFence = false;

  const pushNodeWithRank = (node: CompoundMindMapNodeDraft, rank: number) => {
    while (stack.length > 0 && stack[stack.length - 1].rank >= rank) {
      stack.pop();
    }
    if (stack.length === 0) {
      topNodes.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ rank, node });
  };

  const ensureCurrentNode = (lineIndex: number): CompoundMindMapNodeDraft => {
    if (stack.length > 0) return stack[stack.length - 1].node;
    const implicitRoot = makeDraftNode(fallbackTitle, undefined, lineIndex);
    pushNodeWithRank(implicitRoot, 1);
    return implicitRoot;
  };

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      const target = ensureCurrentNode(i);
      const buf = noteBuffers.get(target) ?? [];
      buf.push(trimmed);
      noteBuffers.set(target, buf);
      i += 1;
      continue;
    }

    if (inCodeFence) {
      const target = ensureCurrentNode(i);
      const buf = noteBuffers.get(target) ?? [];
      buf.push(rawLine);
      noteBuffers.set(target, buf);
      i += 1;
      continue;
    }

    if (!trimmed) {
      const target = stack.at(-1)?.node;
      if (target && noteBuffers.has(target)) noteBuffers.get(target)!.push('');
      i += 1;
      continue;
    }

    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const titleText = headingMatch[2].trim();
      currentHeadingText = titleText;
      lastHeadingRank = level;
      const node = makeDraftNode(titleText, currentHeadingText, i);
      pushNodeWithRank(node, level);
      i += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const candidate = lines[i].trim();
        if (!candidate.startsWith('>')) break;
        quoteLines.push(candidate.replace(/^>\s?/, ''));
        i += 1;
      }
      const target = ensureCurrentNode(i);
      parseBlockquoteLinesIntoNode(quoteLines, target);
      continue;
    }

    const bulletMatch = BULLET_RE.exec(rawLine);
    if (bulletMatch) {
      const indentSpaces = bulletMatch[1].replace(/\t/g, '  ').length;
      const indentLevel = Math.floor(indentSpaces / 2);
      const bulletBody = bulletMatch[2].trim();
      const scanned = scanAnchorLinksInLine(bulletBody);
      const rank = (lastHeadingRank > 0 ? lastHeadingRank : 6) + 1 + indentLevel;
      const cleanBulletTitle =
        scanned.length > 0
          ? bulletBody
              .replace(/\[((?:\\.|[^\]\\])*)\]\(ds-anchor:\/\/v1\/[^\s)]+\)/g, '$1')
              .trim()
          : bulletBody;
      const node = makeDraftNode(cleanBulletTitle || bulletBody, currentHeadingText, i);
      for (const link of scanned) {
        const parsed = parseSemanticAnchor(link.uri);
        if (parsed) {
          node.anchors.push(parsed);
        }
      }
      pushNodeWithRank(node, rank);
      i += 1;
      continue;
    }

    // Plain comprehension paragraph or inline provenance link on current section/bullet node.
    const target = ensureCurrentNode(i);
    const scannedInline = scanAnchorLinksInLine(trimmed);
    for (const item of scannedInline) {
      const parsed = parseSemanticAnchor(item.uri);
      if (parsed) {
        target.anchors.push(parsed);
      }
    }
    const buf = noteBuffers.get(target) ?? [];
    buf.push(trimmed);
    noteBuffers.set(target, buf);
    i += 1;
  }

  for (const [node, buf] of noteBuffers.entries()) {
    const joined = buf.join('\n').trim();
    if (joined) {
      node.note = joined;
    }
  }

  if (topNodes.length === 0) return null;
  if (topNodes.length === 1) return topNodes[0];

  return {
    id: `${idPrefix}_root`,
    text: fallbackTitle,
    excerpts: [],
    anchors: [],
    ...(noteId
      ? {
          sourceNoteAnchor: {
            kind: 'note',
            resourceId: noteId,
            blockId: `blk_${fnv1a64Hex(`${noteId}:root:${fallbackTitle}`).slice(0, 12)}`,
            ...(options.noteTitle?.trim() ? { label: options.noteTitle.trim() } : {}),
          },
        }
      : {}),
    children: topNodes,
  };
}
