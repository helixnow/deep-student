/**
 * wikilink hover 预览卡片：悬停已解析链接约 650ms 后（或按住 Cmd/Ctrl 立即触发），
 * 在链接旁弹出锚定卡片显示目标笔记标题 + 富文本 Markdown/KaTeX 预览（经 DSTU getContent 异步加载）。
 * 单例 DOM，随 mouseleave / 外部滚动 / 点击 / Escape 关闭；卡片自身可承接悬停与内部滚动。
 */

import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import i18next from 'i18next';

import { loadNoteContent } from './noteContent';
import { renderPreviewMarkdown } from './renderPreviewMarkdown';

const CLASS = 'crepe-wikilink-preview';
/** 默认悬停延迟 650ms，避免扫过链接时频闪；按住 Cmd/Ctrl 或传 immediate 可立即弹出 */
export const WIKILINK_PREVIEW_SHOW_DELAY_MS = 650;
const HIDE_DELAY_MS = 200;

type PreviewBodyState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error' }
  | { kind: 'html'; html: string };

let card: HTMLDivElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let pendingOpen: (() => void) | null = null;
let requestToken = 0;
let currentAnchor: HTMLElement | null = null;
let detachScrollClose: (() => void) | null = null;
let modifierPressed = false;
let modifierTrackingAttached = false;

function isComposingKeyEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

function ensureModifierTracking(): void {
  if (modifierTrackingAttached || typeof window === 'undefined') return;
  modifierTrackingAttached = true;

  window.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      const next = event.metaKey || event.ctrlKey;
      const becamePressed = !modifierPressed && next;
      modifierPressed = next;

      // 悬停等待期间按下 Cmd/Ctrl：立即触发已排队的预览（Obsidian 手感）
      if (becamePressed && pendingOpen && showTimer !== null) {
        const trigger = pendingOpen;
        clearTimeout(showTimer);
        showTimer = null;
        pendingOpen = null;
        trigger();
      }

      // 按 Escape 关闭已打开的预览卡片（IME 组合态忽略）；阻止穿透退出专注模式
      if (
        !isComposingKeyEvent(event) &&
        event.key === 'Escape' &&
        card &&
        card.style.display !== 'none'
      ) {
        event.preventDefault();
        event.stopPropagation();
        hideWikilinkPreviewNow();
      }
    },
    true,
  );

  window.addEventListener(
    'keyup',
    (event: KeyboardEvent) => {
      modifierPressed = event.metaKey || event.ctrlKey;
    },
    true,
  );

  window.addEventListener('blur', () => {
    modifierPressed = false;
  });
}

function ensureCard(): HTMLDivElement {
  if (card) return card;
  const el = document.createElement('div');
  el.className = CLASS;
  el.setAttribute('role', 'tooltip');
  el.style.display = 'none';
  el.style.visibility = 'hidden';
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
  pendingOpen = null;
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
  const onResize = () => {
    hideWikilinkPreviewNow();
  };
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  detachScrollClose = () => {
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
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

async function positionCard(
  anchor: HTMLElement,
  el: HTMLElement,
  token: number,
): Promise<boolean> {
  const { x, y, placement } = await computePosition(anchor, el, {
    // 卡片 CSS 为 position: fixed，strategy 必须一致，否则页面滚动后错位
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  });
  if (token !== requestToken || !anchor.isConnected || el.style.display === 'none') {
    return false;
  }
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  if (typeof placement === 'string') {
    const isTop = placement.startsWith('top');
    const isEnd = placement.endsWith('end');
    el.style.transformOrigin = `${isTop ? 'bottom' : 'top'} ${isEnd ? 'right' : 'left'}`;
  }
  el.style.visibility = 'visible';
  return true;
}

function renderCard(title: string, body: PreviewBodyState, meta?: string): void {
  const el = ensureCard();
  el.setAttribute('aria-label', title);
  el.replaceChildren();

  const header = document.createElement('div');
  header.className = `${CLASS}__header`;

  const heading = document.createElement('div');
  heading.className = `${CLASS}__title`;
  heading.textContent = title;
  header.appendChild(heading);

  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = `${CLASS}__meta`;
    metaEl.textContent = meta;
    header.appendChild(metaEl);
  }

  el.appendChild(header);

  const content = document.createElement('div');
  content.className = `${CLASS}__body`;
  if (body.kind === 'loading') {
    content.classList.add(`${CLASS}__body--status`);
    content.textContent =
      i18next.t('notes:wikilink.previewLoading', {
        defaultValue: '加载中…',
      }) || '加载中…';
  } else if (body.kind === 'empty') {
    content.classList.add(`${CLASS}__body--status`);
    content.textContent =
      i18next.t('notes:wikilink.previewEmpty', {
        defaultValue: '（空笔记）',
      }) || '（空笔记）';
  } else if (body.kind === 'error') {
    content.classList.add(`${CLASS}__body--status`, `${CLASS}__body--error`);
    content.textContent =
      i18next.t('notes:wikilink.previewError', {
        defaultValue: '无法加载笔记预览',
      }) || '无法加载笔记预览';
  } else {
    content.classList.add(`${CLASS}__body--rich`);
    // body.html 已由 renderPreviewMarkdown 通过 DOMPurify 严格清洗
    content.innerHTML = body.html;
  }
  el.appendChild(content);
}

export interface WikilinkPreviewOptions {
  /** 卡片元信息行（如所在文件夹路径） */
  meta?: string;
  /** 立即展示预览（跳过默认悬停延迟，如 Cmd/Ctrl 悬停触发） */
  immediate?: boolean;
}

/** 悬停进入：延迟（或按住 Cmd/Ctrl / immediate 立即）展示预览。displayTitle 用于卡片标题（label 或 target）。 */
export function scheduleWikilinkPreview(
  anchor: HTMLElement,
  noteId: string,
  displayTitle: string,
  options: WikilinkPreviewOptions = {},
): void {
  if (!noteId) return;
  ensureModifierTracking();

  // 指针从预览卡片移回原链接：保留已渲染内容与内部滚动位置，只取消隐藏定时器
  if (card && card.style.display !== 'none' && currentAnchor === anchor) {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    return;
  }

  // 从链接 A 直接扫到链接 B：立即收起 A 的卡片，
  // 否则旧内容会挂在屏幕上直到 B 的展示延迟到期
  if (card && card.style.display !== 'none' && currentAnchor && currentAnchor !== anchor) {
    hideWikilinkPreviewNow();
  }
  clearTimers();
  currentAnchor = anchor;
  const token = ++requestToken;

  const openPreview = () => {
    void (async () => {
      if (token !== requestToken || !anchor.isConnected) return;

      const el = ensureCard();
      renderCard(displayTitle, { kind: 'loading' }, options.meta);
      el.style.visibility = 'hidden';
      el.style.display = 'flex';
      const positioned = await positionCard(anchor, el, token);
      if (!positioned) return;
      attachScrollClose();

      let content: string | null;
      try {
        content = await loadNoteContent(noteId);
      } catch {
        content = null;
      }
      if (token !== requestToken || !anchor.isConnected) return;

      let bodyState: PreviewBodyState;
      if (content === null) {
        bodyState = { kind: 'error' };
      } else {
        const rendered = renderPreviewMarkdown(content);
        bodyState = rendered ? { kind: 'html', html: rendered } : { kind: 'empty' };
      }
      renderCard(displayTitle, bodyState, options.meta);
      await positionCard(anchor, el, token);
    })();
  };

  if (options.immediate || modifierPressed) {
    openPreview();
    return;
  }

  pendingOpen = openPreview;
  showTimer = setTimeout(() => {
    showTimer = null;
    pendingOpen = null;
    openPreview();
  }, WIKILINK_PREVIEW_SHOW_DELAY_MS);
}

/** 悬停离开：延迟关闭（允许移入卡片） */
export function cancelWikilinkPreview(anchor?: HTMLElement): void {
  if (anchor && currentAnchor && anchor !== currentAnchor) return;
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  pendingOpen = null;
  scheduleHide();
}

/** 立即关闭（点击 / 滚动 / 缩放 / Escape / NodeView 销毁） */
export function hideWikilinkPreviewNow(): void {
  requestToken += 1;
  clearTimers();
  currentAnchor = null;
  detachScrollClose?.();
  if (card) {
    card.style.display = 'none';
    card.style.visibility = 'hidden';
    card.replaceChildren();
  }
}
