/**
 * 笔记编辑器查找高亮插件
 *
 * 通过 ProseMirror Decoration 高亮所有匹配项，当前匹配项使用强调色。
 * 由 FindReplacePanel 通过 transaction meta 驱动：
 *   view.dispatch(tr.setMeta(searchHighlightKey, { query, activeIndex, caseSensitive, wholeWord }))
 *
 * 文档变更时自动重新计算匹配（支持边输入边更新计数）。
 */

import { Plugin, PluginKey, type Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { $prose } from '@milkdown/utils';

export interface SearchMatch {
  from: number;
  to: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface SearchHighlightState {
  query: string;
  activeIndex: number;
  caseSensitive: boolean;
  wholeWord: boolean;
  matches: SearchMatch[];
  decorations: DecorationSet;
}

export interface SearchHighlightMeta {
  query?: string;
  activeIndex?: number;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export const searchHighlightKey = new PluginKey<SearchHighlightState>('notesSearchHighlight');

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  // CJK 不按「单词字符」处理（无空格分词）；其余字母数字视为词内字符
  return /[\p{L}\p{N}_]/u.test(ch) && !isCjkChar(ch);
}

function isCjkChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{3400}-\u{9FFF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}]/u.test(ch);
}

function queryHasCjk(query: string): boolean {
  for (const ch of query) {
    if (isCjkChar(ch)) return true;
  }
  return false;
}

function codePointBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const trailingUnit = text.charCodeAt(index - 1);
  if (trailingUnit >= 0xDC00 && trailingUnit <= 0xDFFF && index > 1) {
    const leadingUnit = text.charCodeAt(index - 2);
    if (leadingUnit >= 0xD800 && leadingUnit <= 0xDBFF) {
      return text.slice(index - 2, index);
    }
  }
  return text[index - 1];
}

function codePointAt(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined;
  const value = text.codePointAt(index);
  return value === undefined ? undefined : String.fromCodePoint(value);
}

function isWholeWordMatch(text: string, start: number, end: number): boolean {
  const before = codePointBefore(text, start);
  const after = codePointAt(text, end);
  return !isWordChar(before) && !isWordChar(after);
}

interface FoldedText {
  text: string;
  rawStartByUnit?: number[];
  rawEndByUnit?: number[];
}

interface TextblockProjection {
  text: string;
  docStartByUnit: number[];
  docEndByUnit: number[];
  barrierPrefix: number[];
}

const INLINE_BARRIER = '\uFFFC';

/** Lowercase text while retaining a map back to the original UTF-16 offsets. */
function foldTextWithOffsets(raw: string): FoldedText {
  const text = raw.toLowerCase();
  if (text.length === raw.length) {
    return { text };
  }

  const rawStartByUnit: number[] = [];
  const rawEndByUnit: number[] = [];

  for (let rawStart = 0; rawStart < raw.length;) {
    const codePoint = raw.codePointAt(rawStart);
    if (codePoint === undefined) break;
    const originalUnit = String.fromCodePoint(codePoint);
    const rawEnd = rawStart + originalUnit.length;
    const foldedUnit = originalUnit.toLowerCase();
    for (let i = 0; i < foldedUnit.length; i++) {
      rawStartByUnit.push(rawStart);
      rawEndByUnit.push(rawEnd);
    }
    rawStart = rawEnd;
  }

  return { text, rawStartByUnit, rawEndByUnit };
}

/**
 * Flatten one textblock so adjacent text nodes separated only by marks remain
 * searchable as a single string. Non-text inline nodes are explicit barriers:
 * a match must never jump across a hard break, image, mention, or other atom.
 */
function projectTextblock(node: ProseNode, blockPos: number): TextblockProjection {
  let text = '';
  const docStartByUnit: number[] = [];
  const docEndByUnit: number[] = [];
  const barriers: number[] = [];

  node.forEach((child, childOffset) => {
    if (child.isText && child.text) {
      text += child.text;
      for (let i = 0; i < child.text.length; i += 1) {
        docStartByUnit.push(blockPos + 1 + childOffset + i);
        docEndByUnit.push(blockPos + 1 + childOffset + i + 1);
        barriers.push(0);
      }
      return;
    }

    text += INLINE_BARRIER;
    docStartByUnit.push(-1);
    docEndByUnit.push(-1);
    barriers.push(1);
  });

  const barrierPrefix = new Array<number>(barriers.length + 1).fill(0);
  for (let i = 0; i < barriers.length; i += 1) {
    barrierPrefix[i + 1] = barrierPrefix[i] + barriers[i];
  }

  return { text, docStartByUnit, docEndByUnit, barrierPrefix };
}

function collectMatchesInTextblock(
  projection: TextblockProjection,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): SearchMatch[] {
  const raw = projection.text;
  const folded = caseSensitive ? null : foldTextWithOffsets(raw);
  const text = folded?.text ?? raw;
  const q = caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  let previousRawTo = -1;
  let idx = text.indexOf(q);

  while (idx !== -1) {
    const end = idx + q.length;
    const rawStart = folded?.rawStartByUnit?.[idx] ?? idx;
    const rawEnd = folded?.rawEndByUnit?.[end - 1] ?? end;
    const crossesBarrier =
      projection.barrierPrefix[rawEnd] !== projection.barrierPrefix[rawStart];
    const accepted =
      rawStart >= previousRawTo &&
      !crossesBarrier &&
      (!wholeWord || isWholeWordMatch(raw, rawStart, rawEnd));

    if (accepted) {
      const from = projection.docStartByUnit[rawStart];
      const to = projection.docEndByUnit[rawEnd - 1];
      if (from >= 0 && to >= from) {
        matches.push({ from, to });
        previousRawTo = rawEnd;
      }
    }

    // Search/replace semantics use non-overlapping matches. Advancing one
    // character after an accepted match makes replace-all ranges overlap
    // (for example, "aaaa" / "aa") and corrupts the transaction.
    idx = text.indexOf(q, idx + (accepted ? q.length : 1));
  }

  return matches;
}

/** 按选项收集文档中所有匹配区间 */
export function collectSearchMatches(
  doc: ProseNode,
  query: string,
  options: SearchOptions = {},
): SearchMatch[] {
  if (!query) return [];
  const caseSensitive = options.caseSensitive ?? false;
  // CJK 无空格分词：整词边界对汉字几乎总是误伤，含 CJK 时退回子串匹配
  const wholeWord = (options.wholeWord ?? false) && !queryHasCjk(query);
  const matches: SearchMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    matches.push(...collectMatchesInTextblock(
      projectTextblock(node, pos),
      query,
      caseSensitive,
      wholeWord,
    ));
    // Text children were consumed as one projection; do not visit them again.
    return false;
  });
  return matches;
}

/** Apply a replace-all operation from the end of the document. */
export function replaceAllSearchMatches(
  transaction: Transaction,
  matches: SearchMatch[],
  replacement: string,
): Transaction {
  const nonOverlapping: SearchMatch[] = [];
  let previousTo = -1;
  for (const match of [...matches].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (match.from < match.to && match.from >= previousTo) {
      nonOverlapping.push(match);
      previousTo = match.to;
    }
  }

  let next = transaction;
  for (let i = nonOverlapping.length - 1; i >= 0; i--) {
    const match = nonOverlapping[i];
    next = next.insertText(replacement, match.from, match.to);
  }
  return next;
}

function buildState(
  doc: ProseNode,
  query: string,
  activeIndex: number,
  caseSensitive: boolean,
  wholeWord: boolean,
): SearchHighlightState {
  const matches = collectSearchMatches(doc, query, { caseSensitive, wholeWord });
  const clamped = matches.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), matches.length - 1);
  const decorations = matches.length === 0
    ? DecorationSet.empty
    : DecorationSet.create(
        doc,
        matches.map((m, i) =>
          Decoration.inline(m.from, m.to, {
            class: i === clamped ? 'notes-search-match notes-search-match--active' : 'notes-search-match',
          })
        )
      );
  return { query, activeIndex: clamped, caseSensitive, wholeWord, matches, decorations };
}

const emptyState = (): SearchHighlightState => ({
  query: '',
  activeIndex: 0,
  caseSensitive: false,
  wholeWord: false,
  matches: [],
  decorations: DecorationSet.empty,
});

export const searchHighlightPlugin = $prose(() =>
  new Plugin<SearchHighlightState>({
    key: searchHighlightKey,
    state: {
      init: emptyState,
      apply(tr, value) {
        const meta = tr.getMeta(searchHighlightKey) as SearchHighlightMeta | undefined;
        if (meta) {
          const nextQuery = meta.query ?? value.query;
          const nextCase = meta.caseSensitive ?? value.caseSensitive;
          const nextWhole = meta.wholeWord ?? value.wholeWord;
          // 新查询从第一个匹配开始；同查询导航沿用传入索引
          const nextIndex = meta.activeIndex ?? (nextQuery !== value.query ? 0 : value.activeIndex);
          if (!nextQuery) return emptyState();
          return buildState(tr.doc, nextQuery, nextIndex, nextCase, nextWhole);
        }
        if (tr.docChanged) {
          if (!value.query) return value;
          return buildState(
            tr.doc,
            value.query,
            value.activeIndex,
            value.caseSensitive,
            value.wholeWord,
          );
        }
        return value;
      },
    },
    props: {
      decorations(state) {
        return searchHighlightKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  })
);
