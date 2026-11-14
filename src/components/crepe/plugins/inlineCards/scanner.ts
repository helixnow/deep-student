/**
 * RemNote-style inline flashcard grammar & ProseMirror / Markdown block scanner.
 *
 * Pure module without DOM or feature-layer dependencies so both the Milkdown
 * decoration plugin (`ui` layer) and the notes sync pipeline (`feature` layer)
 * share one exact grammar and deterministic FNV-1a 64-bit ID derivation.
 */
import type { Node as ProseNode } from '@milkdown/prose/model';
import { buildProjectedCardId } from '@/shared/flashcard-projection';
import {
  fnv1a64Hex,
  serializeSemanticAnchor,
  type NoteSemanticAnchor,
} from '@/ui-kernel/contracts/interop';

export type InlineCardKind = 'qa' | 'cloze';

export interface ParsedInlineCard {
  /** Deterministic card ID scoped to (noteId, blockId): `card_inline_${fnv1a64Hex(`${noteId}:${blockId}`)}` */
  cardId: string;
  /** Deterministic hash of card semantics: `fnv1a64Hex(`${kind}\0${front}\0${back}\0${clozeText}`)` */
  contentHash: string;
  kind: InlineCardKind;
  noteId: string;
  blockId: string;
  /** QA question or Cloze masked preview */
  front: string;
  /** QA answer or Cloze revealed context */
  back: string;
  /** Anki Cloze raw text (`{{c1::...}}`) when kind === 'cloze', undefined when kind === 'qa' */
  clozeText?: string;
  /** Number of distinct cloze deletions (1 for QA, 1..N for Cloze) */
  cardCount: number;
  /** Canonical ds-anchor://v1/note/<noteId>?block=<blockId> */
  sourceAnchor: NoteSemanticAnchor;
  sourceAnchorUri: string;
}

export interface InlineCardDocMatch {
  card: ParsedInlineCard;
  /** Decoration widget position at the end of the textblock (`blockPos + blockNode.nodeSize - 1`) */
  widgetPos: number;
  /** Stable decoration key */
  key: string;
  kind: InlineCardKind;
  cardCount: number;
}

export interface CompileInlineCardsOptions {
  noteId: string;
  noteTitle?: string;
}

export const MAX_INLINE_CLOZES = 12;
const MAX_FRONT_CHARS = 200;
const MAX_BACK_CHARS = 2000;
const MIN_CLOZE_BLOCK_CHARS = 4;

/** Block node types excluded from inline card compilation. */
const SKIPPED_NODE_TYPES = new Set([
  'code_block',
  'codeBlock',
  'fence',
  'html',
  'hr',
  'horizontal_rule',
  'blockquote',
  'math_block',
  'math_display',
  'image',
  'image-block',
  'imageBlock',
]);

const codePointLength = (value: string): number => Array.from(value).length;

// ============================================================================
// Protected spans: inline code, LaTeX math, URLs, HTML tags/comments, escapes
// ============================================================================

function findInlineMathClose(text: string, from: number): number {
  if (from >= text.length) return -1;
  const startsWithSpace = /\s/.test(text[from]);
  let hasLatexSyntax = false;
  for (let j = from; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '\n') return -1;
    if (ch === '\\') {
      hasLatexSyntax = true;
      j += 1;
      continue;
    }
    if (ch === '^' || ch === '_' || ch === '{' || ch === '}') {
      hasLatexSyntax = true;
    }
    if (ch === '$') {
      if (j === from) return -1;
      const endsWithSpace = /\s/.test(text[j - 1]);
      if ((startsWithSpace || endsWithSpace) && !hasLatexSyntax) return -1;
      return j;
    }
  }
  return -1;
}

const URL_AT = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>]+/y;
const HTML_TAG_AT = /<\/?[A-Za-z][^<>\n]*>/y;

/**
 * Returns a byte mask aligned with `text` where `1` marks protected characters
 * (escaped chars, inline code, `$...$` / `$$...$$` math, HTML comments/tags, URLs)
 * that must never trigger top-level `>>` or `{{...}}` delimiters.
 */
export function computeProtectedMask(text: string): Uint8Array {
  const n = text.length;
  const mask = new Uint8Array(n);
  const mark = (from: number, to: number) => {
    const clampedTo = Math.min(to, n);
    for (let k = from; k < clampedTo; k += 1) mask[k] = 1;
  };
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\') {
      mark(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run += 1;
      const fence = '`'.repeat(run);
      let close = text.indexOf(fence, i + run);
      while (close >= 0 && text[close + run] === '`') {
        close = text.indexOf(fence, close + run + 1);
      }
      const end = close >= 0 ? close + run : i + run;
      mark(i, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      if (text[i + 1] === '$') {
        const close = text.indexOf('$$', i + 2);
        const end = close >= 0 ? close + 2 : n;
        mark(i, end);
        i = end;
        continue;
      }
      const close = findInlineMathClose(text, i + 1);
      if (close > 0) {
        mark(i, close + 1);
        i = close + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '<') {
      if (text.startsWith('<!--', i)) {
        const close = text.indexOf('-->', i + 4);
        const end = close >= 0 ? close + 3 : n;
        mark(i, end);
        i = end;
        continue;
      }
      HTML_TAG_AT.lastIndex = i;
      const tag = HTML_TAG_AT.exec(text);
      if (tag) {
        mark(i, i + tag[0].length);
        i += tag[0].length;
        continue;
      }
    }
    if (/[A-Za-z]/.test(ch) && (i === 0 || !/[A-Za-z0-9+.-]/.test(text[i - 1]))) {
      URL_AT.lastIndex = i;
      const url = URL_AT.exec(text);
      if (url) {
        mark(i, i + url[0].length);
        i += url[0].length;
        continue;
      }
    }
    i += 1;
  }
  return mask;
}

// ============================================================================
// Cloze & QA extraction
// ============================================================================

interface ClozeSpan {
  start: number;
  end: number;
  content: string;
  hint?: string;
  explicitOrdinal?: number;
}

const EXPLICIT_CLOZE = /^c(\d+)::([\s\S]+?)(?:::([\s\S]+))?$/;

function findClozeSpans(text: string, mask: Uint8Array): ClozeSpan[] {
  const spans: ClozeSpan[] = [];
  const n = text.length;
  let i = 0;
  while (i < n - 1) {
    if (mask[i] || mask[i + 1] || text[i] !== '{' || text[i + 1] !== '{') {
      i += 1;
      continue;
    }
    let close = -1;
    for (let j = i + 2; j < n - 1; j += 1) {
      if (text[j] === '\n') break;
      if (mask[j]) continue;
      if (text[j] === '{' && text[j + 1] === '{' && !mask[j + 1]) break;
      if (text[j] === '}' && text[j + 1] === '}' && !mask[j + 1]) {
        close = j;
        break;
      }
      // Reject unescaped standalone braces outside protected math/code spans.
      if (text[j] === '{' || text[j] === '}') {
        close = -1;
        break;
      }
    }
    if (close < 0) {
      i += 2;
      continue;
    }
    const inner = text.slice(i + 2, close);
    const explicit = EXPLICIT_CLOZE.exec(inner);
    if (explicit) {
      const ordinal = Number(explicit[1]);
      const content = explicit[2].trim();
      if (content && Number.isSafeInteger(ordinal) && ordinal >= 1) {
        const hint = explicit[3]?.trim();
        spans.push({
          start: i,
          end: close + 2,
          content,
          explicitOrdinal: ordinal,
          ...(hint ? { hint } : {}),
        });
      }
    } else if (inner.trim()) {
      spans.push({ start: i, end: close + 2, content: inner.trim() });
    }
    i = close + 2;
  }
  return spans;
}

function findQaSplit(text: string, mask: Uint8Array, spans: readonly ClozeSpan[]): number {
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] !== '>' || text[i + 1] !== '>' || mask[i] || mask[i + 1]) continue;
    if (text[i - 1] === '>' || text[i + 2] === '>') continue;
    if (spans.some((span) => i >= span.start && i < span.end)) continue;
    return i;
  }
  return -1;
}

function renderRange(
  text: string,
  from: number,
  to: number,
  spans: readonly ClozeSpan[],
  render: (span: ClozeSpan, index: number) => string,
): string {
  let out = '';
  let cursor = from;
  spans.forEach((span, index) => {
    if (span.start < from || span.end > to) return;
    out += text.slice(cursor, span.start) + render(span, index);
    cursor = span.end;
  });
  return out + text.slice(cursor, to);
}

function assignOrdinals(spans: readonly ClozeSpan[]): number[] {
  const used = new Set<number>();
  spans.forEach((span) => {
    if (span.explicitOrdinal !== undefined) used.add(span.explicitOrdinal);
  });
  let next = 1;
  return spans.map((span) => {
    if (span.explicitOrdinal !== undefined) return span.explicitOrdinal;
    while (used.has(next)) next += 1;
    used.add(next);
    return next;
  });
}

export interface CompiledUnitContent {
  kind: InlineCardKind;
  front: string;
  back: string;
  clozeText?: string;
  cardCount: number;
}

/** Compiles a single text unit (paragraph / heading / list item), or returns `null`. */
export function compileInlineCardText(raw: string): CompiledUnitContent | null {
  const text = raw.trim();
  if (!text) return null;
  // Exclude leading Markdown blockquote lines (e.g. "> quote")
  if (text.startsWith('>') && text[1] !== '>') return null;

  const mask = computeProtectedMask(text);
  const allSpans = findClozeSpans(text, mask);
  const split = findQaSplit(text, mask, allSpans);

  if (split >= 0) {
    const plain = (span: ClozeSpan) => span.content;
    const front = renderRange(text, 0, split, allSpans, plain).trim();
    const back = renderRange(text, split + 2, text.length, allSpans, plain).trim();
    const frontLen = codePointLength(front);
    const backLen = codePointLength(back);
    if (frontLen < 1 || frontLen > MAX_FRONT_CHARS || backLen < 1 || backLen > MAX_BACK_CHARS) {
      return null;
    }
    return { kind: 'qa', front, back, cardCount: 1 };
  }

  if (allSpans.length === 0 || codePointLength(text) < MIN_CLOZE_BLOCK_CHARS) return null;
  const spans = allSpans.slice(0, MAX_INLINE_CLOZES);
  const overflow = allSpans.slice(MAX_INLINE_CLOZES);
  const ordinals = assignOrdinals(spans);
  const all = [...spans, ...overflow];
  const isKept = (index: number) => index < spans.length;

  const clozeText = renderRange(text, 0, text.length, all, (span, index) => (
    isKept(index)
      ? `{{c${ordinals[index]}::${span.content}${span.hint ? `::${span.hint}` : ''}}}`
      : span.content
  ));
  const front = renderRange(text, 0, text.length, all, (span, index) => (
    isKept(index) ? `[${span.hint ?? '...'}]` : span.content
  ));
  const back = renderRange(text, 0, text.length, all, (span) => span.content);
  if (codePointLength(back) > MAX_BACK_CHARS) return null;
  return { kind: 'cloze', front, back, clozeText, cardCount: new Set(ordinals).size };
}

// ============================================================================
// Card assembly
// ============================================================================

interface CardUnit {
  text: string;
  blockId: string | null;
  nested: boolean;
}

function contentKeyOf(content: CompiledUnitContent): string {
  return content.kind === 'qa' ? `qa:${content.front}` : `cloze:${content.clozeText ?? ''}`;
}

function buildCard(unit: CardUnit, noteId: string): ParsedInlineCard | null {
  const content = compileInlineCardText(unit.text);
  if (!content) return null;
  const contentKey = contentKeyOf(content);
  const blockId = unit.blockId ?? `auto_${fnv1a64Hex(contentKey).slice(0, 12)}`;
  const idScope = unit.blockId
    ? (unit.nested ? `${noteId}:${unit.blockId}:${contentKey}` : `${noteId}:${unit.blockId}`)
    : `${noteId}:auto:${contentKey}`;
  const sourceAnchor: NoteSemanticAnchor = {
    kind: 'note',
    resourceId: noteId,
    ...(unit.blockId ? { blockId: unit.blockId } : {}),
  };
  let sourceAnchorUri: string;
  try {
    sourceAnchorUri = serializeSemanticAnchor(sourceAnchor);
  } catch {
    return null;
  }
  return {
    cardId: buildProjectedCardId('note_inline', idScope),
    contentHash: fnv1a64Hex(
      `${content.kind}\0${content.front}\0${content.back}\0${content.clozeText ?? ''}`,
    ),
    kind: content.kind,
    noteId,
    blockId,
    front: content.front,
    back: content.back,
    ...(content.clozeText !== undefined ? { clozeText: content.clozeText } : {}),
    cardCount: content.cardCount,
    sourceAnchor,
    sourceAnchorUri,
  };
}

// ============================================================================
// ProseMirror document entry
// ============================================================================

function backtickFence(value: string): string {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return '`'.repeat(longest + 1);
}

/** Converts a ProseMirror textblock to scan text while preserving inline code & math protection. */
export function textblockToScanText(node: ProseNode): string {
  let out = '';
  node.forEach((child) => {
    if (child.isText) {
      const text = child.text ?? '';
      if (child.marks.some((mark) => mark.type.name === 'inlineCode' || mark.type.name === 'code')) {
        const fence = backtickFence(text);
        const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
        out += `${fence}${pad}${text}${pad}${fence}`;
      } else {
        out += text;
      }
      return;
    }
    const name = child.type.name;
    if (name === 'math_inline' || name === 'inlineMath') {
      const val = String(child.attrs.value ?? '').replace(/\r?\n/g, ' ').trim();
      out += val ? `$${val}$` : '$0$';
    } else if (name === 'hardbreak' || name === 'hard_break') {
      out += '\n';
    } else {
      out += ' ';
    }
  });
  return out;
}

function readBlockId(node: ProseNode): string | null {
  const id = (node.attrs as Record<string, unknown> | undefined)?.dsBlockId;
  return typeof id === 'string' && id ? id : null;
}

export function compileInlineCardsFromDoc(
  doc: ProseNode,
  options: CompileInlineCardsOptions,
): InlineCardDocMatch[] {
  const noteId = options.noteId?.trim();
  if (!noteId) return [];
  const matches: InlineCardDocMatch[] = [];
  const push = (unit: CardUnit, node: ProseNode, pos: number) => {
    const card = buildCard(unit, noteId);
    if (!card) return;
    matches.push({
      card,
      widgetPos: pos + node.nodeSize - 1,
      key: `${card.cardId}:${card.kind}:${card.cardCount}`,
      kind: card.kind,
      cardCount: card.cardCount,
    });
  };

  doc.forEach((block, offset) => {
    if (SKIPPED_NODE_TYPES.has(block.type.name)) return;
    const blockId = readBlockId(block);
    if (block.isTextblock) {
      if (block.type.spec.code) return;
      push({ text: textblockToScanText(block), blockId, nested: false }, block, offset);
      return;
    }
    block.descendants((child, childPos) => {
      if (SKIPPED_NODE_TYPES.has(child.type.name) || child.type.spec.code) return false;
      if (!child.isTextblock) return true;
      push({ text: textblockToScanText(child), blockId, nested: true }, child, offset + 1 + childPos);
      return false;
    });
  });
  return matches;
}

// ============================================================================
// Markdown fallback entry
// ============================================================================

const BLOCK_MARKER_LINE = /^\s*<!--\s*ds:block-id=([A-Za-z0-9][A-Za-z0-9_-]{0,127})\s*-->\s*$/;
const INLINE_BLOCK_MARKER_RE = /\s*<!--\s*ds:block-id=([A-Za-z0-9][A-Za-z0-9_-]{0,127})\s*-->\s*/g;
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST_ITEM_LINE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const HR_LINE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

function stripInlineBlockMarker(rawText: string): { cleanedText: string; inlineId: string | null } {
  let extractedId: string | null = null;
  const cleanedText = rawText
    .replace(INLINE_BLOCK_MARKER_RE, (_full, id: string) => {
      if (!extractedId && id) extractedId = id;
      return ' ';
    })
    .trim();
  return { cleanedText, inlineId: extractedId };
}

export function compileInlineCardsFromMarkdown(
  markdown: string,
  options: CompileInlineCardsOptions,
): ParsedInlineCard[] {
  const noteId = options.noteId?.trim();
  if (!noteId || !markdown) return [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const units: CardUnit[] = [];

  let pendingId: string | null = null;
  let fence: string | null = null;
  let inDisplayMath = false;
  let inHtmlComment = false;
  let paragraph: { lines: string[]; blockId: string | null } | null = null;
  let list: { blockId: string | null; current: string[] | null } | null = null;
  let skippingBlock = false;

  const flushParagraph = () => {
    if (paragraph) {
      const { cleanedText, inlineId } = stripInlineBlockMarker(paragraph.lines.join('\n'));
      if (cleanedText) {
        units.push({
          text: cleanedText,
          blockId: paragraph.blockId ?? inlineId,
          nested: false,
        });
      }
    }
    paragraph = null;
  };
  const flushListItem = () => {
    if (list?.current) {
      const { cleanedText, inlineId } = stripInlineBlockMarker(list.current.join('\n'));
      if (cleanedText) {
        units.push({
          text: cleanedText,
          blockId: list.blockId ?? inlineId,
          nested: true,
        });
      }
    }
    if (list) list.current = null;
  };
  const closeList = () => {
    flushListItem();
    list = null;
  };
  const takeId = () => {
    const id = pendingId;
    pendingId = null;
    return id;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (fence) {
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (inDisplayMath) {
      if (line.trim().endsWith('$$')) inDisplayMath = false;
      continue;
    }
    if (inHtmlComment) {
      if (line.includes('-->')) inHtmlComment = false;
      continue;
    }

    const marker = BLOCK_MARKER_LINE.exec(line);
    if (marker) {
      flushParagraph();
      closeList();
      skippingBlock = false;
      pendingId = marker[1];
      continue;
    }

    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith('<!--')) {
      flushParagraph();
      closeList();
      takeId();
      if (!trimmedStart.includes('-->')) {
        inHtmlComment = true;
      }
      continue;
    }

    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch) {
      flushParagraph();
      closeList();
      takeId();
      fence = fenceMatch[1][0].repeat(3);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      if (list) {
        flushListItem();
        const nextNonBlank = lines.slice(index + 1).find((next) => next.trim());
        if (!nextNonBlank || !LIST_ITEM_LINE.test(nextNonBlank)) closeList();
      }
      skippingBlock = false;
      continue;
    }

    if (skippingBlock) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith('$$')) {
      flushParagraph();
      closeList();
      takeId();
      if (!(trimmed.length > 2 && trimmed.endsWith('$$') && trimmed !== '$$')) {
        inDisplayMath = true;
      }
      continue;
    }
    if (/^\s{0,3}>/.test(line) || HR_LINE.test(line) || /^\s{0,3}</.test(line) || /^\s*\|/.test(line)) {
      flushParagraph();
      closeList();
      takeId();
      skippingBlock = true;
      continue;
    }

    const item = LIST_ITEM_LINE.exec(line);
    if (item) {
      flushParagraph();
      if (!list) list = { blockId: takeId(), current: null };
      flushListItem();
      list.current = [item[2]];
      continue;
    }
    if (list) {
      if (/^\s+/.test(line) && list.current) {
        list.current.push(trimmed);
        continue;
      }
      closeList();
    }

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      flushParagraph();
      const { cleanedText, inlineId } = stripInlineBlockMarker(heading[1]);
      if (cleanedText) {
        units.push({ text: cleanedText, blockId: takeId() ?? inlineId, nested: false });
      } else {
        takeId();
      }
      continue;
    }

    if (!paragraph) paragraph = { lines: [], blockId: takeId() };
    paragraph.lines.push(trimmed);
  }
  flushParagraph();
  closeList();

  return units
    .map((unit) => buildCard(unit, noteId))
    .filter((card): card is ParsedInlineCard => card !== null);
}
