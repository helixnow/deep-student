/**
 * 输入 @ 触发笔记补全浮层（防抖查询、↑↓ Enter Esc）
 */

import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

import { handleMentionLinkClick } from './click';
import { detectMentionTrigger, shouldSkipMentionContext } from './detectTrigger';
import { applyMentionInsert } from './insertMention';
import { createMentionOverlay } from './overlay';
import { anchorRectFromView } from '../shared/suggestOverlay';
import { defaultSearchNotes, sliceSuggestions } from './search';
import type { MentionNoteCandidate, MentionPluginConfig } from './types';

export const mentionAutocompleteKey = new PluginKey('crepeMentionAutocomplete');

interface ActiveTrigger {
  from: number;
  query: string;
}

export function createMentionAutocompletePlugin(config: MentionPluginConfig = {}) {
  const maxSuggestions = config.maxSuggestions ?? 8;
  const debounceMs = config.debounceMs ?? 150;
  const searchNotes = config.searchNotes ?? defaultSearchNotes;

  return $prose(() => {
    const overlay = createMentionOverlay();
    let active: ActiveTrigger | null = null;
    let requestId = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSignature = '';

    const clearDebounce = () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const closeAll = () => {
      requestId += 1;
      clearDebounce();
      overlay.close();
      active = null;
      lastSignature = '';
    };

    const applyPick = (view: EditorView, note: MentionNoteCandidate) => {
      if (!active) return;
      const from = active.from;
      const to = view.state.selection.from;
      const tr = applyMentionInsert(view.state, from, to, note);
      if (!tr) return;
      view.dispatch(tr);
      closeAll();
    };

    const runSearch = (view: EditorView, query: string) => {
      const myRequest = ++requestId;

      const loadingRect = anchorRectFromView(view, view.state.selection.from);
      if (!overlay.isOpen()) {
        overlay.open(loadingRect, [], (note) => applyPick(view, note), 'loading');
      } else {
        overlay.moveAnchor(loadingRect);
        overlay.update([], 0, 'loading');
      }

      void Promise.resolve(searchNotes(query))
        .then((results) => {
          if (myRequest !== requestId) return;
          if (!view.dom.isConnected) return;

          const notes = sliceSuggestions(results, maxSuggestions);
          const rect = anchorRectFromView(view, view.state.selection.from);

          if (overlay.isOpen()) {
            overlay.moveAnchor(rect);
            overlay.update(notes, 0, 'empty');
          } else {
            overlay.open(rect, notes, (note) => applyPick(view, note), 'empty');
          }
        })
        .catch(() => {
          if (myRequest !== requestId) return;
          if (overlay.isOpen()) {
            overlay.update([], 0, 'empty');
          }
        });
    };

    const scheduleSearch = (view: EditorView, query: string) => {
      clearDebounce();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        runSearch(view, query);
      }, debounceMs);
    };

    return new Plugin({
      key: mentionAutocompleteKey,
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

          if (shouldSkipMentionContext(state)) {
            if (overlay.isOpen()) closeAll();
            return;
          }

          const $from = selection.$from;
          const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
          const detected = detectMentionTrigger(textBefore);
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

          // 立即展示 loading，再防抖真正查询
          const rect = anchorRectFromView(editorView, selection.from);
          if (!overlay.isOpen()) {
            overlay.open(rect, [], (note) => applyPick(editorView, note), 'loading');
          } else {
            overlay.moveAnchor(rect);
            overlay.update([], 0, 'loading');
          }

          scheduleSearch(editorView, query);
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
          if (event.key === ' ' || event.key === 'Spacebar') {
            // 空格取消补全，仍插入空格
            closeAll();
            return false;
          }
          if (event.key === 'ArrowDown') {
            if (overlay.getItems().length === 0) return false;
            event.preventDefault();
            overlay.setSelected(overlay.getSelectedIndex() + 1);
            return true;
          }
          if (event.key === 'ArrowUp') {
            if (overlay.getItems().length === 0) return false;
            event.preventDefault();
            overlay.setSelected(overlay.getSelectedIndex() - 1);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const notes = overlay.getItems();
            if (notes.length === 0) return false;
            event.preventDefault();
            const note = notes[overlay.getSelectedIndex()];
            if (!note) return false;
            applyPick(view, note);
            return true;
          }
          return false;
        },
        handleDOMEvents: {
          click(view, event) {
            return handleMentionLinkClick(view, event);
          },
        },
      },
    });
  });
}
