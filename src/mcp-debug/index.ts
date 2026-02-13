/**
 * MCP Debug Enhancement Module
 * 
 * 为 Tauri 应用提供全自动调试能力
 * 
 * 功能：
 * - 错误捕获：JavaScript 错误、Promise 拒绝、React 错误边界
 * - 网络监控：Fetch、XHR、WebSocket
 * - 状态调试：Zustand store 快照和变化监控
 * - 操作录制：用户操作录制和回放
 * - 性能监控：内存、FPS、长任务、渲染性能
 * - 元素高亮：视觉调试辅助
 * - 断言验证：UI 状态验证
 * 
 * 使用方式：
 * 1. 在应用入口调用 initMCPDebug()
 * 2. 通过 window.__MCP_DEBUG__ 访问 API
 * 3. 通过 MCP 命令远程控制
 */

import type { MCPDebugAPI, MCPDebugCommand, MCPDebugResponse } from './types';
import { errorCapture, reportReactError } from './core/errorCapture';
import { networkMonitor } from './core/networkMonitor';
import { storeDebugger } from './core/storeDebugger';
import { actionRecorder } from './core/actionRecorder';
import { performanceMonitor } from './core/performanceMonitor';
import { highlighter } from './core/highlighter';
import { asserter } from './core/asserter';
import { smartActions } from './core/smartActions';
import { bridge, handleCommand, getStatus, reset, setupMCPBridge } from './bridge';

const VERSION = '1.0.0';

/**
 * 创建 MCP Debug API
 */
function createMCPDebugAPI(): MCPDebugAPI {
  return {
    version: VERSION,
    getStatus,
    reset,
    
    errorCapture: {
      start: errorCapture.start,
      stop: errorCapture.stop,
      get: errorCapture.get,
      clear: errorCapture.clear,
    },
    
    networkMonitor: {
      start: networkMonitor.start,
      stop: networkMonitor.stop,
      get: networkMonitor.get,
      getWebSocket: networkMonitor.getWebSocket,
      clear: networkMonitor.clear,
    },
    
    storeDebugger: {
      snapshot: storeDebugger.snapshot,
      subscribe: storeDebugger.subscribe,
      unsubscribe: storeDebugger.unsubscribe,
      getChanges: storeDebugger.getChanges,
      clear: storeDebugger.clear,
      getRegisteredStores: storeDebugger.getRegisteredStores,
      registerStore: storeDebugger.registerStore,
    },
    
    actionRecorder: {
      start: actionRecorder.start,
      stop: actionRecorder.stop,
      get: actionRecorder.get,
      replay: actionRecorder.replay,
      clear: actionRecorder.clear,
    },
    
    performanceMonitor: {
      start: performanceMonitor.start,
      stop: performanceMonitor.stop,
      get: performanceMonitor.get,
      clear: performanceMonitor.clear,
      gc: performanceMonitor.gc,
    },
    
    highlighter: {
      show: highlighter.show,
      hide: highlighter.hide,
      clear: highlighter.clear,
    },
    
    assert: {
      check: asserter.check,
      batch: asserter.batch,
    },
    
    selector: {
      suggest: (x: number, y: number) => highlighter.suggestSelector(x, y),
      validate: (selector: string) => highlighter.validateSelector(selector),
    },
    
    // AI 自动调试核心功能
    smartActions: {
      waitForElement: smartActions.waitForElement,
      waitForText: smartActions.waitForText,
      waitForCondition: smartActions.waitForCondition,
      findByText: smartActions.findByText,
      findByRole: smartActions.findByRole,
      findByLabel: smartActions.findByLabel,
      clickText: smartActions.clickText,
      clickElement: smartActions.clickElement,
      fillInput: smartActions.fillInput,
      generateSelector: smartActions.generateSelector,
      getElementInfo: smartActions.getElementInfo,
      exportToPlaywright: smartActions.exportToPlaywright,
      exportToJS: smartActions.exportToJS,
    },
    
    handleCommand,
  };
}

/**
 * 初始化 MCP Debug 模块
 */
export async function initMCPDebug(options?: {
  autoStartErrorCapture?: boolean;
  autoStartNetworkMonitor?: boolean;
  autoStartPerformanceMonitor?: boolean;
  performanceInterval?: number;
}) {
  const {
    autoStartErrorCapture = true,
    autoStartNetworkMonitor = false,
    autoStartPerformanceMonitor = false,
    performanceInterval = 1000,
  } = options || {};
  
  // 创建并暴露 API
  const api = createMCPDebugAPI();
  window.__MCP_DEBUG__ = api;
  
  // 自动启动模块
  if (autoStartErrorCapture) {
    errorCapture.start();
  }
  
  if (autoStartNetworkMonitor) {
    networkMonitor.start();
  }
  
  if (autoStartPerformanceMonitor) {
    performanceMonitor.start(performanceInterval);
  }
  
  // 启用状态调试
  storeDebugger.enable();
  
  // 设置 MCP Bridge
  await setupMCPBridge();
  
  console.log(`[MCP-Debug] Initialized v${VERSION}`);
  console.log('[MCP-Debug] Access via window.__MCP_DEBUG__');
  
  return api;
}

/**
 * 销毁 MCP Debug 模块
 */
export function destroyMCPDebug() {
  reset();
  delete window.__MCP_DEBUG__;
  console.log('[MCP-Debug] Destroyed');
}

// 导出所有子模块
export { errorCapture, reportReactError } from './core/errorCapture';
export { networkMonitor } from './core/networkMonitor';
export { storeDebugger } from './core/storeDebugger';
export { actionRecorder } from './core/actionRecorder';
export { performanceMonitor } from './core/performanceMonitor';
export { highlighter } from './core/highlighter';
export { asserter } from './core/asserter';
export { smartActions } from './core/smartActions';
export { bridge, handleCommand, getStatus, reset } from './bridge';
export { registerAllStores, registerStore, getRegisteredStores } from './registerStores';

// 导出类型
export type {
  CapturedError,
  ErrorCaptureState,
  NetworkRequest,
  WebSocketMessage,
  NetworkMonitorState,
  StoreSnapshot,
  StateChange,
  StoreDebuggerState,
  RecordedAction,
  ActionRecorderState,
  ActionType,
  PerformanceMetrics,
  LongTask,
  RenderTiming,
  PerformanceMonitorState,
  HighlightOptions,
  HighlightedElement,
  Assertion,
  AssertionType,
  MCPDebugCommand,
  MCPDebugResponse,
  MCPDebugGlobalState,
  MCPDebugAPI,
} from './types';

// 默认导出
export default {
  init: initMCPDebug,
  destroy: destroyMCPDebug,
  errorCapture,
  networkMonitor,
  storeDebugger,
  actionRecorder,
  performanceMonitor,
  highlighter,
  asserter,
  bridge,
};
