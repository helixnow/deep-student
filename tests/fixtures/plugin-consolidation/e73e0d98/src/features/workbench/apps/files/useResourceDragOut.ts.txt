/**
 * useResourceDragOut — 指针拖出 files 窗检测 + 随行反馈徽标（O17）
 *
 * 在宿主上委托 pointerdown → 跟踪 pointermove：
 * - 指针进入桌面空白区后显示跟随徽标（直写 DOM，不进 React state）；
 * - 松手时仅当实际命中空白桌面才走 desktopDragBridge 开窗；窗口、Dock、
 *   overlay 与桌面外均不处理，窗内松手也不干预 legacy 行为。
 *
 * 同时在 pointerdown 命中 `[data-finder-item]` 时，若浏览器提供
 * DataTransfer（原生 drag），由 bridge 的 setWorkbenchDragData 写入 MIME——
 * 本 hook 主要覆盖 dnd-kit 指针拖（无 HTML5 drag）出窗场景。
 */
import { useEffect, useRef } from 'react';
import { useFinderStore } from '@/features/learning-hub/stores/finderStore';
import {
  handleDesktopResourceDrop,
  normalizeWorkbenchResourceDragData,
  resolveWorkbenchDesktopDropPoint,
  type WorkbenchResourceDragData,
} from './desktopDragBridge';

const DRAG_THRESHOLD_PX = 6;

export interface UseResourceDragOutOptions {
  hostRef: { readonly current: HTMLElement | null };
  windowId?: string;
  enabled?: boolean;
}

function glyphForType(type: string): string {
  switch (type) {
    case 'note':
      return 'N';
    case 'textbook':
      return 'T';
    case 'exam':
      return 'E';
    case 'mindmap':
      return 'M';
    case 'image':
      return 'I';
    case 'essay':
      return 'A';
    case 'translation':
      return 'L';
    default:
      return 'F';
  }
}

export function useResourceDragOut(options: UseResourceDragOutOptions): void {
  const { hostRef, windowId, enabled = true } = options;
  const badgeRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    resource: WorkbenchResourceDragData | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const host = hostRef.current;
    if (!host || typeof document === 'undefined') return;

    const badge = document.createElement('div');
    badge.className = 'wb-files-drag-badge wb-glass wb-glass-highlight';
    badge.setAttribute('data-wb-files-drag-badge', '');
    badge.setAttribute('data-visible', 'false');
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = [
      '<span class="wb-files-drag-badge__glyph"></span>',
      '<span class="wb-files-drag-badge__label"></span>',
    ].join('');
    document.body.appendChild(badge);
    badgeRef.current = badge;

    const glyphEl = badge.querySelector('.wb-files-drag-badge__glyph') as HTMLElement;
    const labelEl = badge.querySelector('.wb-files-drag-badge__label') as HTMLElement;

    const hideBadge = () => {
      badge.setAttribute('data-visible', 'false');
      badge.setAttribute('aria-hidden', 'true');
    };

    const showBadge = (resource: WorkbenchResourceDragData, x: number, y: number) => {
      glyphEl.textContent = glyphForType(resource.resourceType);
      labelEl.textContent = resource.title;
      badge.style.left = `${x}px`;
      badge.style.top = `${y}px`;
      badge.setAttribute('data-visible', 'true');
      badge.setAttribute('aria-hidden', 'false');
    };

    const moveBadge = (x: number, y: number) => {
      badge.style.left = `${x}px`;
      badge.style.top = `${y}px`;
    };

    const endSession = () => {
      sessionRef.current = null;
      hideBadge();
    };

    const resolveResource = (itemId: string): WorkbenchResourceDragData | null => {
      const item = useFinderStore.getState().items.find((n) => n.id === itemId);
      // 文件夹也允许拖出：桌面图标层的 drop handler 会创建文件夹快捷方式；
      // 未注册 handler 时 bridge 对 folder 无法开窗，安全 no-op
      if (!item) return null;
      return normalizeWorkbenchResourceDragData({
        resourceId: item.id,
        resourceType: item.type,
        title: item.name,
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      // Native desktop drag-out has no touch drop target. Let touch/pen keep
      // their long-press, selection and vertical-scroll semantics.
      if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const itemEl = target.closest('[data-finder-item]') as HTMLElement | null;
      if (!itemEl || !host.contains(itemEl)) return;
      const itemId = itemEl.getAttribute('data-item-id');
      if (!itemId) return;
      const resource = resolveResource(itemId);
      if (!resource) return;

      sessionRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        resource,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;

      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (!session.active) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        session.active = true;
      }

      const point = resolveWorkbenchDesktopDropPoint(event.clientX, event.clientY);
      if (point && session.resource) {
        showBadge(session.resource, event.clientX, event.clientY);
      } else {
        hideBadge();
      }
      if (badge.getAttribute('data-visible') === 'true') {
        moveBadge(event.clientX, event.clientY);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;

      const point = session.active
        ? resolveWorkbenchDesktopDropPoint(event.clientX, event.clientY)
        : null;
      const resource = session.resource;
      endSession();

      if (point && resource) {
        void handleDesktopResourceDrop({
          resource,
          point,
          sourceWindowId: windowId ?? null,
        }).catch((error) => {
          console.error('[workbench:drop] pointer resource drop failed', error);
        });
      }
    };

    const onPointerCancel = (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      endSession();
    };

    host.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);

    return () => {
      host.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      badge.remove();
      badgeRef.current = null;
      sessionRef.current = null;
    };
  }, [enabled, hostRef, windowId]);
}
