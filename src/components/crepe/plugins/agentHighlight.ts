/**
 * ACR 笔记 AI 光标 / 插入高亮插件 — R1-12
 *
 * 克隆 searchHighlight 架构：ProseMirror Decoration + PluginKey meta 驱动。
 * 由 noteDriver / CrepeEditorApi.agentInsert|agentSignal 经 transaction meta 驱动：
 *   tr.setMeta(agentHighlightKey, { type: 'caret', pos })
 *   tr.setMeta(agentHighlightKey, { type: 'insert', from, to })
 *   tr.setMeta(agentHighlightKey, { type: 'fadeRun' })
 *   tr.setMeta(agentHighlightKey, { type: 'clearAll' })
 *
 * CSS 类约定（样式在 CrepeEditor.css「ACR agent 高亮」段）：
 *   - .agent-inserted         新插入区间底色高亮
 *   - .agent-inserted-fading  渐隐 3s（driver 再发 clearAll）
 *   - .acr-ai-caret           AI 光标竖线容器（widget）
 *   - .acr-ai-caret__bar      呼吸 opacity 竖线
 *   - .acr-ai-caret__label    「AI」小标签
 *
 * 设计：docs/dev/acr/DESIGN.md §5.2 / ROUND1 R1-12
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { $prose } from '@milkdown/utils';

export type AgentHighlightMeta =
  | { type: 'caret'; pos: number }
  | { type: 'insert'; from: number; to: number }
  | { type: 'clearAll' }
  | { type: 'fadeRun' };

export interface AgentInsertedRange {
  from: number;
  to: number;
  fading: boolean;
}

export interface AgentHighlightState {
  caretPos: number | null;
  ranges: AgentInsertedRange[];
  decorations: DecorationSet;
}

export const agentHighlightKey = new PluginKey<AgentHighlightState>('acrAgentHighlight');

const CARET_WIDGET_KEY = 'acr-caret';

function createCaretWidget(): HTMLElement {
  const root = document.createElement('span');
  root.className = 'acr-ai-caret';
  root.setAttribute('contenteditable', 'false');
  root.setAttribute('aria-hidden', 'true');

  const bar = document.createElement('span');
  bar.className = 'acr-ai-caret__bar';
  root.appendChild(bar);

  const label = document.createElement('span');
  label.className = 'acr-ai-caret__label';
  label.textContent = 'AI';
  root.appendChild(label);

  return root;
}

function clampPos(doc: ProseNode, pos: number): number {
  const max = Math.max(0, doc.content.size);
  return Math.max(0, Math.min(pos, max));
}

function buildDecorations(
  doc: ProseNode,
  caretPos: number | null,
  ranges: AgentInsertedRange[],
): DecorationSet {
  const decos: Decoration[] = [];

  for (const range of ranges) {
    if (range.from >= range.to) continue;
    const from = clampPos(doc, range.from);
    const to = clampPos(doc, range.to);
    if (from >= to) continue;
    decos.push(
      Decoration.inline(from, to, {
        class: range.fading ? 'agent-inserted-fading' : 'agent-inserted',
      }),
    );
  }

  if (caretPos != null) {
    const pos = clampPos(doc, caretPos);
    decos.push(
      Decoration.widget(pos, createCaretWidget, {
        key: CARET_WIDGET_KEY,
        side: 1,
      }),
    );
  }

  return decos.length === 0 ? DecorationSet.empty : DecorationSet.create(doc, decos);
}

function emptyState(): AgentHighlightState {
  return {
    caretPos: null,
    ranges: [],
    decorations: DecorationSet.empty,
  };
}

function withDecorations(
  doc: ProseNode,
  caretPos: number | null,
  ranges: AgentInsertedRange[],
): AgentHighlightState {
  return {
    caretPos,
    ranges,
    decorations: buildDecorations(doc, caretPos, ranges),
  };
}

export const agentHighlightPlugin = $prose(() =>
  new Plugin<AgentHighlightState>({
    key: agentHighlightKey,
    state: {
      init: emptyState,
      apply(tr, value) {
        const meta = tr.getMeta(agentHighlightKey) as AgentHighlightMeta | undefined;

        if (meta) {
          switch (meta.type) {
            case 'clearAll':
              return emptyState();
            case 'caret': {
              const caretPos = clampPos(tr.doc, meta.pos);
              const ranges = tr.docChanged
                ? value.ranges.map((r) => ({
                    from: tr.mapping.map(r.from, -1),
                    to: tr.mapping.map(r.to, 1),
                    fading: r.fading,
                  }))
                : value.ranges;
              return withDecorations(tr.doc, caretPos, ranges);
            }
            case 'insert': {
              const from = clampPos(tr.doc, meta.from);
              const to = clampPos(tr.doc, meta.to);
              const mappedExisting = tr.docChanged
                ? value.ranges.map((r) => ({
                    from: tr.mapping.map(r.from, -1),
                    to: tr.mapping.map(r.to, 1),
                    fading: r.fading,
                  }))
                : [...value.ranges];
              const ranges =
                from < to
                  ? [...mappedExisting, { from, to, fading: false }]
                  : mappedExisting;
              // 插入后 AI 光标落在新文本末尾
              return withDecorations(tr.doc, to, ranges);
            }
            case 'fadeRun': {
              const ranges = value.ranges.map((r) => ({ ...r, fading: true }));
              const caretPos = value.caretPos;
              return withDecorations(tr.doc, caretPos, ranges);
            }
            default:
              break;
          }
        }

        if (tr.docChanged) {
          if (value.caretPos == null && value.ranges.length === 0) {
            return value;
          }
          const caretPos =
            value.caretPos != null ? tr.mapping.map(value.caretPos, 1) : null;
          const ranges = value.ranges
            .map((r) => ({
              from: tr.mapping.map(r.from, -1),
              to: tr.mapping.map(r.to, 1),
              fading: r.fading,
            }))
            .filter((r) => r.from < r.to);
          return withDecorations(tr.doc, caretPos, ranges);
        }

        return value;
      },
    },
    props: {
      decorations(state) {
        return agentHighlightKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  }),
);
