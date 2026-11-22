/**
 * Crepe Learner Highlighter (`==text==`) Live Preview decoration plugin &
 * selection wrap/unwrap command helpers (`==...==` highlight and `{{...}}` cloze).
 *
 * Non-destructive decoration approach: keeps standard Markdown `==highlighted text==`
 * in the ProseMirror document for 100% lossless roundtrip, canonicalDocument / diff
 * compatibility, and instant Obsidian Live Preview polish (collapsing `==` delimiters
 * when the cursor/selection is strictly outside the match and revealing them subtly
 * when the cursor enters to edit).
 *
 * Strictly skips scanning/rebuilding while `view.composing === true` (CJK IME safety)
 * and refreshes cleanly after `compositionend`.
 */
import type { Node as ProseNode } from '@milkdown/prose/model';
import { keydownHandler } from '@milkdown/prose/keymap';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@milkdown/prose/state';
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from '@milkdown/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import './highlight.css';

export interface HighlightMatch {
  /** Document position of the opening `==` delimiter. */
  matchStart: number;
  /** Document position immediately after the opening `==` delimiter. */
  innerStart: number;
  /** Document position immediately before the closing `==` delimiter. */
  innerEnd: number;
  /** Document position immediately after the closing `==` delimiter. */
  matchEnd: number;
}

interface DelimitedSpan {
  matchStart: number;
  innerStart: number;
  innerEnd: number;
  matchEnd: number;
}

interface HighlightPluginMeta {
  forceRebuild?: boolean;
}

interface TextblockProjection {
  text: string;
  docStart: number[];
  docEnd: number[];
  protectedMask: Uint8Array;
}

export const highlightPluginKey = new PluginKey<DecorationSet>('crepeHighlight');

/** Block node types excluded from `==...==` highlight scanning and toggling. */
const SKIPPED_BLOCK_TYPES = new Set([
  'code_block',
  'codeBlock',
  'fence',
  'math_block',
  'math_display',
  'html',
]);

/** Inline mark names excluded from delimiter matching (inline code and links). */
const PROTECTED_MARK_NAMES = new Set(['code', 'inlineCode', 'link']);

const INLINE_ATOM_PLACEHOLDER = '\uFFFC';
const BARE_URL_RE = /https?:\/\/[^\s\uFFFC]+/g;

function isSkippedBlockNode(node: ProseNode): boolean {
  return Boolean(node.type.spec.code || SKIPPED_BLOCK_TYPES.has(node.type.name));
}

function hasProtectedMark(node: ProseNode): boolean {
  return node.marks.some((mark) => PROTECTED_MARK_NAMES.has(mark.type.name));
}

function markProtectedUrls(text: string, protectedMask: Uint8Array): void {
  BARE_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_URL_RE.exec(text)) !== null) {
    const end = match.index + match[0].length;
    for (let k = match.index; k < end; k += 1) {
      protectedMask[k] = 1;
    }
  }
}

function markProtectedRawMath(text: string, protectedMask: Uint8Array): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (protectedMask[i] || text[i] !== '$' || isEscapedAt(text, protectedMask, i)) {
      i += 1;
      continue;
    }

    // Raw double-dollar math `$$...$$`
    if (i + 1 < n && !protectedMask[i + 1] && text[i + 1] === '$') {
      let close = -1;
      for (let j = i + 2; j < n - 1; j += 1) {
        if (text[j] === '\n') break;
        if (protectedMask[j]) continue;
        if (
          text[j] === '$' &&
          !protectedMask[j + 1] &&
          text[j + 1] === '$' &&
          !isEscapedAt(text, protectedMask, j)
        ) {
          if (j > i + 2) close = j;
          break;
        }
      }
      if (close > i + 2) {
        for (let k = i; k < close + 2; k += 1) {
          protectedMask[k] = 1;
        }
        i = close + 2;
        continue;
      }
      i += 2;
      continue;
    }

    // Raw single-dollar inline math `$...$` (Pandoc/Obsidian currency guard)
    const nextChar = text[i + 1];
    if (nextChar && nextChar !== '\n' && nextChar !== '$' && !/\s/.test(nextChar)) {
      let close = -1;
      for (let j = i + 1; j < n; j += 1) {
        if (text[j] === '\n') break;
        if (protectedMask[j]) continue;
        if (text[j] === '$' && !isEscapedAt(text, protectedMask, j)) {
          const prevChar = text[j - 1];
          const afterChar = text[j + 1] ?? '';
          if (j > i + 1 && prevChar && !/\s/.test(prevChar) && !/[$\d]/.test(afterChar)) {
            close = j;
          }
          break;
        }
      }
      if (close > i + 1) {
        for (let k = i; k <= close; k += 1) {
          protectedMask[k] = 1;
        }
        i = close + 1;
        continue;
      }
    }

    i += 1;
  }
}

/**
 * Flattens a single ProseMirror textblock into a UTF-16 string aligned with
 * exact document positions. Adjacent text nodes separated only by non-protected
 * marks (e.g. `==**bold** text==`) remain contiguous, while inline `code` /
 * `inlineCode` / `link` marks, bare URLs, raw `$...$` / `$$...$$` math fragments,
 * and non-text inline atoms are flagged in `protectedMask` so their characters
 * can never act as `==` or `{{...}}` delimiters.
 * Hard breaks map to `\n`, preventing matches across line breaks.
 */
function projectTextblock(node: ProseNode, blockPos: number): TextblockProjection {
  let text = '';
  const docStart: number[] = [];
  const docEnd: number[] = [];
  const protectedFlags: number[] = [];

  node.forEach((child, childOffset) => {
    const childDocPos = blockPos + 1 + childOffset;
    if (child.isText && child.text) {
      const isProtected = hasProtectedMark(child) ? 1 : 0;
      text += child.text;
      for (let i = 0; i < child.text.length; i += 1) {
        docStart.push(childDocPos + i);
        docEnd.push(childDocPos + i + 1);
        protectedFlags.push(isProtected);
      }
      return;
    }

    const name = child.type.name;
    if (name === 'hardbreak' || name === 'hard_break') {
      text += '\n';
    } else {
      text += INLINE_ATOM_PLACEHOLDER;
    }
    docStart.push(childDocPos);
    docEnd.push(childDocPos + child.nodeSize);
    protectedFlags.push(1);
  });

  const protectedMask = Uint8Array.from(protectedFlags);
  markProtectedUrls(text, protectedMask);
  markProtectedRawMath(text, protectedMask);

  return {
    text,
    docStart,
    docEnd,
    protectedMask,
  };
}

function isEscapedAt(text: string, protectedMask: Uint8Array, index: number): boolean {
  let backslashes = 0;
  for (let k = index - 1; k >= 0; k -= 1) {
    if (protectedMask[k] || text[k] !== '\\') break;
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Matches `==([^=\n]+?)==` spans within a single projected textblock,
 * ignoring protected inline code marks, escaped `\==`, `===` runs, and
 * whitespace-only spans.
 */
function findHighlightMatchesInProjection(projection: TextblockProjection): HighlightMatch[] {
  const { text, docStart, docEnd, protectedMask } = projection;
  const n = text.length;
  const matches: HighlightMatch[] = [];

  let i = 0;
  while (i < n - 1) {
    if (
      protectedMask[i] ||
      protectedMask[i + 1] ||
      text[i] !== '=' ||
      text[i + 1] !== '='
    ) {
      i += 1;
      continue;
    }

    if (isEscapedAt(text, protectedMask, i)) {
      i += 2;
      continue;
    }

    // Skip runs of 3+ consecutive unprotected `=` (e.g. `===` or `====`).
    if (
      (i > 0 && !protectedMask[i - 1] && text[i - 1] === '=') ||
      (i + 2 < n && !protectedMask[i + 2] && text[i + 2] === '=')
    ) {
      while (i < n && !protectedMask[i] && text[i] === '=') i += 1;
      continue;
    }

    let close = -1;
    let hasNonSpace = false;
    for (let j = i + 2; j < n; j += 1) {
      if (text[j] === '\n') break;
      if (!protectedMask[j] && text[j] === '=') {
        const nextIsUnprotectedEq =
          j + 1 < n && !protectedMask[j + 1] && text[j + 1] === '=';
        if (!nextIsUnprotectedEq) {
          // Single `=` (e.g. `==E = mc^2==` or `==a = 1==`) is normal content.
          hasNonSpace = true;
          continue;
        }
        if (
          !isEscapedAt(text, protectedMask, j) &&
          !(j + 2 < n && !protectedMask[j + 2] && text[j + 2] === '=')
        ) {
          if (j > i + 2 && hasNonSpace) {
            close = j;
          }
        }
        break;
      }
      if (!/\s/.test(text[j])) {
        hasNonSpace = true;
      }
    }

    if (close < 0) {
      i += 2;
      continue;
    }

    const matchStart = docStart[i];
    const innerStart = docStart[i + 2];
    const innerEnd = docEnd[close - 1];
    const matchEnd = docEnd[close + 1];

    if (
      matchStart >= 0 &&
      innerStart > matchStart &&
      innerEnd >= innerStart &&
      matchEnd > innerEnd
    ) {
      matches.push({ matchStart, innerStart, innerEnd, matchEnd });
    }
    i = close + 2;
  }

  return matches;
}

const EXPLICIT_CLOZE_PREFIX = /^c\d+::/;

/**
 * Matches RemNote / Anki-compatible `{{...}}` cloze spans within a projected
 * textblock (matching `inlineCards/scanner.ts` grammar, including explicit
 * `{{c1::text}}` and `{{c1::text::hint}}` forms).
 */
function findClozeSpansInProjection(projection: TextblockProjection): DelimitedSpan[] {
  const { text, docStart, docEnd, protectedMask } = projection;
  const n = text.length;
  const spans: DelimitedSpan[] = [];

  let i = 0;
  while (i < n - 1) {
    if (
      protectedMask[i] ||
      protectedMask[i + 1] ||
      text[i] !== '{' ||
      text[i + 1] !== '{'
    ) {
      i += 1;
      continue;
    }
    if (isEscapedAt(text, protectedMask, i)) {
      i += 2;
      continue;
    }

    let close = -1;
    for (let j = i + 2; j < n - 1; j += 1) {
      if (text[j] === '\n') break;
      if (protectedMask[j]) continue;
      if (text[j] === '{' && text[j + 1] === '{' && !protectedMask[j + 1]) break;
      if (
        text[j] === '}' &&
        text[j + 1] === '}' &&
        !protectedMask[j + 1] &&
        !isEscapedAt(text, protectedMask, j)
      ) {
        close = j;
        break;
      }
      if (text[j] === '{' || text[j] === '}') {
        close = -1;
        break;
      }
    }

    if (close < 0) {
      i += 2;
      continue;
    }

    const rawInner = text.slice(i + 2, close);
    let innerStartOffset = i + 2;
    let innerEndOffset = close;

    const explicitPrefix = EXPLICIT_CLOZE_PREFIX.exec(rawInner);
    if (explicitPrefix) {
      const contentStart = i + 2 + explicitPrefix[0].length;
      const rest = text.slice(contentStart, close);
      const hintSep = rest.indexOf('::');
      const contentEnd = hintSep >= 0 ? contentStart + hintSep : close;
      if (text.slice(contentStart, contentEnd).trim()) {
        innerStartOffset = contentStart;
        innerEndOffset = contentEnd;
      } else {
        i = close + 2;
        continue;
      }
    } else if (!rawInner.trim()) {
      i = close + 2;
      continue;
    }

    const matchStart = docStart[i];
    const innerStart = docStart[innerStartOffset];
    const innerEnd = docEnd[innerEndOffset - 1];
    const matchEnd = docEnd[close + 1];

    if (
      matchStart >= 0 &&
      innerStart > matchStart &&
      innerEnd >= innerStart &&
      matchEnd > innerEnd
    ) {
      spans.push({ matchStart, innerStart, innerEnd, matchEnd });
    }
    i = close + 2;
  }

  return spans;
}

/** Collects all `==...==` highlight matches in a ProseMirror document. */
export function findHighlightMatches(doc: ProseNode): HighlightMatch[] {
  const matches: HighlightMatch[] = [];
  doc.descendants((node, pos) => {
    if (isSkippedBlockNode(node)) return false;
    if (!node.isTextblock) return true;
    const projection = projectTextblock(node, pos);
    for (const match of findHighlightMatchesInProjection(projection)) {
      matches.push(match);
    }
    return false;
  });
  return matches;
}

/**
 * Builds ProseMirror inline decorations for all `==...==` highlights in `doc`.
 *
 * When `selection` touches `[matchStart, matchEnd]` (inclusive), delimiters
 * receive `crepe-highlight-delim crepe-highlight-delim--active` so the user
 * can edit them smoothly. When `selection` is strictly outside the span,
 * delimiters receive `crepe-highlight-delim crepe-highlight-delim--hidden`.
 */
export function buildHighlightDecorations(
  doc: ProseNode,
  selection?: { from: number; to: number },
): DecorationSet {
  const matches = findHighlightMatches(doc);
  if (matches.length === 0) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  for (const match of matches) {
    const isActive =
      Boolean(selection) &&
      selection!.from <= match.matchEnd &&
      selection!.to >= match.matchStart;
    const delimClass = isActive
      ? 'crepe-highlight-delim crepe-highlight-delim-active'
      : 'crepe-highlight-delim crepe-highlight-delim-hidden';

    decorations.push(
      Decoration.inline(match.matchStart, match.innerStart, { class: delimClass }),
      Decoration.inline(match.innerStart, match.innerEnd, { class: 'crepe-highlight-mark' }),
      Decoration.inline(match.innerEnd, match.matchEnd, { class: delimClass }),
    );
  }

  return DecorationSet.create(doc, decorations);
}

// ============================================================================
// Selection wrap / unwrap command helpers (Bubble Toolbar, Mobile Toolbar, Keymap)
// ============================================================================

function selectionOverlapsProtected(
  projection: TextblockProjection,
  from: number,
  to: number,
): boolean {
  const { docStart, docEnd, protectedMask } = projection;
  for (let k = 0; k < protectedMask.length; k += 1) {
    if (docEnd[k] <= from) continue;
    if (docStart[k] >= to) break;
    if (protectedMask[k]) return true;
  }
  return false;
}

function findEnclosingSpanInSelection(
  state: EditorState,
  findSpans: (projection: TextblockProjection) => DelimitedSpan[],
): { enclosing: DelimitedSpan | null; valid: boolean; projection: TextblockProjection | null } {
  const { selection } = state;
  if (selection.empty) return { enclosing: null, valid: false, projection: null };

  const { $from, $to, from, to } = selection;
  if (!$from.sameParent($to)) return { enclosing: null, valid: false, projection: null };
  if (!$from.parent.isTextblock || isSkippedBlockNode($from.parent)) {
    return { enclosing: null, valid: false, projection: null };
  }

  const blockPos = $from.before($from.depth);
  const projection = projectTextblock($from.parent, blockPos);
  if (selectionOverlapsProtected(projection, from, to)) {
    return { enclosing: null, valid: false, projection };
  }

  const spans = findSpans(projection);
  const enclosing =
    spans.find((span) => from >= span.matchStart && to <= span.matchEnd) ?? null;

  if (!enclosing) {
    const overlapsExisting = spans.some(
      (span) => from < span.matchEnd && to > span.matchStart,
    );
    if (overlapsExisting) {
      return { enclosing: null, valid: false, projection };
    }
  }

  return { enclosing, valid: true, projection };
}

function hasUnsafeDelimiterConflict(
  projection: TextblockProjection,
  selectedText: string,
  from: number,
  to: number,
  openDelim: string,
  closeDelim: string,
): boolean {
  if (selectedText.includes(openDelim) || selectedText.includes(closeDelim)) {
    return true;
  }

  const { text, docStart, docEnd, protectedMask } = projection;

  if (openDelim === '==' && closeDelim === '==') {
    if (selectedText.startsWith('=') || selectedText.endsWith('=')) {
      return true;
    }
    for (let k = 0; k < text.length; k += 1) {
      if (docEnd[k] === from && !protectedMask[k] && text[k] === '=') return true;
      if (docStart[k] === to && !protectedMask[k] && text[k] === '=') return true;
    }
  }

  if (openDelim === '{{' && closeDelim === '}}') {
    if (selectedText.includes('{') || selectedText.includes('}')) {
      return true;
    }
    for (let k = 0; k < text.length; k += 1) {
      if (docEnd[k] === from && !protectedMask[k] && text[k] === '{') return true;
      if (docStart[k] === to && !protectedMask[k] && text[k] === '}') return true;
    }
  }

  return false;
}

function toggleDelimitedSelection(
  view: EditorView,
  openDelim: string,
  closeDelim: string,
  findSpans: (projection: TextblockProjection) => DelimitedSpan[],
): boolean {
  if (!view || !view.editable || view.composing) return false;

  const { state } = view;
  const { selection, doc, schema } = state;
  const { enclosing, valid, projection } = findEnclosingSpanInSelection(state, findSpans);
  if (!valid || !projection) return false;

  const { from, to } = selection;

  if (enclosing) {
    const openLen = enclosing.innerStart - enclosing.matchStart;
    const tr = state.tr
      .delete(enclosing.innerEnd, enclosing.matchEnd)
      .delete(enclosing.matchStart, enclosing.innerStart);

    const clampedFrom = Math.max(from, enclosing.innerStart);
    const clampedTo = Math.min(to, enclosing.innerEnd);
    const nextFrom = Math.max(0, clampedFrom - openLen);
    const nextTo = Math.max(nextFrom, clampedTo - openLen);

    tr.setSelection(TextSelection.create(tr.doc, nextFrom, nextTo));
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  const selectedText = doc.textBetween(from, to, '\n', INLINE_ATOM_PLACEHOLDER);
  if (
    !selectedText.trim() ||
    selectedText.includes('\n') ||
    selectedText.includes(INLINE_ATOM_PLACEHOLDER)
  ) {
    return false;
  }

  if (hasUnsafeDelimiterConflict(projection, selectedText, from, to, openDelim, closeDelim)) {
    return false;
  }

  const openLen = openDelim.length;
  const tr = state.tr
    .insert(to, schema.text(closeDelim))
    .insert(from, schema.text(openDelim));

  tr.setSelection(TextSelection.create(tr.doc, from + openLen, to + openLen));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Wraps the current non-empty selection in `==...==`, or unwraps it if already
 * wrapped in `==...==` (whether the selection sits inside or includes `==`).
 * Preserves clean selection bounds and respects read-only / IME composing state.
 */
export function toggleHighlightSelection(view: EditorView): boolean {
  return toggleDelimitedSelection(view, '==', '==', findHighlightMatchesInProjection);
}

/**
 * Wraps the current non-empty selection in RemNote-style `{{...}}` cloze syntax
 * (compatible with `inlineCards/scanner.ts`), or unwraps it if already wrapped in
 * `{{...}}` (including explicit `{{c1::...}}` / `{{c1::...::hint}}` forms).
 */
export function toggleClozeSelection(view: EditorView): boolean {
  return toggleDelimitedSelection(view, '{{', '}}', findClozeSpansInProjection);
}

/** Returns `true` when the current non-empty selection lies inside a `==...==` highlight. */
export function isSelectionHighlighted(state: EditorState): boolean {
  return findEnclosingSpanInSelection(state, findHighlightMatchesInProjection).enclosing !== null;
}

/** Returns `true` when the current non-empty selection lies inside a `{{...}}` cloze span. */
export function isSelectionClozed(state: EditorState): boolean {
  return findEnclosingSpanInSelection(state, findClozeSpansInProjection).enclosing !== null;
}

// ============================================================================
// ProseMirror & Milkdown plugin factories
// ============================================================================

const runHighlightKeyCommand = (
  _state: EditorState,
  _dispatch: ((tr: Transaction) => void) | undefined,
  view?: EditorView,
): boolean => {
  if (!view) return false;
  return toggleHighlightSelection(view);
};

// Bind both lowercase and uppercase `H` with explicit `Shift-` so Mod+Shift+H
// fires reliably across browsers and synthetic KeyboardEvents without ever
// triggering when Shift is not held (e.g. CapsLock + Cmd+H).
const handleHighlightKeydown = keydownHandler({
  'Mod-Shift-h': runHighlightKeyCommand,
  'Mod-Shift-H': runHighlightKeyCommand,
});

export function createHighlightProsePlugin(): Plugin<DecorationSet> {
  let boundView: EditorView | null = null;
  let domComposing = false;
  let needsRebuildAfterComposition = false;
  let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;

  const clearCompositionEndTimer = () => {
    if (compositionEndTimer !== null) {
      clearTimeout(compositionEndTimer);
      compositionEndTimer = null;
    }
  };

  const isViewComposing = (): boolean => Boolean(domComposing || boundView?.composing);

  return new Plugin<DecorationSet>({
    key: highlightPluginKey,
    view(editorView) {
      boundView = editorView;
      return {
        destroy() {
          clearCompositionEndTimer();
          if (boundView === editorView) {
            boundView = null;
          }
          domComposing = false;
          needsRebuildAfterComposition = false;
        },
      };
    },
    state: {
      init: (_config, state) => buildHighlightDecorations(state.doc, state.selection),
      apply: (tr, oldSet, _oldState, newState) => {
        const meta = tr.getMeta(highlightPluginKey) as HighlightPluginMeta | undefined;
        if (meta?.forceRebuild) {
          if (isViewComposing()) {
            needsRebuildAfterComposition = true;
            return oldSet.map(tr.mapping, tr.doc);
          }
          needsRebuildAfterComposition = false;
          return buildHighlightDecorations(newState.doc, newState.selection);
        }

        if (!tr.docChanged && !tr.selectionSet) {
          return oldSet;
        }

        if (isViewComposing() || Boolean(tr.getMeta('composition'))) {
          if (tr.docChanged || tr.selectionSet) {
            needsRebuildAfterComposition = true;
          }
          return oldSet.map(tr.mapping, tr.doc);
        }

        if (!tr.docChanged && !needsRebuildAfterComposition && oldSet === DecorationSet.empty) {
          return oldSet;
        }

        needsRebuildAfterComposition = false;
        return buildHighlightDecorations(newState.doc, newState.selection);
      },
    },
    props: {
      decorations(state) {
        return highlightPluginKey.getState(state) ?? DecorationSet.empty;
      },
      handleKeyDown(view, event) {
        if (view.composing || isComposingKeyEvent(event)) return false;
        return handleHighlightKeydown(view, event);
      },
      handleDOMEvents: {
        compositionstart() {
          clearCompositionEndTimer();
          domComposing = true;
          return false;
        },
        compositionend(view) {
          domComposing = false;
          clearCompositionEndTimer();
          compositionEndTimer = setTimeout(() => {
            compositionEndTimer = null;
            if (view.isDestroyed || view.composing || domComposing) return;
            const tr = view.state.tr
              .setMeta(highlightPluginKey, { forceRebuild: true } satisfies HighlightPluginMeta)
              .setMeta('addToHistory', false);
            view.dispatch(tr);
          }, 25);
          return false;
        },
      },
    },
  });
}

export function highlightPlugin() {
  return $prose(() => createHighlightProsePlugin());
}
