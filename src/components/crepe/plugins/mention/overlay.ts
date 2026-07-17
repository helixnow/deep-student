/**
 * @ 提及补全浮层（基于共享 suggestOverlay，交互风格对齐 wikilink）
 */

import i18next from 'i18next';

import {
  createSuggestOverlay,
  type SuggestOverlay,
} from '../shared/suggestOverlay';
import type { MentionNoteCandidate } from './types';

const CLASS = 'crepe-mention-suggest';

export function createMentionOverlay(): SuggestOverlay<MentionNoteCandidate> {
  return createSuggestOverlay<MentionNoteCandidate>({
    className: CLASS,
    decorateItem(row, note) {
      row.textContent = note.title;
    },
    renderPlaceholder(kind) {
      const node = document.createElement('div');
      if (kind === 'loading') {
        node.className = `${CLASS}__status`;
        node.textContent = i18next.t('notes:mention.loading', {
          defaultValue: '搜索中…',
        });
      } else {
        node.className = `${CLASS}__empty`;
        node.textContent = i18next.t('notes:mention.empty', {
          defaultValue: '无匹配笔记',
        });
      }
      return node;
    },
  });
}
