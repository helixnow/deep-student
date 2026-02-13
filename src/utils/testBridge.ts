/**
 * 统一TestBridge驱动API
 * 提供稳定的UI自动化操作接口
 */

import { getErrorMessage } from './errorUtils';

// ==================== 类型定义 ====================

export type TestRunId = string;

export type TestLogLevel = 'info' | 'success' | 'warning' | 'error';

export interface TestLog {
  ts: number;
  level: TestLogLevel;
  message: string;
  stepId?: string;
}

export interface WaitOptions {
  timeout?: number;
  interval?: number;
  retries?: number;
  retryDelay?: number;
}

// ==================== TestBridge 类 ====================

export class TestBridge {
  private testRunId: TestRunId | null = null;
  private logs: TestLog[] = [];

  setTestRunId(id: TestRunId) {
    this.testRunId = id;
  }

  log(level: TestLogLevel, message: string, stepId?: string) {
    const log: TestLog = {
      ts: Date.now(),
      level,
      message,
      stepId,
    };
    this.logs.push(log);
    // eslint-disable-next-line no-console
    console.log(`[TestBridge ${this.testRunId || 'unknown'}] ${level.toUpperCase()}: ${message}`);
  }

  getLogs(): TestLog[] {
    return [...this.logs];
  }

  reset() {
    this.logs = [];
    this.testRunId = null;
  }

  // ==================== UI 操作 ====================

  /**
   * 在指定元素中输入文本
   */
  async type(testId: string, text: string, options?: { clearFirst?: boolean; waitAfter?: number }): Promise<void> {
    const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | HTMLTextAreaElement;
    if (!el) {
      throw new Error(`Element with data-testid="${testId}" not found`);
    }
    if (options?.clearFirst) {
      el.value = '';
    }
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    this.log('info', `Typed "${text}" into ${testId}`);
    if (options?.waitAfter) {
      await this.sleep(options.waitAfter);
    }
  }

  /**
   * 点击指定元素
   */
  async click(testId: string, options?: { waitAfter?: number }): Promise<void> {
    const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
    if (!el) {
      throw new Error(`Element with data-testid="${testId}" not found`);
    }
    el.click();
    this.log('info', `Clicked ${testId}`);
    if (options?.waitAfter) {
      await this.sleep(options.waitAfter);
    }
  }

  /**
   * 等待元素出现或事件触发（任一满足即返回）
   * 用于更鲁棒的等待策略
   */
  async waitForElementOrEvent(testId: string, eventName?: string, options?: WaitOptions): Promise<HTMLElement | 'event'> {
    const timeout = options?.timeout || 5000;
    const interval = options?.interval || 100;
    const start = Date.now();
    
    // 事件监听（如果提供了事件名）
    let eventTriggered = false;
    let eventHandler: ((e: Event) => void) | null = null;
    
    if (eventName) {
      eventHandler = () => {
        eventTriggered = true;
      };
      window.addEventListener(eventName, eventHandler);
    }

    while (Date.now() - start < timeout) {
      // 检查事件是否已触发
      if (eventTriggered) {
        if (eventHandler && eventName) {
          window.removeEventListener(eventName, eventHandler);
        }
        this.log('info', `Event ${eventName} triggered before element ${testId} appeared`);
        return 'event';
      }
      
      // 检查元素是否存在
      const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
      if (el) {
        if (eventHandler && eventName) {
          window.removeEventListener(eventName, eventHandler);
        }
        this.log('info', `Found element ${testId}`);
        return el;
      }
      await this.sleep(interval);
    }
    
    // 清理事件监听器
    if (eventHandler && eventName) {
      window.removeEventListener(eventName, eventHandler);
    }
    
    throw new Error(`Timeout waiting for element ${testId} (${timeout}ms)`);
  }

  /**
   * 等待元素出现
   */
  async waitForElement(testId: string, options?: WaitOptions): Promise<HTMLElement> {
    const result = await this.waitForElementOrEvent(testId, undefined, options);
    if (result === 'event') {
      throw new Error(`Unexpected event result for waitForElement(${testId})`);
    }
    return result;
  }

  /**
   * 等待元素出现（旧API兼容，返回void）
   */
  async waitForElementVoid(testId: string, timeout?: number): Promise<void> {
    await this.waitForElement(testId, { timeout });
  }

  /**
   * 等待元素可用（非禁用状态）
   */
  async waitForElementEnabled(testId: string, options?: WaitOptions): Promise<HTMLElement> {
    const timeout = options?.timeout || 5000;
    const interval = options?.interval || 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      if (el) {
        const isDisabled = (el as HTMLButtonElement).disabled ?? (el as HTMLInputElement).disabled ?? false;
        if (!isDisabled) {
          this.log('info', `Element ${testId} is enabled`);
          return el;
        }
      }
      await this.sleep(interval);
    }
    throw new Error(`Timeout waiting for element ${testId} to be enabled (${timeout}ms)`);
  }

  /**
   * 等待元素消失
   */
  async waitForElementDisappear(testId: string, options?: WaitOptions): Promise<void> {
    const timeout = options?.timeout || 5000;
    const interval = options?.interval || 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      if (!el) {
        this.log('info', `Element ${testId} disappeared`);
        return;
      }
      await this.sleep(interval);
    }
    throw new Error(`Timeout waiting for element ${testId} to disappear (${timeout}ms)`);
  }

  /**
   * 等待事件触发
   */
  async waitForEvent(
    eventName: string,
    filter?: (detail: any) => boolean,
    options?: WaitOptions
  ): Promise<any> {
    const timeout = options?.timeout || 10000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener(eventName, handler);
        reject(new Error(`Timeout waiting for event ${eventName} (${timeout}ms)`));
      }, timeout);

      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (!filter || filter(detail)) {
          clearTimeout(timer);
          window.removeEventListener(eventName, handler);
          this.log('info', `Received event ${eventName}`);
          resolve(detail);
        }
      };

      window.addEventListener(eventName, handler);
    });
  }

  /**
   * 等待消息稳定ID出现（用于消息渲染完成）
   */
  async waitForMessageStableId(stableId: string, options?: WaitOptions): Promise<void> {
    const timeout = options?.timeout || 10000;
    const interval = options?.interval || 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      // 兼容两种选择器：
      // 1) 精确 data-testid="chat-message"（早期实现）
      // 2) 当前位置索引形式 data-testid="chat-message-<index>"（现行实现）
      const msgEl = document.querySelector(`[data-stable-id="${stableId}"]`);
      if (msgEl) {
        this.log('info', `Found message with stable_id ${stableId}`);
        return;
      }
      await this.sleep(interval);
    }
    throw new Error(`Timeout waiting for message stable_id ${stableId} (${timeout}ms)`);
  }

  /**
   * 导航到指定视图
   */
  async navigate(view: string, options?: { waitAfter?: number }): Promise<void> {
    const navBtn = document.querySelector(`[data-testid="nav-${view}"]`) as HTMLElement | null;
    if (navBtn) {
      navBtn.click();
      this.log('info', `Navigated to ${view} via nav button`);
    } else {
      // 兜底：派发通用导航事件，由 App 统一处理
      try {
        window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW' as any, { detail: { view } } as any));
        this.log('warning', `Nav button missing for "${view}", dispatched NAVIGATE_TO_VIEW event`);
      } catch (err: unknown) {
        this.log('error', `Failed to dispatch NAVIGATE_TO_VIEW: ${String(err)}`);
        throw new Error(`Navigation button for view "${view}" not found and event dispatch failed`);
      }
    }
    if (options?.waitAfter) {
      await this.sleep(options.waitAfter);
    } else {
      await this.sleep(500); // 默认等待500ms让导航完成
    }
  }

  /**
   * 选择错题（通过data-id）
   */
  async selectMistake(mistakeId: string, options?: { waitAfter?: number }): Promise<void> {
    const item = document.querySelector(`[data-id="${mistakeId}"]`) as HTMLElement;
    if (!item) {
      throw new Error(`Mistake item with id "${mistakeId}" not found`);
    }
    item.click();
    this.log('info', `Selected mistake ${mistakeId}`);
    if (options?.waitAfter) {
      await this.sleep(options.waitAfter);
    } else {
      await this.sleep(300);
    }
  }

  /**
   * 切换面板（如RAG面板、MCP面板等）
   */
  async togglePanel(panelName: string): Promise<void> {
    // 假设面板切换按钮有特定的testid格式
    const btn = document.querySelector(`[data-testid="toggle-${panelName}-panel"]`) as HTMLElement;
    if (!btn) {
      throw new Error(`Panel toggle button for "${panelName}" not found`);
    }
    btn.click();
    this.log('info', `Toggled panel ${panelName}`);
    await this.sleep(300);
  }

  /**
   * 滚动到指定元素
   */
  async scrollToElement(testId: string, options?: { behavior?: ScrollBehavior }): Promise<void> {
    const el = await this.waitForElement(testId);
    el.scrollIntoView({ behavior: options?.behavior || 'smooth', block: 'center' });
    this.log('info', `Scrolled to element ${testId}`);
    await this.sleep(300); // 等待滚动完成
  }

  /**
   * 获取元素文本内容
   */
  async getElementText(testId: string): Promise<string> {
    const el = await this.waitForElement(testId);
    return el.textContent || '';
  }

  /**
   * 断言元素存在
   */
  async assertElementExists(testId: string, message?: string): Promise<void> {
    try {
      await this.waitForElement(testId, { timeout: 2000 });
      this.log('success', `Assertion passed: element ${testId} exists`);
    } catch (error: unknown) {
      const errorMsg = message || `Element ${testId} does not exist`;
      this.log('error', errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * 断言元素文本内容
   */
  async assertElementText(testId: string, expectedText: string, message?: string): Promise<void> {
    const actualText = await this.getElementText(testId);
    if (actualText.includes(expectedText)) {
      this.log('success', `Assertion passed: element ${testId} contains "${expectedText}"`);
    } else {
      const errorMsg = message || `Element ${testId} text mismatch. Expected: "${expectedText}", Actual: "${actualText}"`;
      this.log('error', errorMsg);
      throw new Error(errorMsg);
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 延迟执行
   */
  async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 带重试的执行
   */
  async retry<T>(
    fn: () => Promise<T>,
    options?: { retries?: number; retryDelay?: number; onRetry?: (error: Error, attempt: number) => void }
  ): Promise<T> {
    const retries = options?.retries || 3;
    const retryDelay = options?.retryDelay || 1000;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retries) {
          this.log('warning', `Attempt ${attempt} failed, retrying... (${getErrorMessage(lastError)})`);
          if (options?.onRetry) {
            options.onRetry(lastError, attempt);
          }
          await this.sleep(retryDelay * attempt); // 指数退避
        }
      }
    }

    throw lastError || new Error('Retry failed');
  }
}

// ==================== 导出单例 ====================

export const testBridge = new TestBridge();

