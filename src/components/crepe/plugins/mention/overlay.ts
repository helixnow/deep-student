/**
 * @ 提及补全浮层（基于共享 suggestOverlay，交互风格对齐 wikilink）
 */

import i18next from 'i18next';

import {
  appendHighlightedText,
  createSuggestOverlay,
  type SuggestOverlay,
} from '../shared/suggestOverlay';
import type { MentionNoteCandidate } from './types';

const CLASS = 'crepe-mention-suggest';

/** '/folder/sub/note_1' → '/folder/sub'；根目录或缺失时返回 '' */
function folderFromPath(path: string | undefined): string {
  if (!path) return '';
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '';
}

export function createMentionOverlay(
  getQuery: () => string = () => '',
): SuggestOverlay<MentionNoteCandidate> {
  return createSuggestOverlay<MentionNoteCandidate>({
    className: CLASS,
    decorateItem(row, note) {
      const title = document.createElement('span');
      title.className = `${CLASS}__item-title`;
      appendHighlightedText(title, note.title, getQuery(), `${CLASS}__item-match`);
      row.appendChild(title);
      const folder = folderFromPath(note.path);
      if (folder) {
        const meta = document.createElement('span');
        meta.className = `${CLASS}__item-meta`;
        meta.textContent = folder;
        row.appendChild(meta);
      }
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
