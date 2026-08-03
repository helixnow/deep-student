/**
 * 对话框焦点管理：打开时聚焦、Tab 圈定、关闭时还焦
 */

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.getClientRects().length > 0);
}

/**
 * 返回的 ref 挂在对话框内容内任意稳定元素上，通过 closest('[role="dialog"]')
 * 找到实际的对话框容器。
 */
export function useDialogFocusManagement(open: boolean) {
  const scopeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    let dialogEl: HTMLElement | null = null;

    const raf = requestAnimationFrame(() => {
      dialogEl =
        (scopeRef.current?.closest('[role="dialog"], [role="alertdialog"]') as HTMLElement | null) ??
        scopeRef.current;
      if (!dialogEl) return;
      if (!dialogEl.contains(document.activeElement)) {
        const target =
          dialogEl.querySelector<HTMLElement>('[data-autofocus]') ??
          getFocusable(dialogEl)[0] ??
          dialogEl;
        target.focus?.();
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialogEl) return;
      const focusables = getFocusable(dialogEl);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? dialogEl.contains(active) : false;
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus?.();
      }
    };
  }, [open]);

  return scopeRef;
}
