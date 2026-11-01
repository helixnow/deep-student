import type React from 'react';

// 桌面壳标题栏热区与工具栏按钮的指针 / 键盘处理（纯函数，无 React 状态）

export const HEADER_HOTZONE_INTERACTIVE_SELECTOR = [
  'button',
  '[role="button"]',
  'a',
  'input',
  'textarea',
  'select',
  'summary',
  '[data-shell-hotzone-ignore="true"]',
].join(', ');
export const HEADER_HOTZONE_DRAG_THRESHOLD = 4;
export const HEADER_HOTZONE_CLICK_ACTIVATION_DELAY_MS = 180;

export function clearHeaderHotzoneActivationTimer(element: HTMLElement) {
  const timerId = element.dataset.shellHotzoneActivationTimer;
  if (!timerId) {
    return;
  }

  window.clearTimeout(Number(timerId));
  delete element.dataset.shellHotzoneActivationTimer;
}

export function shouldIgnoreHeaderHotzoneTarget(target: EventTarget | null, boundary?: Element) {
  if (!(target instanceof Element)) {
    return false;
  }

  const closestInteractiveTarget = target.closest(HEADER_HOTZONE_INTERACTIVE_SELECTOR);
  return closestInteractiveTarget !== null && closestInteractiveTarget !== boundary;
}

export function handleHeaderHotzoneClick(
  event: React.MouseEvent<HTMLElement>,
  activate: () => void,
) {
  const hotzoneElement = event.currentTarget;
  if (hotzoneElement.dataset.shellHotzoneSuppressClick === 'true' || event.detail > 1) {
    clearHeaderHotzoneActivationTimer(hotzoneElement);
    delete hotzoneElement.dataset.shellHotzoneSuppressClick;
    return;
  }

  if (shouldIgnoreHeaderHotzoneTarget(event.target, hotzoneElement)) {
    return;
  }

  clearHeaderHotzoneActivationTimer(hotzoneElement);
  const timerId = window.setTimeout(() => {
    delete hotzoneElement.dataset.shellHotzoneActivationTimer;
    activate();
  }, HEADER_HOTZONE_CLICK_ACTIVATION_DELAY_MS);
  hotzoneElement.dataset.shellHotzoneActivationTimer = String(timerId);
}

export function handleHeaderHotzoneKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  activate: () => void,
) {
  if (shouldIgnoreHeaderHotzoneTarget(event.target, event.currentTarget)) {
    return;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activate();
  }
}

export function handleDesktopToolbarButtonMouseDown(
  event: React.MouseEvent<HTMLElement>,
  onTitlebarDoubleClick: () => void | Promise<void>,
) {
  if (event.button !== 0 || event.detail !== 2) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void onTitlebarDoubleClick();
}

export function handleDesktopToolbarButtonClick(
  event: React.MouseEvent<HTMLElement>,
  activate: () => void,
) {
  event.stopPropagation();

  if (event.detail > 1) {
    return;
  }

  activate();
}
