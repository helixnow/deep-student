/**
 * 元素高亮模块
 * 用于在界面上高亮显示元素，辅助调试
 */

import type { HighlightOptions, HighlightedElement } from '../types';

// 生成唯一 ID
const generateId = () => `hl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// 高亮元素列表
const highlightedElements: Map<string, HighlightedElement> = new Map();

// CSS 样式
const HIGHLIGHT_STYLES = `
  .mcp-debug-highlight {
    position: absolute;
    pointer-events: none;
    z-index: 99999;
    box-sizing: border-box;
    transition: all 0.2s ease;
  }
  
  .mcp-debug-highlight-label {
    position: absolute;
    top: -24px;
    left: 0;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 2px 6px;
    font-size: 11px;
    font-family: monospace;
    border-radius: 3px;
    white-space: nowrap;
    z-index: 100000;
  }
  
  .mcp-debug-highlight-pulse {
    animation: mcp-debug-pulse 1.5s ease-in-out infinite;
  }
  
  @keyframes mcp-debug-pulse {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }
`;

// 注入样式
let styleInjected = false;
function injectStyles() {
  if (styleInjected) return;
  
  const style = document.createElement('style');
  style.id = 'mcp-debug-highlight-styles';
  style.textContent = HIGHLIGHT_STYLES;
  document.head.appendChild(style);
  styleInjected = true;
}

/**
 * 创建高亮覆盖层
 */
function createOverlay(element: Element, options: HighlightOptions): HTMLElement {
  injectStyles();
  
  const rect = element.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'mcp-debug-highlight' + (options.pulse ? ' mcp-debug-highlight-pulse' : '');
  
  // 设置位置和大小
  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  
  // 设置样式
  const borderWidth = options.borderWidth ?? 2;
  const color = options.color ?? '#ff0000';
  const backgroundColor = options.backgroundColor ?? `${color}20`;
  
  overlay.style.border = `${borderWidth}px solid ${color}`;
  overlay.style.backgroundColor = backgroundColor;
  overlay.style.borderRadius = getComputedStyle(element).borderRadius;
  
  // 添加标签
  if (options.label) {
    const label = document.createElement('div');
    label.className = 'mcp-debug-highlight-label';
    label.textContent = options.label;
    label.style.backgroundColor = color;
    overlay.appendChild(label);
  }
  
  document.body.appendChild(overlay);
  
  return overlay;
}

/**
 * 更新覆盖层位置
 */
function updateOverlayPosition(id: string) {
  const highlighted = highlightedElements.get(id);
  if (!highlighted || !highlighted.overlayElement) return;
  
  const element = document.querySelector(highlighted.selector);
  if (!element) {
    // 元素不存在，移除高亮
    hide(id);
    return;
  }
  
  const rect = element.getBoundingClientRect();
  highlighted.overlayElement.style.top = `${rect.top + window.scrollY}px`;
  highlighted.overlayElement.style.left = `${rect.left + window.scrollX}px`;
  highlighted.overlayElement.style.width = `${rect.width}px`;
  highlighted.overlayElement.style.height = `${rect.height}px`;
}

// 位置更新定时器
let updateInterval: number | null = null;

/**
 * 启动位置更新
 */
function startPositionUpdate() {
  if (updateInterval) return;
  
  updateInterval = window.setInterval(() => {
    for (const id of highlightedElements.keys()) {
      updateOverlayPosition(id);
    }
  }, 100);
}

/**
 * 停止位置更新
 */
function stopPositionUpdate() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
}

/**
 * 显示高亮
 */
export function show(options: HighlightOptions): string {
  const element = document.querySelector(options.selector);
  if (!element) {
    console.warn(`[MCP-Debug] Element not found: ${options.selector}`);
    return '';
  }
  
  const id = generateId();
  const overlay = createOverlay(element, options);
  
  const highlighted: HighlightedElement = {
    id,
    selector: options.selector,
    options,
    overlayElement: overlay,
    createdAt: Date.now(),
  };
  
  highlightedElements.set(id, highlighted);
  
  // 启动位置更新
  if (highlightedElements.size === 1) {
    startPositionUpdate();
  }
  
  // 设置自动移除
  if (options.duration && options.duration > 0) {
    setTimeout(() => hide(id), options.duration);
  }
  
  console.log(`[MCP-Debug] Highlighted element: ${options.selector} (id: ${id})`);
  
  return id;
}

/**
 * 隐藏高亮
 */
export function hide(id?: string) {
  if (id) {
    const highlighted = highlightedElements.get(id);
    if (highlighted?.overlayElement) {
      highlighted.overlayElement.remove();
    }
    highlightedElements.delete(id);
  } else {
    // 隐藏所有
    for (const highlighted of highlightedElements.values()) {
      if (highlighted.overlayElement) {
        highlighted.overlayElement.remove();
      }
    }
    highlightedElements.clear();
  }
  
  // 停止位置更新
  if (highlightedElements.size === 0) {
    stopPositionUpdate();
  }
}

/**
 * 清除所有高亮
 */
export function clear() {
  hide();
  console.log('[MCP-Debug] All highlights cleared');
}

/**
 * 获取高亮元素列表
 */
export function getHighlighted(): HighlightedElement[] {
  return Array.from(highlightedElements.values()).map(h => ({
    ...h,
    overlayElement: undefined, // 不返回 DOM 元素
  }));
}

/**
 * 根据坐标查找元素并生成选择器建议
 */
export function suggestSelector(x: number, y: number): string[] {
  const element = document.elementFromPoint(x, y);
  if (!element) return [];
  
  const suggestions: string[] = [];
  
  // data-testid
  const testId = element.getAttribute('data-testid');
  if (testId) {
    suggestions.push(`[data-testid="${testId}"]`);
  }
  
  // id
  if (element.id) {
    suggestions.push(`#${CSS.escape(element.id)}`);
  }
  
  // aria-label
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    suggestions.push(`[aria-label="${CSS.escape(ariaLabel)}"]`);
  }
  
  // role + name
  const role = element.getAttribute('role');
  if (role) {
    const name = element.getAttribute('aria-label') || element.textContent?.trim().substring(0, 30);
    if (name) {
      suggestions.push(`[role="${role}"][aria-label="${CSS.escape(name)}"]`);
    } else {
      suggestions.push(`[role="${role}"]`);
    }
  }
  
  // 类名组合
  if (element.className && typeof element.className === 'string') {
    const classes = element.className.split(' ').filter(c => c && !c.includes(':') && c.length < 30);
    if (classes.length > 0) {
      // 使用前几个类名
      const classSelector = `${element.tagName.toLowerCase()}.${classes.slice(0, 2).map(c => CSS.escape(c)).join('.')}`;
      if (document.querySelectorAll(classSelector).length <= 5) {
        suggestions.push(classSelector);
      }
    }
  }
  
  // 标签名 + 文本内容
  const text = element.textContent?.trim().substring(0, 30);
  if (text && text.length > 2) {
    suggestions.push(`${element.tagName.toLowerCase()}:has-text("${text}")`);
  }
  
  // 层级路径
  const path: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && path.length < 4) {
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
  if (path.length > 0) {
    suggestions.push(path.join(' > '));
  }
  
  // 去重并验证
  return [...new Set(suggestions)].filter(selector => {
    try {
      return document.querySelector(selector) !== null;
    } catch {
      return false;
    }
  });
}

/**
 * 验证选择器
 */
export function validateSelector(selector: string): { valid: boolean; count: number; error?: string } {
  try {
    const elements = document.querySelectorAll(selector);
    return {
      valid: elements.length > 0,
      count: elements.length,
    };
  } catch (e: unknown) {
    return {
      valid: false,
      count: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 高亮元素并返回其信息
 */
export function inspect(selector: string): {
  found: boolean;
  highlightId?: string;
  element?: {
    tagName: string;
    id?: string;
    className?: string;
    textContent?: string;
    rect: DOMRect;
    computedStyle: Record<string, string>;
  };
} {
  const element = document.querySelector(selector);
  if (!element) {
    return { found: false };
  }
  
  const highlightId = show({
    selector,
    color: '#3b82f6',
    pulse: true,
    duration: 3000,
    label: selector,
  });
  
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  
  return {
    found: true,
    highlightId,
    element: {
      tagName: element.tagName.toLowerCase(),
      id: element.id || undefined,
      className: element.className && typeof element.className === 'string' ? element.className : undefined,
      textContent: element.textContent?.trim().substring(0, 200) || undefined,
      rect: rect,
      computedStyle: {
        display: style.display,
        position: style.position,
        visibility: style.visibility,
        opacity: style.opacity,
        width: style.width,
        height: style.height,
        backgroundColor: style.backgroundColor,
        color: style.color,
      },
    },
  };
}

export const highlighter = {
  show,
  hide,
  clear,
  getHighlighted,
  suggestSelector,
  validateSelector,
  inspect,
};

export default highlighter;
