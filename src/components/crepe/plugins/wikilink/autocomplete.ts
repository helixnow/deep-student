/**
 * 输入 [[ 触发笔记标题补全浮层（共享 suggestOverlay 定位）
 */

import i18next from 'i18next';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

import {
  anchorRectFromView,
  createSuggestOverlay,
} from '../shared/suggestOverlay';
import { fuzzyMatchNotes } from './fuzzy';
import { WIKILINK_NODE_NAME } from './schema';
import type { WikilinkNoteCandidate, WikilinkPluginConfig } from './types';

export const wikilinkAutocompleteKey = new PluginKey('crepeWikilinkAutocomplete');

type MenuItem =
  | { kind: 'note'; note: WikilinkNoteCandidate }
  | { kind: 'create'; title: string };

interface ActiveTrigger {
  from: number;
  query: string;
}

/**
 * 从光标前回溯，检测未闭合的 `[[query`。
 * 返回 trigger 在 textBefore 内的起始偏移与 query；无触发时返回 null。
 */
export function detectWikilinkTrigger(
  textBefore: string,
): { triggerStartInText: number; query: string } | null {
  const open = textBefore.lastIndexOf('[[');
  if (open < 0) return null;
  const after = textBefore.slice(open + 2);
  if (after.includes(']]') || after.includes('\n')) return null;
  return { triggerStartInText: open, query: after };
}

const CLASS = 'crepe-wikilink-suggest';

function createOverlay() {
  return createSuggestOverlay<MenuItem>({
    className: CLASS,
    decorateItem(row, item) {
      if (item.kind === 'note') {
        row.textContent = item.note.title;
        row.dataset.kind = 'note';
      } else {
        row.classList.add(`${CLASS}__item--create`);
        row.textContent = i18next.t('notes:wikilink.create', {
          defaultValue: '创建 "{{title}}"',
          title: item.title,
        });
        row.dataset.kind = 'create';
      }
    },
    renderPlaceholder() {
      const empty = document.createElement('div');
      empty.className = `${CLASS}__empty`;
      empty.textContent = i18next.t('notes:wikilink.empty', {
        defaultValue: '无匹配笔记',
      });
      return empty;
    },
  });
}

async function loadNotes(
  getNotes: WikilinkPluginConfig['getNotes'],
): Promise<readonly WikilinkNoteCandidate[]> {
  if (!getNotes) return [];
  try {
    return await Promise.resolve(getNotes());
  } catch {
    return [];
  }
}

export function buildAutocompleteItems(
  notes: readonly WikilinkNoteCandidate[],
  query: string,
  maxSuggestions: number,
): MenuItem[] {
  const matched = fuzzyMatchNotes(notes, query, maxSuggestions);
  const items: MenuItem[] = matched.map((note) => ({ kind: 'note', note }));
  const q = query.trim();
  if (q) {
    const exact = matched.some((n) => n.title.trim() === q);
    if (!exact) {
      items.push({ kind: 'create', title: q });
    }
  }
  return items;
}

export function insertWikilink(
  view: EditorView,
  from: number,
  to: number,
  target: string,
  label = '',
): void {
  const type = view.state.schema.nodes[WIKILINK_NODE_NAME];
  if (!type) return;
  const node = type.create({ target, label });
  view.dispatch(view.state.tr.replaceWith(from, to, node).scrollIntoView());
}

export function createWikilinkAutocompletePlugin(config: WikilinkPluginConfig = {}) {
  const maxSuggestions = config.maxSuggestions ?? 8;

  return $prose(() => {
    const overlay = createOverlay();
    let active: ActiveTrigger | null = null;
    let requestId = 0;
    let lastSignature = '';

    const closeAll = () => {
      requestId += 1;
      overlay.close();
      active = null;
      lastSignature = '';
    };

    const applyPick = (view: EditorView, item: MenuItem) => {
      if (!active) return;
      const from = active.from;
      const to = view.state.selection.from;
      if (item.kind === 'note') {
        insertWikilink(view, from, to, item.note.title, '');
      } else {
        insertWikilink(view, from, to, item.title, '');
      }
      closeAll();
    };

    return new Plugin({
      key: wikilinkAutocompleteKey,
      view(editorView) {
        const refresh = () => {
          const editable = editorView.editable;
          if (!editable) {
            if (overlay.isOpen()) closeAll();
            return;
          }

          const { state } = editorView;
          const { selection } = state;
          if (!(selection instanceof TextSelection) || !selection.empty) {
            if (overlay.isOpen()) closeAll();
            return;
          }

          const $from = selection.$from;
          const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
          const detected = detectWikilinkTrigger(textBefore);
          if (!detected) {
            if (overlay.isOpen()) closeAll();
            return;
          }

          const from = $from.start() + detected.triggerStartInText;
          const query = detected.query;
          const signature = `${from}:${query}`;
          active = { from, query };

          if (signature === lastSignature && overlay.isOpen()) {
            overlay.moveAnchor(anchorRectFromView(editorView, selection.from));
            return;
          }
          lastSignature = signature;

          const myRequest = ++requestId;
          void loadNotes(config.getNotes).then((notes) => {
            if (myRequest !== requestId) return;
            if (!editorView.dom.isConnected) return;

            const items = buildAutocompleteItems(notes, query, maxSuggestions);
            const rect = anchorRectFromView(editorView, editorView.state.selection.from);

            if (overlay.isOpen()) {
              overlay.moveAnchor(rect);
              overlay.update(items, 0);
            } else {
              overlay.open(rect, items, (item) => applyPick(editorView, item));
            }
          });
        };

        return {
          update(view, prevState) {
            if (
              view.state.doc.eq(prevState.doc)
              && view.state.selection.eq(prevState.selection)
            ) {
              return;
            }
            refresh();
          },
          destroy() {
            closeAll();
          },
        };
      },
      props: {
        handleKeyDown(view, event) {
          if (!overlay.isOpen() || !active) return false;

          if (event.key === 'Escape') {
            event.preventDefault();
            closeAll();
            return true;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            overlay.setSelected(overlay.getSelectedIndex() + 1);
            return true;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            overlay.setSelected(overlay.getSelectedIndex() - 1);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const items = overlay.getItems();
            if (items.length === 0) return false;
            event.preventDefault();
            const item = items[overlay.getSelectedIndex()];
            if (!item) return false;
            applyPick(view, item);
            return true;
          }
          return false;
        },
      },
    });
  });
}
