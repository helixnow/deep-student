/**
 * 操作录制模块
 * 录制用户操作并支持回放
 */

import type { RecordedAction, ActionRecorderState, ActionType } from '../types';

// 生成唯一 ID
const generateId = () => `act_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// 模块状态
const state: ActionRecorderState = {
  recording: false,
  actions: [],
  startTime: undefined,
  maxActions: 1000,
};

// 事件监听器引用
const listeners: Map<string, EventListener> = new Map();

/**
 * 生成元素的唯一选择器
 */
function generateSelector(element: Element): string {
  // 优先使用 data-testid
  const testId = element.getAttribute('data-testid');
  if (testId) {
    return `[data-testid="${testId}"]`;
  }
  
  // 使用 id
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }
  
  // 使用 aria-label
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    return `[aria-label="${CSS.escape(ariaLabel)}"]`;
  }
  
  // 使用类名组合
  if (element.className && typeof element.className === 'string') {
    const classes = element.className.split(' ').filter(c => c && !c.includes(':'));
    if (classes.length > 0 && classes.length <= 3) {
      const selector = `${element.tagName.toLowerCase()}.${classes.slice(0, 3).map(c => CSS.escape(c)).join('.')}`;
      // 验证选择器唯一性
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    }
  }
  
  // 使用 nth-child 路径
  const path: string[] = [];
  let current: Element | null = element;
  
  while (current && current !== document.body && path.length < 5) {
    let selector = current.tagName.toLowerCase();
    
    if (current.id) {
      selector = `#${CSS.escape(current.id)}`;
      path.unshift(selector);
      break;
    }
    
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }
    
    path.unshift(selector);
    current = parent;
  }
  
  return path.join(' > ');
}

/**
 * 获取元素信息
 */
function getTargetInfo(element: Element) {
  const attributes: Record<string, string> = {};
  for (const attr of element.attributes) {
    if (['id', 'class', 'name', 'type', 'placeholder', 'aria-label', 'data-testid', 'role'].includes(attr.name)) {
      attributes[attr.name] = attr.value;
    }
  }
  
  return {
    selector: generateSelector(element),
    tagName: element.tagName.toLowerCase(),
    id: element.id || undefined,
    className: element.className && typeof element.className === 'string' ? element.className : undefined,
    textContent: element.textContent?.trim().substring(0, 100) || undefined,
    attributes,
  };
}

/**
 * 添加操作记录
 */
function addAction(action: Omit<RecordedAction, 'id'>) {
  if (!state.recording) return;
  
  const recordedAction: RecordedAction = {
    ...action,
    id: generateId(),
  };
  
  state.actions.push(recordedAction);
  
  // 限制最大数量
  while (state.actions.length > state.maxActions) {
    state.actions.shift();
  }
  
  // 触发事件通知
  window.dispatchEvent(new CustomEvent('mcp-debug:action', { detail: recordedAction }));
}

/**
 * 处理点击事件
 */
function handleClick(event: MouseEvent) {
  const target = event.target as Element;
  if (!target) return;
  
  addAction({
    type: event.detail === 2 ? 'dblclick' : 'click',
    timestamp: Date.now(),
    target: getTargetInfo(target),
    data: {
      x: event.clientX,
      y: event.clientY,
      modifiers: {
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      },
    },
  });
}

/**
 * 处理输入事件
 */
function handleInput(event: Event) {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  if (!target) return;
  
  addAction({
    type: 'input',
    timestamp: Date.now(),
    target: getTargetInfo(target),
    data: {
      value: target.value,
    },
  });
}

/**
 * 处理键盘事件
 */
function handleKeydown(event: KeyboardEvent) {
  // 只记录特殊按键（Enter、Escape、Tab 等）
  const specialKeys = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  if (!specialKeys.includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return;
  }
  
  const target = event.target as Element;
  if (!target) return;
  
  addAction({
    type: 'keydown',
    timestamp: Date.now(),
    target: getTargetInfo(target),
    data: {
      key: event.key,
      keyCode: event.keyCode,
      modifiers: {
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      },
    },
  });
}

/**
 * 处理滚动事件（节流）
 */
let scrollTimeout: number | null = null;
function handleScroll(event: Event) {
  if (scrollTimeout) return;
  
  scrollTimeout = window.setTimeout(() => {
    scrollTimeout = null;
    
    const target = event.target as Element;
    if (!target) return;
    
  const isDocument = target === document.documentElement || (target as unknown) === document;
  addAction({
    type: 'scroll',
    timestamp: Date.now(),
    target: getTargetInfo(isDocument ? document.documentElement : target),
    data: {
      scrollX: isDocument ? window.scrollX : target.scrollLeft,
      scrollY: isDocument ? window.scrollY : target.scrollTop,
    },
  });
  }, 200);
}

/**
 * 处理焦点事件
 */
function handleFocus(event: FocusEvent) {
  const target = event.target as Element;
  if (!target) return;
  
  addAction({
    type: 'focus',
    timestamp: Date.now(),
    target: getTargetInfo(target),
  });
}

/**
 * 处理表单提交
 */
function handleSubmit(event: Event) {
  const target = event.target as Element;
  if (!target) return;
  
  addAction({
    type: 'submit',
    timestamp: Date.now(),
    target: getTargetInfo(target),
  });
}

/**
 * 处理导航变化
 */
function handleNavigation() {
  addAction({
    type: 'navigate',
    timestamp: Date.now(),
    target: {
      selector: 'window',
      tagName: 'window',
    },
    data: {
      url: window.location.href,
    },
  });
}

/**
 * 开始录制
 */
export function start() {
  if (state.recording) return;
  
  state.recording = true;
  state.startTime = Date.now();
  state.actions = [];
  
  // 添加事件监听器
  const clickHandler = handleClick as EventListener;
  const inputHandler = handleInput as EventListener;
  const keydownHandler = handleKeydown as EventListener;
  const scrollHandler = handleScroll as EventListener;
  const focusHandler = handleFocus as EventListener;
  const submitHandler = handleSubmit as EventListener;
  
  document.addEventListener('click', clickHandler, true);
  document.addEventListener('input', inputHandler, true);
  document.addEventListener('keydown', keydownHandler, true);
  document.addEventListener('scroll', scrollHandler, true);
  document.addEventListener('focus', focusHandler, true);
  document.addEventListener('submit', submitHandler, true);
  
  listeners.set('click', clickHandler);
  listeners.set('input', inputHandler);
  listeners.set('keydown', keydownHandler);
  listeners.set('scroll', scrollHandler);
  listeners.set('focus', focusHandler);
  listeners.set('submit', submitHandler);
  
  // 监听导航变化
  window.addEventListener('popstate', handleNavigation);
  listeners.set('popstate', handleNavigation as EventListener);
  
  // 记录初始导航
  handleNavigation();
  
  console.log('[MCP-Debug] Action recording started');
}

/**
 * 停止录制
 */
export function stop(): RecordedAction[] {
  if (!state.recording) return state.actions;
  
  state.recording = false;
  
  // 移除事件监听器
  for (const [eventType, handler] of listeners) {
    if (eventType === 'popstate') {
      window.removeEventListener(eventType, handler);
    } else {
      document.removeEventListener(eventType, handler, true);
    }
  }
  listeners.clear();
  
  console.log(`[MCP-Debug] Action recording stopped. ${state.actions.length} actions recorded.`);
  
  return [...state.actions];
}

/**
 * 获取录制的操作
 */
export function get(): RecordedAction[] {
  return [...state.actions];
}

/**
 * 清除录制
 */
export function clear() {
  state.actions = [];
  state.startTime = undefined;
}

/**
 * 回放操作
 */
export async function replay(actions: RecordedAction[], speed: number = 1): Promise<void> {
  console.log(`[MCP-Debug] Replaying ${actions.length} actions at ${speed}x speed`);
  
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const nextAction = actions[i + 1];
    
    try {
      await executeAction(action);
      
      // 计算延迟
      if (nextAction) {
        const delay = (nextAction.timestamp - action.timestamp) / speed;
        if (delay > 0 && delay < 10000) {
          await new Promise(resolve => setTimeout(resolve, Math.min(delay, 2000)));
        }
      }
    } catch (err: unknown) {
      console.error(`[MCP-Debug] Failed to replay action:`, action, err);
    }
  }
  
  console.log('[MCP-Debug] Replay completed');
}

/**
 * 执行单个操作
 */
async function executeAction(action: RecordedAction): Promise<void> {
  const element = document.querySelector(action.target.selector);
  
  switch (action.type) {
    case 'click':
    case 'dblclick': {
      if (element) {
        const event = new MouseEvent(action.type, {
          bubbles: true,
          cancelable: true,
          clientX: action.data?.x,
          clientY: action.data?.y,
          ctrlKey: action.data?.modifiers?.ctrl,
          altKey: action.data?.modifiers?.alt,
          shiftKey: action.data?.modifiers?.shift,
          metaKey: action.data?.modifiers?.meta,
        });
        element.dispatchEvent(event);
        
        // 如果是按钮或链接，也触发 click
        if (element instanceof HTMLElement) {
          element.click();
        }
      }
      break;
    }
    
    case 'input': {
      if (element && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        element.value = action.data?.value || '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      break;
    }
    
    case 'keydown': {
      if (element) {
        const event = new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: action.data?.key,
          keyCode: action.data?.keyCode,
          ctrlKey: action.data?.modifiers?.ctrl,
          altKey: action.data?.modifiers?.alt,
          shiftKey: action.data?.modifiers?.shift,
          metaKey: action.data?.modifiers?.meta,
        });
        element.dispatchEvent(event);
      }
      break;
    }
    
    case 'scroll': {
      if (element) {
        element.scrollTo({
          left: action.data?.scrollX,
          top: action.data?.scrollY,
          behavior: 'smooth',
        });
      } else {
        window.scrollTo({
          left: action.data?.scrollX,
          top: action.data?.scrollY,
          behavior: 'smooth',
        });
      }
      break;
    }
    
    case 'focus': {
      if (element instanceof HTMLElement) {
        element.focus();
      }
      break;
    }
    
    case 'navigate': {
      if (action.data?.url && action.data.url !== window.location.href) {
        window.history.pushState(null, '', action.data.url);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
      break;
    }
  }
}

/**
 * 获取状态
 */
export function getState(): ActionRecorderState {
  return {
    ...state,
    actions: [...state.actions],
  };
}

/**
 * 添加自定义操作
 */
export function addCustomAction(type: ActionType, target: RecordedAction['target'], data?: RecordedAction['data']) {
  addAction({
    type,
    timestamp: Date.now(),
    target,
    data,
  });
}

export const actionRecorder = {
  start,
  stop,
  get,
  clear,
  replay,
  getState,
  addCustomAction,
};

export default actionRecorder;
