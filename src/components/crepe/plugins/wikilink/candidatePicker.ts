/**
 * 歧义 wikilink 候选选择浮层（B13）。
 *
 * 标题命中多篇笔记时，点击链接不再静默打开最小 ID，而是在链接旁弹出
 * 锚定浮层（复用 suggestOverlay 定位 / listbox 行为，非 Modal），列出全部
 * 候选（标题 + 所在文件夹 + ID 尾缀），用户点选后派发 DSTU_OPEN_NOTE。
 */

import i18next from 'i18next';

import {
  createSuggestOverlay,
  type AnchorRect,
  type SuggestOverlay,
} from '../shared/suggestOverlay';
import { dispatchOpenNote, type WikilinkPluginConfig } from './types';

const CLASS = 'crepe-wikilink-candidates';

interface CandidateItem {
  id: string;
  title: string;
  meta: string;
}

let overlay: SuggestOverlay<CandidateItem> | null = null;
let detachGlobalClose: (() => void) | null = null;
let openToken = 0;
/** 当前浮层归属的锚点；按实例关闭时用于判定归属 */
let currentAnchor: HTMLElement | null = null;
let currentPick: ((item: CandidateItem) => void) | null = null;

function ensureOverlay(): SuggestOverlay<CandidateItem> {
  if (overlay) return overlay;
  overlay = createSuggestOverlay<CandidateItem>({
    className: CLASS,
    decorateItem(row, item) {
      const title = document.createElement('span');
      title.className = `${CLASS}__item-title`;
      title.textContent = item.title;
      row.appendChild(title);
      if (item.meta) {
        const meta = document.createElement('span');
        meta.className = `${CLASS}__item-meta`;
        meta.textContent = item.meta;
        row.appendChild(meta);
      }
    },
    renderPlaceholder() {
      const empty = document.createElement('div');
      empty.className = `${CLASS}__empty`;
      empty.textContent = i18next.t('notes:wikilink.noCandidates', {
        defaultValue: '无候选笔记',
      });
      return empty;
    },
  });
  return overlay;
}

function folderFromPath(path: string | undefined): string {
  if (!path) return '';
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '';
}

function candidateMeta(id: string, path: string | undefined): string {
  const parts: string[] = [];
  const folder = folderFromPath(path);
  if (folder) parts.push(folder);
  parts.push(`…${id.slice(-6)}`);
  return parts.join(' · ');
}

function attachGlobalClose(): void {
  detachGlobalClose?.();
  const onPointerDown = (event: MouseEvent) => {
    const target = event.target;
    if (target instanceof Node && document.querySelector(`.${CLASS}`)?.contains(target)) return;
    closeWikilinkCandidatePicker();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeWikilinkCandidatePicker();
      return;
    }
    const ov = overlay;
    if (!ov || !ov.isOpen()) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (ov.getItems().length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      ov.setSelected(ov.getSelectedIndex() + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter') {
      const item = ov.getItems()[ov.getSelectedIndex()];
      if (!item) return;
      event.preventDefault();
      event.stopPropagation();
      currentPick?.(item);
    }
  };
  const onScroll = (event: Event) => {
    // 浮层自身滚动（候选较多时）不应关闭
    const target = event.target;
    if (target instanceof Node && document.querySelector(`.${CLASS}`)?.contains(target)) return;
    closeWikilinkCandidatePicker();
  };
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  detachGlobalClose = () => {
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
    detachGlobalClose = null;
  };
}

export function closeWikilinkCandidatePicker(): void {
  openToken += 1;
  detachGlobalClose?.();
  currentAnchor = null;
  currentPick = null;
  overlay?.close();
}

/**
 * 按实例关闭：仅当浮层归属 anchor 时才关闭。
 * NodeView destroy 使用，避免任一节点销毁误关其它链接刚弹出的浮层。
 */
export function closeWikilinkCandidatePickerFor(anchor: HTMLElement): void {
  if (currentAnchor !== anchor) return;
  closeWikilinkCandidatePicker();
}

export interface WikilinkCandidatePickerOptions {
  /** 锚定元素（被点击的 wikilink NodeView span） */
  anchor: HTMLElement;
  /** 原始 note 目标文本（写入 DSTU_OPEN_NOTE detail.target） */
  target: string;
  heading?: string;
  candidateIds: readonly string[];
  getNotes?: WikilinkPluginConfig['getNotes'];
}

export function openWikilinkCandidatePicker(options: WikilinkCandidatePickerOptions): void {
  const { anchor, target, heading, candidateIds, getNotes } = options;
  if (candidateIds.length === 0) return;

  const token = ++openToken;
  void (async () => {
    let notes: readonly { id: string; title: string; path?: string }[] = [];
    try {
      notes = getNotes ? await Promise.resolve(getNotes()) : [];
    } catch {
      notes = [];
    }
    if (token !== openToken || !anchor.isConnected) return;

    const byId = new Map(notes.map((note) => [note.id, note]));
    const items: CandidateItem[] = candidateIds.map((id) => {
      const note = byId.get(id);
      return {
        id,
        title: note?.title ?? id,
        meta: candidateMeta(id, note?.path),
      };
    });

    const rect = anchor.getBoundingClientRect();
    const anchorRect: AnchorRect = { left: rect.left, top: rect.top, bottom: rect.bottom };
    const pick = (item: CandidateItem) => {
      closeWikilinkCandidatePicker();
      dispatchOpenNote(target, item.id, heading);
    };
    currentAnchor = anchor;
    currentPick = pick;
    ensureOverlay().open(anchorRect, items, pick);
    attachGlobalClose();
  })();
}
