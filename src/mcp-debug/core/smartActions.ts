/**
 * 智能操作模块
 * 为 AI 自动调试提供稳定的元素定位和操作
 */

// ============================================================================
// 等待功能
// ============================================================================

export interface WaitOptions {
  timeout?: number;      // 超时时间（ms），默认 5000
  interval?: number;     // 轮询间隔（ms），默认 100
  visible?: boolean;     // 是否要求可见
  enabled?: boolean;     // 是否要求启用
}

/**
 * 等待元素出现
 * 注意：返回结果不包含 DOM 元素引用，以便于 JSON 序列化
 */
export async function waitForElement(
  selector: string,
  options: WaitOptions = {}
): Promise<{ found: boolean; selector?: string; elapsed: number; error?: string }> {
  const { timeout = 5000, interval = 100, visible = true, enabled = false } = options;
  const start = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      const el = document.querySelector(selector);
      const elapsed = Date.now() - start;

      if (el) {
        // 检查可见性
        if (visible) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const isVisible = rect.width > 0 && rect.height > 0 &&
            style.visibility !== 'hidden' && style.display !== 'none';
          if (!isVisible) {
            if (elapsed >= timeout) {
              resolve({ found: false, elapsed, error: 'Element exists but not visible' });
              return;
            }
            setTimeout(check, interval);
            return;
          }
        }

        // 检查启用状态
        if (enabled && el instanceof HTMLElement) {
          const isDisabled = (el as any).disabled === true ||
            el.getAttribute('aria-disabled') === 'true';
          if (isDisabled) {
            if (elapsed >= timeout) {
              resolve({ found: false, elapsed, error: 'Element exists but disabled' });
              return;
            }
            setTimeout(check, interval);
            return;
          }
        }

        // 返回选择器而非 DOM 元素，避免序列化问题
        resolve({ found: true, selector, elapsed });
        return;
      }

      if (elapsed >= timeout) {
        resolve({ found: false, elapsed, error: `Element not found: ${selector}` });
        return;
      }

      setTimeout(check, interval);
    };

    check();
  });
}

/**
 * 等待条件满足
 */
export async function waitForCondition(
  conditionFn: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<{ success: boolean; elapsed: number; error?: string }> {
  const { timeout = 5000, interval = 100 } = options;
  const start = Date.now();

  return new Promise((resolve) => {
    const check = async () => {
      const elapsed = Date.now() - start;
      try {
        const result = await conditionFn();
        if (result) {
          resolve({ success: true, elapsed });
          return;
        }
      } catch (e: unknown) {
        // 条件检查出错，继续重试
      }

      if (elapsed >= timeout) {
        resolve({ success: false, elapsed, error: 'Condition not met within timeout' });
        return;
      }

      setTimeout(check, interval);
    };

    check();
  });
}

/**
 * 等待文本出现在页面上
 * 注意：返回结果不包含 DOM 元素引用，以便于 JSON 序列化
 */
export async function waitForText(
  text: string,
  options: WaitOptions & { exact?: boolean } = {}
): Promise<{ found: boolean; text?: string; elapsed: number; error?: string }> {
  const { timeout = 5000, interval = 100, exact = false, visible = true } = options;
  const start = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - start;
      
      // 使用 TreeWalker 遍历文本节点，性能更好
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const content = node.textContent?.trim() || '';
            if (!content) return NodeFilter.FILTER_REJECT;
            const matches = exact ? content === text : content.includes(text);
            return matches ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        }
      );
      
      const textNode = walker.nextNode();
      if (textNode && textNode.parentElement) {
        if (visible && !isVisible(textNode.parentElement)) {
          if (elapsed >= timeout) {
            resolve({ found: false, elapsed, error: `Text found but not visible: "${text}"` });
            return;
          }
          setTimeout(check, interval);
          return;
        }
        // 返回文本而非 DOM 元素，避免序列化问题
        resolve({ found: true, text, elapsed });
        return;
      }

      if (elapsed >= timeout) {
        resolve({ found: false, elapsed, error: `Text not found: "${text}"` });
        return;
      }

      setTimeout(check, interval);
    };

    check();
  });
}

/**
 * 元素可见性判断
 */
function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

/**
 * CSS 标识符安全转义
 */
function escapeCssIdentifier(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// ============================================================================
// 智能元素查找
// ============================================================================

export interface FindOptions {
  timeout?: number;
  visible?: boolean;
  nth?: number;        // 第 n 个匹配（从 0 开始）
}

/**
 * 按文本查找元素
 */
export function findByText(
  text: string,
  options: FindOptions & { exact?: boolean; tag?: string } = {}
): Element[] {
  const { exact = false, tag, nth, visible = true } = options;
  const selector = tag || '*';
  const elements = document.querySelectorAll(selector);
  const matches: Element[] = [];

  for (const el of elements) {
    // 只检查叶子节点或直接文本内容
    const directText = getDirectTextContent(el);
    const fullText = el.textContent?.trim() || '';
    
    const textToCheck = directText || fullText;
    const found = exact ? textToCheck === text : textToCheck.includes(text);
    
    if (found) {
      if (visible && !isVisible(el)) {
        continue;
      }
      matches.push(el);
    }
  }

  if (nth !== undefined) {
    return matches[nth] ? [matches[nth]] : [];
  }

  return matches;
}

/**
 * 获取元素的直接文本内容（不包括子元素）
 */
function getDirectTextContent(el: Element): string {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
    }
  }
  return text.trim();
}

/**
 * 按角色查找元素（基于 ARIA role 或隐含角色）
 */
export function findByRole(
  role: string,
  options: FindOptions & { name?: string } = {}
): Element[] {
  const { name, nth, visible = true } = options;
  
  // 角色到标签的映射
  const roleToTags: Record<string, string[]> = {
    button: ['button', '[role="button"]', 'input[type="button"]', 'input[type="submit"]'],
    link: ['a[href]', '[role="link"]'],
    textbox: ['input[type="text"]', 'input:not([type])', 'textarea', '[role="textbox"]', '[contenteditable="true"]'],
    checkbox: ['input[type="checkbox"]', '[role="checkbox"]'],
    radio: ['input[type="radio"]', '[role="radio"]'],
    listbox: ['select', '[role="listbox"]'],
    option: ['option', '[role="option"]'],
    heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]'],
    img: ['img', '[role="img"]'],
    list: ['ul', 'ol', '[role="list"]'],
    listitem: ['li', '[role="listitem"]'],
    dialog: ['dialog', '[role="dialog"]', '[role="alertdialog"]'],
    tab: ['[role="tab"]'],
    tabpanel: ['[role="tabpanel"]'],
    menu: ['[role="menu"]', 'menu'],
    menuitem: ['[role="menuitem"]'],
    navigation: ['nav', '[role="navigation"]'],
    main: ['main', '[role="main"]'],
    search: ['[role="search"]', 'input[type="search"]'],
    form: ['form', '[role="form"]'],
    table: ['table', '[role="table"]'],
    row: ['tr', '[role="row"]'],
    cell: ['td', 'th', '[role="cell"]', '[role="gridcell"]'],
  };

  const selectors = roleToTags[role.toLowerCase()] || [`[role="${role}"]`];
  const combined = selectors.join(', ');
  const elements = document.querySelectorAll(combined);
  
  let matches: Element[] = Array.from(elements);

  // 按名称过滤
  if (name) {
    matches = matches.filter(el => {
      const elName = el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.textContent?.trim() ||
        (el as HTMLInputElement).placeholder ||
        '';
      return elName.includes(name);
    });
  }

  // 过滤可见元素
  if (visible) {
    matches = matches.filter(el => isVisible(el));
  }

  if (nth !== undefined) {
    return matches[nth] ? [matches[nth]] : [];
  }

  return matches;
}

/**
 * CSS 选择器安全转义
 */
function escapeCSSSelector(str: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(str);
  }
  return str.replace(/["\\]/g, '\\$&');
}

/**
 * 按标签查找输入框
 */
export function findByLabel(label: string): Element | null {
  // 方式1: 通过 for 属性关联
  const labels = document.querySelectorAll('label');
  for (const lbl of labels) {
    if (lbl.textContent?.includes(label)) {
      const forId = lbl.getAttribute('for');
      if (forId) {
        const input = document.getElementById(forId);
        if (input) return input;
      }
      // 方式2: label 包裹 input
      const input = lbl.querySelector('input, textarea, select');
      if (input) return input;
    }
  }

  // 方式3: aria-label（安全转义）
  const escapedLabel = escapeCSSSelector(label);
  const ariaLabeled = document.querySelector(`[aria-label*="${escapedLabel}"]`);
  if (ariaLabeled) return ariaLabeled;

  // 方式4: placeholder（安全转义）
  const placeholder = document.querySelector(`input[placeholder*="${escapedLabel}"], textarea[placeholder*="${escapedLabel}"]`);
  if (placeholder) return placeholder;

  return null;
}

// ============================================================================
// 智能操作
// ============================================================================

/**
 * 点击包含特定文本的元素
 * 注意：返回结果不包含 DOM 元素引用，以便于 JSON 序列化
 */
export async function clickText(
  text: string,
  options: FindOptions & { exact?: boolean; tag?: string } = {}
): Promise<{ success: boolean; clickedText?: string; error?: string }> {
  const { timeout = 5000, exact = false, tag } = options;

  // 先查找包含文本的元素
  const start = Date.now();
  let textElement: Element | null = null;
  
  while (Date.now() - start < timeout) {
    const elements = findByText(text, { exact, tag, visible: true });
    if (elements.length > 0) {
      textElement = elements[0];
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  
  if (!textElement) {
    return { success: false, error: `Text "${text}" not found` };
  }

  // 找到可点击的祖先元素
  let clickTarget = textElement;
  const clickableTags = ['BUTTON', 'A', 'INPUT', 'SELECT', 'LABEL'];
  
  let current: Element | null = textElement;
  while (current) {
    if (clickableTags.includes(current.tagName) ||
        current.getAttribute('role') === 'button' ||
        current.getAttribute('onclick') ||
        getComputedStyle(current).cursor === 'pointer') {
      clickTarget = current;
      break;
    }
    current = current.parentElement;
  }

  // 执行点击
  try {
    (clickTarget as HTMLElement).click();
    return { success: true, clickedText: text };
  } catch (e: unknown) {
    return { success: false, error: `Click failed: ${(e as Error).message}` };
  }
}

/**
 * 智能填充输入框
 * 注意：返回结果不包含 DOM 元素引用，以便于 JSON 序列化
 */
export async function fillInput(
  target: string | { label?: string; placeholder?: string; selector?: string },
  value: string,
  options: { timeout?: number; clear?: boolean } = {}
): Promise<{ success: boolean; filledValue?: string; error?: string }> {
  const { timeout = 5000, clear = true } = options;

  let element: Element | null = null;

  // 解析目标
  if (typeof target === 'string') {
    // 尝试多种方式查找
    element = document.querySelector(target) ||
      findByLabel(target) ||
      document.querySelector(`input[placeholder*="${escapeCSSSelector(target)}"]`) ||
      document.querySelector(`textarea[placeholder*="${escapeCSSSelector(target)}"]`);
  } else {
    if (target.selector) {
      element = document.querySelector(target.selector);
    } else if (target.label) {
      element = findByLabel(target.label);
    } else if (target.placeholder) {
      const escaped = escapeCSSSelector(target.placeholder);
      element = document.querySelector(`input[placeholder*="${escaped}"], textarea[placeholder*="${escaped}"]`);
    }
  }

  // 如果没找到，等待
  if (!element) {
    const selector = typeof target === 'string' ? target : (target.selector || `[placeholder*="${target.placeholder || target.label}"]`);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      element = document.querySelector(selector);
      if (element) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (!element) {
    return { success: false, error: `Input not found: ${JSON.stringify(target)}` };
  }

  // 检查是否可编辑
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.disabled || element.readOnly) {
      return { success: false, error: 'Input is disabled or readonly' };
    }

    // 聚焦
    element.focus();

    // 清空
    if (clear) {
      element.value = '';
    }

    // 设置值
    element.value = value;

    // 触发事件
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    return { success: true, filledValue: value };
  }

  // contenteditable 元素
  if (element.getAttribute('contenteditable') === 'true') {
    element.textContent = clear ? value : (element.textContent || '') + value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return { success: true, filledValue: value };
  }

  return { success: false, error: 'Element is not an input field' };
}

/**
 * 获取元素信息
 */
export function getElementInfo(el: Element): {
  tag: string;
  id?: string;
  classes: string[];
  text: string;
  role?: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;
  };
  visible: boolean;
  enabled: boolean;
  selector: string;
} {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);

  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: Array.from(el.classList),
    text: el.textContent?.trim().substring(0, 100) || '',
    role: el.getAttribute('role') || undefined,
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
    },
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
    enabled: !(el as any).disabled,
    selector: generateSelector(el),
  };
}

/**
 * 生成元素的唯一选择器
 */
export function generateSelector(el: Element): string {
  // 1. 优先使用 ID
  if (el.id) {
    return `#${escapeCssIdentifier(el.id)}`;
  }

  // 2. data-testid
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
  if (testId) {
    return `[data-testid="${escapeCSSSelector(testId)}"]`;
  }

  // 3. 唯一的 aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const escapedLabel = escapeCSSSelector(ariaLabel);
    const matches = document.querySelectorAll(`[aria-label="${escapedLabel}"]`);
    if (matches.length === 1) {
      return `[aria-label="${escapedLabel}"]`;
    }
  }

  // 4. 按钮/链接使用 data 属性或唯一类名
  if (el.tagName === 'BUTTON' || el.tagName === 'A') {
    // 尝试使用 name 属性
    const name = el.getAttribute('name');
    if (name) {
      return `${el.tagName.toLowerCase()}[name="${escapeCSSSelector(name)}"]`;
    }
    // 尝试使用 type 属性（对于 button）
    const type = el.getAttribute('type');
    if (type && el.tagName === 'BUTTON') {
      const escapedType = escapeCSSSelector(type);
      const typeMatches = document.querySelectorAll(`button[type="${escapedType}"]`);
      if (typeMatches.length === 1) {
        return `button[type="${escapedType}"]`;
      }
    }
  }

  // 5. 构建路径选择器
  const parts: string[] = [];
  let current: Element | null = el;
  
  while (current && current !== document.body) {
    let part = current.tagName.toLowerCase();
    
    if (current.id) {
      parts.unshift(`#${current.id}`);
      break;
    }
    
    // 添加类名（最多 2 个）
    const classes = Array.from(current.classList)
      .slice(0, 2)
      .filter(c => !c.includes(':'))
      .map(c => escapeCssIdentifier(c));
    if (classes.length > 0) {
      part += '.' + classes.join('.');
    }
    
    // 添加 nth-child 如果有兄弟
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }
    }
    
    parts.unshift(part);
    current = parent;
    
    // 限制深度
    if (parts.length >= 4) break;
  }

  return parts.join(' > ');
}

// ============================================================================
// 导出操作为脚本
// ============================================================================

export interface RecordedAction {
  type: string;
  timestamp: number;
  target: { selector: string; tagName: string };
  data?: any;
}

/**
 * 将录制的操作导出为 Playwright 脚本
 */
export function exportToPlaywright(actions: RecordedAction[]): string {
  const lines: string[] = [
    "import { test, expect } from '@playwright/test';",
    "",
    "test('recorded test', async ({ page }) => {",
    "  // Auto-generated from MCP Debug recording",
    "",
  ];

  for (const action of actions) {
    const { type, target, data } = action;
    const selector = target.selector;

    switch (type) {
      case 'click':
        lines.push(`  await page.click('${selector}');`);
        break;
      case 'input':
        lines.push(`  await page.fill('${selector}', '${data?.value || ''}');`);
        break;
      case 'keydown':
        if (data?.key === 'Enter') {
          lines.push(`  await page.press('${selector}', 'Enter');`);
        }
        break;
      case 'scroll':
        lines.push(`  // Scroll action at (${data?.x}, ${data?.y})`);
        break;
      case 'navigate':
        lines.push(`  await page.goto('${data?.url}');`);
        break;
      default:
        lines.push(`  // ${type} on ${selector}`);
    }
  }

  lines.push("});");
  lines.push("");

  return lines.join('\n');
}

/**
 * 将录制的操作导出为简单的 JS 脚本
 */
export function exportToJS(actions: RecordedAction[]): string {
  const lines: string[] = [
    "// Auto-generated replay script",
    "// Run via: window.__MCP_DEBUG__.smartActions.runScript(script)",
    "",
    "async function replay() {",
  ];

  for (const action of actions) {
    const { type, target, data } = action;
    const selector = JSON.stringify(target.selector);

    switch (type) {
      case 'click':
        lines.push(`  await window.__MCP_DEBUG__.smartActions.clickElement(${selector});`);
        break;
      case 'input':
        lines.push(`  await window.__MCP_DEBUG__.smartActions.fillInput(${selector}, ${JSON.stringify(data?.value || '')});`);
        break;
      case 'navigate':
        lines.push(`  window.location.href = ${JSON.stringify(data?.url)};`);
        break;
      default:
        lines.push(`  // ${type} on ${target.selector}`);
    }
    
    // 添加小延迟
    lines.push(`  await new Promise(r => setTimeout(r, 100));`);
  }

  lines.push("}");
  lines.push("");
  lines.push("replay();");

  return lines.join('\n');
}

/**
 * 点击元素（带等待）
 */
export async function clickElement(
  selector: string,
  options: WaitOptions = {}
): Promise<{ success: boolean; clickedSelector?: string; error?: string }> {
  const waitResult = await waitForElement(selector, { ...options, visible: true, enabled: true });
  
  if (!waitResult.found) {
    return { success: false, error: waitResult.error };
  }

  // 重新获取元素进行点击
  const element = document.querySelector(selector);
  if (!element) {
    return { success: false, error: `Element not found: ${selector}` };
  }

  try {
    (element as HTMLElement).click();
    return { success: true, clickedSelector: selector };
  } catch (e: unknown) {
    return { success: false, error: (e as Error).message };
  }
}

// ============================================================================
// 导出
// ============================================================================

export const smartActions = {
  // 等待
  waitForElement,
  waitForCondition,
  waitForText,
  
  // 查找
  findByText,
  findByRole,
  findByLabel,
  generateSelector,
  getElementInfo,
  
  // 操作
  clickText,
  clickElement,
  fillInput,
  
  // 导出
  exportToPlaywright,
  exportToJS,
};

export default smartActions;
