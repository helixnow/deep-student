/**
 * 笔记编辑器查找高亮插件
 *
 * 通过 ProseMirror Decoration 高亮所有匹配项，当前匹配项使用强调色。
 * 由 FindReplacePanel 通过 transaction meta 驱动：
 *   view.dispatch(tr.setMeta(searchHighlightKey, { query, activeIndex }))
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

export interface SearchHighlightState {
  query: string;
  activeIndex: number;
  matches: SearchMatch[];
  decorations: DecorationSet;
}

export interface SearchHighlightMeta {
  query?: string;
  activeIndex?: number;
}

export const searchHighlightKey = new PluginKey<SearchHighlightState>('notesSearchHighlight');

/** 大小写不敏感地收集文档中所有匹配区间 */
export function collectSearchMatches(doc: ProseNode, query: string): SearchMatch[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const matches: SearchMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let idx = text.indexOf(q);
    while (idx !== -1) {
      matches.push({ from: pos + idx, to: pos + idx + q.length });
      idx = text.indexOf(q, idx + q.length);
    }
  });
  return matches;
}

function buildState(doc: ProseNode, query: string, activeIndex: number): SearchHighlightState {
  const matches = collectSearchMatches(doc, query);
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
  return { query, activeIndex: clamped, matches, decorations };
}

const emptyState = (): SearchHighlightState => ({
  query: '',
  activeIndex: 0,
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
          // 新查询从第一个匹配开始；同查询导航沿用传入索引
          const nextIndex = meta.activeIndex ?? (nextQuery !== value.query ? 0 : value.activeIndex);
          if (!nextQuery) return emptyState();
          return buildState(tr.doc, nextQuery, nextIndex);
        }
        if (tr.docChanged) {
          if (!value.query) return value;
          return buildState(tr.doc, value.query, value.activeIndex);
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
