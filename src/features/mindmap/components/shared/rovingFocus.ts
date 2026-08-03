/**
 * 浮层面板内的 roving focus 键盘漫游助手。
 *
 * 对齐 AppMenu 的键盘模型（Arrow / Home / End 在可聚焦项间循环移动），
 * 供 StructureSelector / StylePanel / FormatBar 等锚定 popover 复用，
 * 避免每个面板各写一套且行为不一致。
 */

const DEFAULT_ITEM_SELECTOR =
  'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface RovingKeyDownOptions {
  /** 匹配可漫游项的选择器，默认按钮/输入框/可聚焦元素 */
  itemSelector?: string;
  /** 是否响应 ArrowLeft / ArrowRight（工具条横向漫游），默认 true */
  horizontal?: boolean;
  /** 是否响应 ArrowUp / ArrowDown，默认 true */
  vertical?: boolean;
}

/** 判断元素当前是否可见（display:none / 未挂载的项跳过） */
function isVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el === document.activeElement;
}

/**
 * 面板容器 keydown 处理：方向键 / Home / End 在面板内可聚焦项间循环移动。
 *
 * @returns 是否消费了该按键（调用方可据此决定是否继续冒泡）
 */
export function handleRovingKeyDown(
  container: HTMLElement | null,
  event: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation' | 'target'>,
  options?: RovingKeyDownOptions,
): boolean {
  if (!container) return false;
  const horizontal = options?.horizontal ?? true;
  const vertical = options?.vertical ?? true;

  const forwardKeys: string[] = [];
  const backwardKeys: string[] = [];
  if (vertical) {
    forwardKeys.push('ArrowDown');
    backwardKeys.push('ArrowUp');
  }
  if (horizontal) {
    forwardKeys.push('ArrowRight');
    backwardKeys.push('ArrowLeft');
  }

  const isForward = forwardKeys.includes(event.key);
  const isBackward = backwardKeys.includes(event.key);
  const isHome = event.key === 'Home';
  const isEnd = event.key === 'End';
  if (!isForward && !isBackward && !isHome && !isEnd) return false;

  // 输入框内的左右方向键 / Home / End 保留原生光标语义
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) &&
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || isHome || isEnd)
  ) {
    return false;
  }

  const items = Array.from(
    container.querySelectorAll<HTMLElement>(options?.itemSelector ?? DEFAULT_ITEM_SELECTOR),
  ).filter(isVisible);
  if (items.length === 0) return false;

  event.preventDefault();
  event.stopPropagation();

  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (isHome) next = 0;
  else if (isEnd) next = items.length - 1;
  else if (isForward) next = current < 0 ? 0 : (current + 1) % items.length;
  else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;

  items[next]?.focus({ preventScroll: true });
  return true;
}

/** 打开面板后把焦点移进面板首个可聚焦控件（rAF 等待挂载完成） */
export function focusFirstItem(
  container: HTMLElement | null,
  itemSelector: string = DEFAULT_ITEM_SELECTOR,
): void {
  if (!container) return;
  const first = Array.from(container.querySelectorAll<HTMLElement>(itemSelector)).find(isVisible);
  first?.focus({ preventScroll: true });
}
