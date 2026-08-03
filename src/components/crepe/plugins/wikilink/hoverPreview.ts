/**
 * wikilink hover 预览卡片：悬停已解析链接约 400ms 后，在链接旁弹出
 * 锚定卡片显示目标笔记标题 + 前几行内容（经 DSTU getContent 异步加载）。
 * 单例 DOM，随 mouseleave / 滚动 / 点击关闭；卡片自身可承接悬停。
 */

import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import i18next from 'i18next';

import { buildPreviewSnippet, loadNoteContent } from './noteContent';

const CLASS = 'crepe-wikilink-preview';
/** 对齐 Obsidian page preview 的悬停延迟心智：约 800ms，避免扫过链接时频闪 */
const SHOW_DELAY_MS = 800;
const HIDE_DELAY_MS = 200;

let card: HTMLDivElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let requestToken = 0;
let currentAnchor: HTMLElement | null = null;
let detachScrollClose: (() => void) | null = null;

function ensureCard(): HTMLDivElement {
  if (card) return card;
  const el = document.createElement('div');
  el.className = CLASS;
  el.style.display = 'none';
  el.addEventListener('mouseenter', () => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  el.addEventListener('mouseleave', () => {
    scheduleHide();
  });
  document.body.appendChild(el);
  card = el;
  return el;
}

function clearTimers(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function attachScrollClose(): void {
  if (detachScrollClose) return;
  const onScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && card?.contains(target)) return;
    hideWikilinkPreviewNow();
  };
  window.addEventListener('scroll', onScroll, true);
  detachScrollClose = () => {
    window.removeEventListener('scroll', onScroll, true);
    detachScrollClose = null;
  };
}

function scheduleHide(): void {
  if (hideTimer !== null) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    hideWikilinkPreviewNow();
  }, HIDE_DELAY_MS);
}

async function positionCard(anchor: HTMLElement, el: HTMLElement): Promise<void> {
  const { x, y } = await computePosition(anchor, el, {
    // 卡片 CSS 为 position: fixed，strategy 必须一致，否则页面滚动后错位
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  });
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function renderCard(title: string, body: string | null, meta?: string): void {
  const el = ensureCard();
  el.replaceChildren();

  const heading = document.createElement('div');
  heading.className = `${CLASS}__title`;
  heading.textContent = title;
  el.appendChild(heading);

  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = `${CLASS}__meta`;
    metaEl.textContent = meta;
    el.appendChild(metaEl);
  }

  const content = document.createElement('div');
  content.className = `${CLASS}__body`;
  if (body === null) {
    content.classList.add(`${CLASS}__body--status`);
    content.textContent = i18next.t('notes:wikilink.previewLoading', {
      defaultValue: '加载中…',
    });
  } else if (!body) {
    content.classList.add(`${CLASS}__body--status`);
    content.textContent = i18next.t('notes:wikilink.previewEmpty', {
      defaultValue: '（空笔记）',
    });
  } else {
    content.textContent = body;
  }
  el.appendChild(content);
}

export interface WikilinkPreviewOptions {
  /** 卡片元信息行（如所在文件夹路径） */
  meta?: string;
}

/** 悬停进入：延迟后展示预览。displayTitle 用于卡片标题（label 或 target）。 */
export function scheduleWikilinkPreview(
  anchor: HTMLElement,
  noteId: string,
  displayTitle: string,
  options: WikilinkPreviewOptions = {},
): void {
  if (!noteId) return;
  // 从链接 A 直接扫到链接 B：立即收起 A 的卡片，
  // 否则旧内容会挂在屏幕上直到 B 的展示延迟到期
  if (card && card.style.display !== 'none' && currentAnchor && currentAnchor !== anchor) {
    hideWikilinkPreviewNow();
  }
  clearTimers();
  currentAnchor = anchor;
  const token = ++requestToken;

  showTimer = setTimeout(() => {
    showTimer = null;
    void (async () => {
      if (token !== requestToken || !anchor.isConnected) return;

      const el = ensureCard();
      renderCard(displayTitle, null, options.meta);
      el.style.display = 'block';
      await positionCard(anchor, el);
      attachScrollClose();

      const content = await loadNoteContent(noteId);
      if (token !== requestToken || !anchor.isConnected) return;
      renderCard(displayTitle, content == null ? '' : buildPreviewSnippet(content), options.meta);
      await positionCard(anchor, el);
    })();
  }, SHOW_DELAY_MS);
}

/** 悬停离开：延迟关闭（允许移入卡片） */
export function cancelWikilinkPreview(anchor?: HTMLElement): void {
  if (anchor && currentAnchor && anchor !== currentAnchor) return;
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  scheduleHide();
}

/** 立即关闭（点击 / 滚动 / NodeView 销毁） */
export function hideWikilinkPreviewNow(): void {
  requestToken += 1;
  clearTimers();
  currentAnchor = null;
  detachScrollClose?.();
  if (card) {
    card.style.display = 'none';
    card.replaceChildren();
  }
}
