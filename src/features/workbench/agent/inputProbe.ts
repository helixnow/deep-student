/**
 * ACR 输入探测过滤 — R2-06
 * 滚动 / 标题栏 / AgentStrip 自身不触发 notifyUserInput（DESIGN §4.1）。
 * WindowShell 内容区 capture 监听调用本模块判定。
 */
/** 纯滚动常用键（非可编辑焦点时视为滚动，不算打断） */
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

function isEditableTarget(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(el.closest('[contenteditable="true"]'));
}

/** 标题栏 / AgentStrip：结构上常在内容区外，仍做防御性 closest */
export function isAgentChromeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest('[data-acr-agent-strip]') ||
      target.closest('[data-wb-titlebar]') ||
      target.closest('.wb-titlebar'),
  );
}

/** 非编辑焦点下的滚动键 → 不算用户打断 */
export function isScrollKeyEvent(e: {
  key: string;
  target: EventTarget | null;
}): boolean {
  if (!SCROLL_KEYS.has(e.key)) return false;
  return !isEditableTarget(e.target instanceof Element ? e.target : null);
}

/**
 * pointerdown / keydown 是否应通知仲裁。
 * - 标题栏 / Strip：否
 * - 滚轮：调用方不应绑定；若误传 wheel 则否
 * - 纯滚动键：否
 */
export function shouldNotifyAgentUserInput(
  e: {
    type?: string;
    key?: string;
    target: EventTarget | null;
    button?: number;
  },
): boolean {
  const type = e.type ?? '';
  if (type === 'wheel' || type === 'scroll') return false;
  // 中键常用于自动滚动，不算编辑打断
  if (typeof e.button === 'number' && e.button === 1) return false;
  if (isAgentChromeTarget(e.target)) return false;
  if (typeof e.key === 'string' && isScrollKeyEvent({ key: e.key, target: e.target })) {
    return false;
  }
  return true;
}
