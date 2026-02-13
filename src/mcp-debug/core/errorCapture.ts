/**
 * 错误捕获模块
 * 捕获 JavaScript 错误、未处理的 Promise 拒绝、React 错误边界
 */

import type { CapturedError, ErrorCaptureState } from '../types';

// 生成唯一 ID
const generateId = () => `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// 模块状态
const state: ErrorCaptureState = {
  enabled: false,
  errors: [],
  maxErrors: 100,
};

// 事件监听器引用（用于移除）
let errorHandler: ((e: ErrorEvent) => void) | null = null;
let rejectionHandler: ((e: PromiseRejectionEvent) => void) | null = null;
let consoleErrorOriginal: typeof console.error | null = null;

/**
 * 添加错误到列表
 */
function addError(error: Omit<CapturedError, 'id'>) {
  if (!state.enabled) return;
  
  const capturedError: CapturedError = {
    ...error,
    id: generateId(),
  };
  
  state.errors.push(capturedError);
  
  // 限制最大数量
  if (state.errors.length > state.maxErrors) {
    state.errors.shift();
  }
  
  // 触发事件通知
  window.dispatchEvent(new CustomEvent('mcp-debug:error', { detail: capturedError }));
}

/**
 * 处理全局错误
 */
function handleError(event: ErrorEvent) {
  addError({
    type: 'error',
    message: event.message,
    stack: event.error?.stack,
    source: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    timestamp: Date.now(),
    url: window.location.href,
  });
}

/**
 * 处理未捕获的 Promise 拒绝
 */
function handleRejection(event: PromiseRejectionEvent) {
  const reason = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason ?? '');
  
  // ★ 2026-02-04: 过滤 Tauri HTTP 插件的已知 bug (fetch_cancel_body)
  if (message.includes('fetch_cancel_body') || message.includes('http.fetch_cancel_body')) {
    return; // 静默忽略此错误
  }
  
  addError({
    type: 'unhandledrejection',
    message,
    stack: reason instanceof Error ? reason.stack : undefined,
    timestamp: Date.now(),
    url: window.location.href,
    metadata: {
      reason: reason instanceof Error ? undefined : reason,
    },
  });
}

/**
 * 拦截 console.error
 */
function interceptConsoleError() {
  if (consoleErrorOriginal) return;
  
  consoleErrorOriginal = console.error;
  console.error = (...args: unknown[]) => {
    // 调用原始方法
    consoleErrorOriginal!.apply(console, args);
    
    // 捕获错误
    const message = args.map(arg => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === 'object') {
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }
      return String(arg);
    }).join(' ');
    
    const errorArg = args.find(arg => arg instanceof Error) as Error | undefined;
    
    addError({
      type: 'console-error',
      message,
      stack: errorArg?.stack,
      timestamp: Date.now(),
      url: window.location.href,
    });
  };
}

/**
 * 恢复 console.error
 */
function restoreConsoleError() {
  if (consoleErrorOriginal) {
    console.error = consoleErrorOriginal;
    consoleErrorOriginal = null;
  }
}

/**
 * 创建 React 错误边界报告器
 * 用于从 React 错误边界中报告错误
 */
export function reportReactError(error: Error, componentStack: string) {
  addError({
    type: 'react-error-boundary',
    message: error.message,
    stack: error.stack,
    componentStack,
    timestamp: Date.now(),
    url: window.location.href,
  });
}

/**
 * 启动错误捕获
 */
export function start() {
  if (state.enabled) return;
  
  state.enabled = true;
  
  // 添加全局错误监听
  errorHandler = handleError;
  window.addEventListener('error', errorHandler);
  
  // 添加 Promise 拒绝监听
  rejectionHandler = handleRejection;
  window.addEventListener('unhandledrejection', rejectionHandler);
  
  // 拦截 console.error
  interceptConsoleError();
  
  console.log('[MCP-Debug] Error capture started');
}

/**
 * 停止错误捕获
 */
export function stop() {
  if (!state.enabled) return;
  
  state.enabled = false;
  
  // 移除全局错误监听
  if (errorHandler) {
    window.removeEventListener('error', errorHandler);
    errorHandler = null;
  }
  
  // 移除 Promise 拒绝监听
  if (rejectionHandler) {
    window.removeEventListener('unhandledrejection', rejectionHandler);
    rejectionHandler = null;
  }
  
  // 恢复 console.error
  restoreConsoleError();
  
  console.log('[MCP-Debug] Error capture stopped');
}

/**
 * 获取捕获的错误
 */
export function get(filter?: string): CapturedError[] {
  if (!filter) return [...state.errors];
  
  const lowerFilter = filter.toLowerCase();
  return state.errors.filter(err => 
    err.message.toLowerCase().includes(lowerFilter) ||
    err.type.includes(lowerFilter) ||
    err.stack?.toLowerCase().includes(lowerFilter)
  );
}

/**
 * 清除错误
 */
export function clear() {
  state.errors = [];
}

/**
 * 获取状态
 */
export function getState(): ErrorCaptureState {
  return { ...state, errors: [...state.errors] };
}

/**
 * 设置最大错误数量
 */
export function setMaxErrors(max: number) {
  state.maxErrors = max;
  while (state.errors.length > max) {
    state.errors.shift();
  }
}

export const errorCapture = {
  start,
  stop,
  get,
  clear,
  getState,
  setMaxErrors,
  reportReactError,
};

export default errorCapture;
