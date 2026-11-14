/**
 * Crepe 编辑器调试：编辑器一侧的上报入口（经总开关发往面板订阅的 feed）和 DOM 快照采集。
 */

import { debugMasterSwitch } from '../../debugMasterSwitch';
import { createPanelFeed } from '../../panelFeed';
import type { CrepeDebugEventDetail, DOMSnapshot, EditorSnapshot, EventCategory, LogLevel } from './model';

// ============ 事件通道 ============

export const crepeDebugFeed = createPanelFeed<CrepeDebugEventDetail>();

/**
 * 发射 Crepe 调试事件
 */
export const emitCrepeDebug = (
  category: EventCategory,
  level: LogLevel,
  message: string,
  details?: Record<string, any>,
  domSnapshot?: DOMSnapshot,
  editorSnapshot?: EditorSnapshot
) => {
  try {
    // 默认不派发任何调试事件，避免编辑器输入期间产生额外开销（尤其是 IME 合成态）
    if (!debugMasterSwitch.isEnabled()) return;
    crepeDebugFeed.publish({ category, level, message, details, domSnapshot, editorSnapshot });
  } catch (e) {
    console.warn('[CrepeDebug] Event emit failed:', e);
  }
};

/**
 * 捕获 DOM 快照
 */
export const captureDOMSnapshot = (container?: HTMLElement | null): DOMSnapshot => {
  if (!container) {
    // 尝试从 DOM 中查找
    container = document.querySelector('.crepe-editor-wrapper') as HTMLElement | null;
  }
  
  if (!container) {
    return {
      wrapperExists: false,
      dataReady: null,
      milkdownExists: false,
      proseMirrorExists: false,
      contentEditable: null,
      pointerEvents: null,
      opacity: null,
      wrapperClassName: '',
      childCount: 0,
    };
  }

  const milkdown = container.querySelector('.milkdown');
  const proseMirror = container.querySelector('.ProseMirror');
  const computedStyle = window.getComputedStyle(container);

  return {
    wrapperExists: true,
    dataReady: container.getAttribute('data-ready'),
    milkdownExists: !!milkdown,
    proseMirrorExists: !!proseMirror,
    contentEditable: proseMirror?.getAttribute('contenteditable') ?? null,
    pointerEvents: computedStyle.pointerEvents,
    opacity: computedStyle.opacity,
    wrapperClassName: container.className,
    childCount: container.childElementCount,
  };
};
