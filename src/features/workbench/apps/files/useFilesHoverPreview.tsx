/**
 * useFilesHoverPreview — 资源条目 hover 预览玻璃卡（O17）
 *
 * 在 files 窗口宿主上事件委托监听 `[data-finder-item]`：
 * - 延迟出现（避免扫过列表闪烁）；
 * - 跟随指针并钳位到视口；
 * - 玻璃面复用契约类 `wb-glass`；
 * - 直写 DOM（定位/显隐），不进 React state。
 *
 * 不改 legacy FinderFileItem；元数据从 finderStore.items 只读查找。
 */
import { useEffect, useRef } from 'react';
import { useFinderStore } from '@/features/learning-hub/stores/finderStore';
import { useTranslation } from 'react-i18next';

const SHOW_DELAY_MS = 420;
const HIDE_DELAY_MS = 80;
const OFFSET_X = 16;
const OFFSET_Y = 18;
const EDGE_PAD = 10;

export interface UseFilesHoverPreviewOptions {
  hostRef: { readonly current: HTMLElement | null };
  enabled?: boolean;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 长路径中段省略：保住首段与文件名尾段（CSS 尾部省略会吞掉最有辨识度的结尾） */
function middleEllipsis(text: string, max = 56): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.4);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function typeLabel(
  t: (key: string) => string,
  type: string,
): string {
  switch (type) {
    case 'note':
      return t('workbench:files.preview.type.note');
    case 'textbook':
      return t('workbench:files.preview.type.textbook');
    case 'exam':
      return t('workbench:files.preview.type.exam');
    case 'translation':
      return t('workbench:files.preview.type.translation');
    case 'essay':
      return t('workbench:files.preview.type.essay');
    case 'image':
      return t('workbench:files.preview.type.image');
    case 'file':
      return t('workbench:files.preview.type.file');
    case 'mindmap':
      return t('workbench:files.preview.type.mindmap');
    case 'folder':
      return t('workbench:files.preview.type.folder');
    default:
      return t('workbench:files.preview.type.generic');
  }
}

export function useFilesHoverPreview(options: UseFilesHoverPreviewOptions): void {
  const { hostRef, enabled = true } = options;
  const { t } = useTranslation('workbench');
  const cardRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!enabled) return;
    const host = hostRef.current;
    if (!host || typeof document === 'undefined') return;

    const card = document.createElement('div');
    card.className = 'wb-files-hover-preview wb-glass wb-glass-highlight';
    card.setAttribute('data-wb-files-hover-preview', '');
    card.setAttribute('data-visible', 'false');
    card.setAttribute('role', 'tooltip');
    card.setAttribute('aria-hidden', 'true');
    card.innerHTML = [
      '<div class="wb-files-hover-preview__type"></div>',
      '<div class="wb-files-hover-preview__title"></div>',
      '<div class="wb-files-hover-preview__meta"></div>',
    ].join('');
    document.body.appendChild(card);
    cardRef.current = card;

    const typeEl = card.querySelector('.wb-files-hover-preview__type') as HTMLElement;
    const titleEl = card.querySelector('.wb-files-hover-preview__title') as HTMLElement;
    const metaEl = card.querySelector('.wb-files-hover-preview__meta') as HTMLElement;

    const clearShow = () => {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };
    const clearHide = () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };

    const positionCard = (clientX: number, clientY: number) => {
      const rect = card.getBoundingClientRect();
      const w = rect.width || 280;
      const h = rect.height || 88;
      const left = clamp(clientX + OFFSET_X, EDGE_PAD, window.innerWidth - w - EDGE_PAD);
      const top = clamp(clientY + OFFSET_Y, EDGE_PAD, window.innerHeight - h - EDGE_PAD);
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    };

    const hide = () => {
      clearShow();
      activeIdRef.current = null;
      card.setAttribute('data-visible', 'false');
      card.setAttribute('aria-hidden', 'true');
    };

    const showFor = (itemId: string) => {
      const item = useFinderStore.getState().items.find((n) => n.id === itemId);
      if (!item || item.type === 'folder') {
        hide();
        return;
      }
      activeIdRef.current = itemId;
      typeEl.textContent = typeLabel(t, item.type);
      titleEl.textContent = item.name || itemId;
      metaEl.textContent = middleEllipsis(item.path || itemId);
      card.setAttribute('data-visible', 'true');
      card.setAttribute('aria-hidden', 'false');
      positionCard(pointerRef.current.x, pointerRef.current.y);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      if (card.getAttribute('data-visible') === 'true') {
        positionCard(event.clientX, event.clientY);
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const itemEl = target.closest('[data-finder-item]') as HTMLElement | null;
      if (!itemEl || !host.contains(itemEl)) {
        clearShow();
        if (activeIdRef.current) {
          clearHide();
          hideTimerRef.current = window.setTimeout(hide, HIDE_DELAY_MS);
        }
        return;
      }

      const itemId = itemEl.getAttribute('data-item-id');
      if (!itemId) return;
      clearHide();
      if (activeIdRef.current === itemId) return;
      clearShow();
      showTimerRef.current = window.setTimeout(() => showFor(itemId), SHOW_DELAY_MS);
    };

    const onPointerLeave = () => {
      clearShow();
      clearHide();
      hide();
    };

    // 按下（点击/起拖/右键菜单）立即收起：预览卡不应盖住后续交互
    const onPointerDown = () => {
      clearHide();
      hide();
    };

    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerleave', onPointerLeave);
    host.addEventListener('pointerdown', onPointerDown, true);
    host.addEventListener('scroll', hide, true);

    return () => {
      clearShow();
      clearHide();
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('pointerdown', onPointerDown, true);
      host.removeEventListener('scroll', hide, true);
      card.remove();
      cardRef.current = null;
    };
  }, [enabled, hostRef, t]);
}
