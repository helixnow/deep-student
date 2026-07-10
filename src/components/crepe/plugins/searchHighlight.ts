/**
 * 笔记编辑器查找高亮插件
 *
 * 通过 ProseMirror Decoration 高亮所有匹配项，当前匹配项使用强调色。
 * 由 FindReplacePanel 通过 transaction meta 驱动：
 *   view.dispatch(tr.setMeta(searchHighlightKey, { query, activeIndex, caseSensitive, wholeWord }))
 *
 * 文档变更时自动重新计算匹配（支持边输入边更新计数）。
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
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

function isWholeWordMatch(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : undefined;
  const after = end < text.length ? text[end] : undefined;
  return !isWordChar(before) && !isWordChar(after);
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
  const q = caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const raw = node.text;
    const text = caseSensitive ? raw : raw.toLowerCase();
    let idx = text.indexOf(q);
    while (idx !== -1) {
      const end = idx + q.length;
      if (!wholeWord || isWholeWordMatch(raw, idx, end)) {
        matches.push({ from: pos + idx, to: pos + end });
      }
      idx = text.indexOf(q, idx + 1);
    }
  });
  return matches;
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
