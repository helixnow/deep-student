/**
 * 断言模块
 * 用于验证 UI 状态和行为
 */

import type { Assertion, AssertionType } from '../types';
import { storeDebugger } from './storeDebugger';

// 生成唯一 ID
const generateId = () => `assert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

/**
 * 执行断言检查
 */
export function check(type: AssertionType, selector?: string, expected?: unknown): Assertion {
  const startTime = performance.now();
  const assertion: Assertion = {
    id: generateId(),
    type,
    selector,
    expected,
    actual: undefined,
    passed: false,
    message: '',
    timestamp: Date.now(),
  };
  
  try {
    switch (type) {
      case 'element-exists': {
        if (!selector) throw new Error('Selector required');
        const element = document.querySelector(selector);
        assertion.actual = element !== null;
        assertion.passed = assertion.actual === true;
        assertion.message = assertion.passed
          ? `Element "${selector}" exists`
          : `Element "${selector}" not found`;
        break;
      }
      
      case 'element-not-exists': {
        if (!selector) throw new Error('Selector required');
        const element = document.querySelector(selector);
        assertion.actual = element === null;
        assertion.passed = assertion.actual === true;
        assertion.message = assertion.passed
          ? `Element "${selector}" does not exist`
          : `Element "${selector}" unexpectedly exists`;
        break;
      }
      
      case 'element-visible': {
        if (!selector) throw new Error('Selector required');
        const element = document.querySelector(selector);
        if (!element) {
          assertion.actual = false;
          assertion.passed = false;
          assertion.message = `Element "${selector}" not found`;
        } else {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const isVisible = 
            rect.width > 0 && 
            rect.height > 0 && 
            style.visibility !== 'hidden' && 
            style.display !== 'none' &&
            parseFloat(style.opacity) > 0;
          assertion.actual = isVisible;
          assertion.passed = isVisible;
          assertion.message = assertion.passed
            ? `Element "${selector}" is visible`
            : `Element "${selector}" is not visible`;
        }
        break;
      }
      
      case 'element-hidden': {
        if (!selector) throw new Error('Selector required');
        const element = document.querySelector(selector);
        if (!element) {
          assertion.actual = true;
          assertion.passed = true;
          assertion.message = `Element "${selector}" not found (considered hidden)`;
        } else {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const isHidden = 
            rect.width === 0 || 
            rect.height === 0 || 
            style.visibility === 'hidden' || 
            style.display === 'none' ||
            parseFloat(style.opacity) === 0;
          assertion.actual = isHidden;
          assertion.passed = isHidden;
          assertion.message = assertion.passed
            ? `Element "${selector}" is hidden`
            : `Element "${selector}" is not hidden`;
        }
        break;
      }
      
      case 'text-contains': {
        if (!selector) throw new Error('Selector required');
        const element = document.querySelector(selector);
        if (!element) {
          assertion.actual = null;
          assertion.passed = false;
          assertion.message = `Element "${selector}" not found`;
        } else {
          const text = element.textContent || '';
          assertion.actual = text;
          assertion.passed = text.includes(String(expected));
          assertion.message = assertion.passed
            ? `Element contains "${expected}"`
            : `Element text "${text.substring(0, 100)}" does not contain "${expected}"`;
        }
        break;
      }
      
      case 'text-equals': {
        if (!selector) throw new Error('Selector required');
        const element = document.querySelector(selector);
        if (!element) {
          assertion.actual = null;
          assertion.passed = false;
          assertion.message = `Element "${selector}" not found`;
        } else {
          const text = element.textContent?.trim() || '';
          assertion.actual = text;
          assertion.passed = text === String(expected);
          assertion.message = assertion.passed
            ? `Element text equals "${expected}"`
            : `Element text "${text}" does not equal "${expected}"`;
        }
        break;
      }
      
      case 'attribute-equals': {
        if (!selector) throw new Error('Selector required');
        const element = document.querySelector(selector);
        if (!element) {
          assertion.actual = null;
          assertion.passed = false;
          assertion.message = `Element "${selector}" not found`;
        } else if (typeof expected !== 'object' || !expected) {
          assertion.passed = false;
          assertion.message = 'Expected must be { attr: "name", value: "expected" }';
        } else {
          const { attr, value } = expected as { attr: string; value: string };
          const actual = element.getAttribute(attr);
          assertion.actual = actual;
          assertion.passed = actual === value;
          assertion.message = assertion.passed
            ? `Attribute "${attr}" equals "${value}"`
            : `Attribute "${attr}" is "${actual}", expected "${value}"`;
        }
        break;
      }
      
      case 'class-contains': {
        if (!selector) throw new Error('Selector required');
        const element = document.querySelector(selector);
        if (!element) {
          assertion.actual = null;
          assertion.passed = false;
          assertion.message = `Element "${selector}" not found`;
        } else {
          const hasClass = element.classList.contains(String(expected));
          assertion.actual = Array.from(element.classList);
          assertion.passed = hasClass;
          assertion.message = assertion.passed
            ? `Element has class "${expected}"`
            : `Element does not have class "${expected}"`;
        }
        break;
      }
      
      case 'state-equals': {
        if (typeof expected !== 'object' || !expected) {
          assertion.passed = false;
          assertion.message = 'Expected must be { storeName: "name", path: "path.to.value", value: expected }';
        } else {
          const { storeName, path, value } = expected as { storeName: string; path: string; value: unknown };
          const snapshots = storeDebugger.snapshot(storeName);
          if (snapshots.length === 0) {
            assertion.actual = null;
            assertion.passed = false;
            assertion.message = `Store "${storeName}" not found`;
          } else {
            const state = snapshots[0].state as Record<string, unknown>;
            const pathParts = path.split('.');
            let current: unknown = state;
            for (const part of pathParts) {
              if (current && typeof current === 'object' && part in current) {
                current = (current as Record<string, unknown>)[part];
              } else {
                current = undefined;
                break;
              }
            }
            assertion.actual = current;
            assertion.passed = JSON.stringify(current) === JSON.stringify(value);
            assertion.message = assertion.passed
              ? `State "${path}" equals expected value`
              : `State "${path}" is ${JSON.stringify(current)}, expected ${JSON.stringify(value)}`;
          }
        }
        break;
      }
      
      case 'state-matches': {
        if (typeof expected !== 'object' || !expected) {
          assertion.passed = false;
          assertion.message = 'Expected must be { storeName: "name", path: "path.to.value", pattern: "regex" }';
        } else {
          const { storeName, path, pattern } = expected as { storeName: string; path: string; pattern: string };
          const snapshots = storeDebugger.snapshot(storeName);
          if (snapshots.length === 0) {
            assertion.actual = null;
            assertion.passed = false;
            assertion.message = `Store "${storeName}" not found`;
          } else {
            const state = snapshots[0].state as Record<string, unknown>;
            const pathParts = path.split('.');
            let current: unknown = state;
            for (const part of pathParts) {
              if (current && typeof current === 'object' && part in current) {
                current = (current as Record<string, unknown>)[part];
              } else {
                current = undefined;
                break;
              }
            }
            assertion.actual = current;
            const regex = new RegExp(pattern);
            assertion.passed = regex.test(String(current));
            assertion.message = assertion.passed
              ? `State "${path}" matches pattern "${pattern}"`
              : `State "${path}" value "${current}" does not match pattern "${pattern}"`;
          }
        }
        break;
      }
      
      case 'count-equals': {
        if (!selector) throw new Error('Selector required');
        const elements = document.querySelectorAll(selector);
        assertion.actual = elements.length;
        assertion.passed = elements.length === Number(expected);
        assertion.message = assertion.passed
          ? `Found ${expected} elements matching "${selector}"`
          : `Found ${elements.length} elements, expected ${expected}`;
        break;
      }
      
      case 'custom': {
        if (typeof expected === 'function') {
          try {
            const result = expected();
            assertion.actual = result;
            assertion.passed = !!result;
            assertion.message = assertion.passed ? 'Custom assertion passed' : 'Custom assertion failed';
          } catch (e: unknown) {
            assertion.actual = null;
            assertion.passed = false;
            assertion.message = `Custom assertion threw: ${e instanceof Error ? e.message : String(e)}`;
          }
        } else {
          assertion.passed = false;
          assertion.message = 'Expected must be a function for custom assertion';
        }
        break;
      }
      
      default:
        assertion.passed = false;
        assertion.message = `Unknown assertion type: ${type}`;
    }
  } catch (e: unknown) {
    assertion.passed = false;
    assertion.message = `Assertion error: ${e instanceof Error ? e.message : String(e)}`;
  }
  
  assertion.duration = performance.now() - startTime;
  
  // 触发事件
  window.dispatchEvent(new CustomEvent('mcp-debug:assertion', { detail: assertion }));
  
  return assertion;
}

/**
 * 批量执行断言
 */
export function batch(assertions: Array<{ type: AssertionType; selector?: string; expected: unknown }>): Assertion[] {
  return assertions.map(a => check(a.type, a.selector, a.expected));
}

/**
 * 等待条件满足后执行断言
 */
export async function waitFor(
  type: AssertionType,
  selector?: string,
  expected?: unknown,
  options?: { timeout?: number; interval?: number }
): Promise<Assertion> {
  const timeout = options?.timeout ?? 5000;
  const interval = options?.interval ?? 100;
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const result = check(type, selector, expected);
    if (result.passed) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  // 最后一次检查
  const finalResult = check(type, selector, expected);
  finalResult.message = `Timeout after ${timeout}ms: ${finalResult.message}`;
  return finalResult;
}

export const asserter = {
  check,
  batch,
  waitFor,
};

export default asserter;
