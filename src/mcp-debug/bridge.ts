/**
 * MCP 桥接层
 * 处理来自 MCP 服务器的命令并返回结果
 */

import type { MCPDebugCommand, MCPDebugResponse, MCPDebugGlobalState } from './types';
import { errorCapture } from './core/errorCapture';
import { networkMonitor } from './core/networkMonitor';
import { storeDebugger } from './core/storeDebugger';
import { actionRecorder } from './core/actionRecorder';
import { performanceMonitor } from './core/performanceMonitor';
import { highlighter } from './core/highlighter';
import { asserter } from './core/asserter';

const VERSION = '1.0.0';

/**
 * 获取全局状态
 */
export function getStatus(): MCPDebugGlobalState {
  return {
    initialized: true,
    version: VERSION,
    errorCapture: errorCapture.getState(),
    networkMonitor: networkMonitor.getState(),
    storeDebugger: storeDebugger.getState(),
    actionRecorder: actionRecorder.getState(),
    performanceMonitor: performanceMonitor.getState(),
    highlightedElements: highlighter.getHighlighted(),
  };
}

/**
 * 重置所有模块
 */
export function reset() {
  errorCapture.stop();
  errorCapture.clear();
  networkMonitor.stop();
  networkMonitor.clear();
  storeDebugger.clear();
  storeDebugger.disable();
  actionRecorder.stop();
  actionRecorder.clear();
  performanceMonitor.stop();
  performanceMonitor.clear();
  highlighter.clear();
}

/**
 * 处理 MCP 命令
 */
export async function handleCommand(command: MCPDebugCommand): Promise<MCPDebugResponse> {
  const timestamp = Date.now();
  
  try {
    switch (command.cmd) {
      // ==================== 错误捕获 ====================
      case 'error:start':
        errorCapture.start();
        return { success: true, data: { message: 'Error capture started' }, timestamp };
      
      case 'error:stop':
        errorCapture.stop();
        return { success: true, data: { message: 'Error capture stopped' }, timestamp };
      
      case 'error:get':
        return { 
          success: true, 
          data: errorCapture.get(command.filter), 
          timestamp 
        };
      
      case 'error:clear':
        errorCapture.clear();
        return { success: true, data: { message: 'Errors cleared' }, timestamp };
      
      // ==================== 网络监控 ====================
      case 'network:start':
        networkMonitor.start();
        return { success: true, data: { message: 'Network monitor started' }, timestamp };
      
      case 'network:stop':
        networkMonitor.stop();
        return { success: true, data: { message: 'Network monitor stopped' }, timestamp };
      
      case 'network:get':
        return {
          success: true,
          data: {
            requests: networkMonitor.get(command.filter),
            websocket: networkMonitor.getWebSocket(),
          },
          timestamp,
        };
      
      case 'network:clear':
        networkMonitor.clear();
        return { success: true, data: { message: 'Network logs cleared' }, timestamp };
      
      // ==================== 状态调试 ====================
      case 'store:snapshot':
        storeDebugger.enable();
        return {
          success: true,
          data: {
            snapshots: storeDebugger.snapshot(command.storeName),
            registeredStores: storeDebugger.getRegisteredStores(),
          },
          timestamp,
        };
      
      case 'store:subscribe':
        storeDebugger.enable();
        storeDebugger.subscribe(command.storeName, command.selector);
        return { 
          success: true, 
          data: { 
            message: `Subscribed to ${command.storeName}`,
            subscribedStores: storeDebugger.getState().subscribedStores,
          }, 
          timestamp 
        };
      
      case 'store:unsubscribe':
        storeDebugger.unsubscribe(command.storeName);
        return { success: true, data: { message: `Unsubscribed from ${command.storeName}` }, timestamp };
      
      case 'store:getChanges':
        return {
          success: true,
          data: storeDebugger.getChanges(command.storeName),
          timestamp,
        };
      
      case 'store:clear':
        storeDebugger.clear();
        return { success: true, data: { message: 'Store debug data cleared' }, timestamp };
      
      // ==================== 操作录制 ====================
      case 'action:startRecording':
        actionRecorder.start();
        return { success: true, data: { message: 'Action recording started' }, timestamp };
      
      case 'action:stopRecording':
        const recorded = actionRecorder.stop();
        return { success: true, data: { actions: recorded, count: recorded.length }, timestamp };
      
      case 'action:getRecorded':
        return { success: true, data: actionRecorder.get(), timestamp };
      
      case 'action:replay':
        await actionRecorder.replay(command.actions, command.speed);
        return { success: true, data: { message: 'Replay completed' }, timestamp };
      
      case 'action:clear':
        actionRecorder.clear();
        return { success: true, data: { message: 'Actions cleared' }, timestamp };
      
      // ==================== 性能监控 ====================
      case 'perf:start':
        performanceMonitor.start(command.interval);
        return { success: true, data: { message: 'Performance monitor started' }, timestamp };
      
      case 'perf:stop':
        performanceMonitor.stop();
        return { success: true, data: { message: 'Performance monitor stopped' }, timestamp };
      
      case 'perf:get':
        return {
          success: true,
          data: {
            ...performanceMonitor.get(),
            summary: performanceMonitor.getSummary(),
          },
          timestamp,
        };
      
      case 'perf:clear':
        performanceMonitor.clear();
        return { success: true, data: { message: 'Performance data cleared' }, timestamp };
      
      case 'perf:gc':
        const gcResult = performanceMonitor.gc();
        return { 
          success: gcResult, 
          data: { message: gcResult ? 'GC triggered' : 'GC not available' }, 
          timestamp 
        };
      
      // ==================== 元素高亮 ====================
      case 'highlight:show':
        const highlightId = highlighter.show(command.options);
        return { 
          success: !!highlightId, 
          data: highlightId ? { id: highlightId } : { error: 'Element not found' }, 
          timestamp 
        };
      
      case 'highlight:hide':
        highlighter.hide(command.id);
        return { success: true, data: { message: 'Highlight hidden' }, timestamp };
      
      case 'highlight:clear':
        highlighter.clear();
        return { success: true, data: { message: 'All highlights cleared' }, timestamp };
      
      // ==================== 断言 ====================
      case 'assert:check':
        return {
          success: true,
          data: asserter.check(command.type, command.selector, command.expected),
          timestamp,
        };
      
      case 'assert:batch':
        return {
          success: true,
          data: asserter.batch(command.assertions),
          timestamp,
        };
      
      // ==================== 选择器 ====================
      case 'selector:suggest':
        return {
          success: true,
          data: highlighter.suggestSelector(command.x, command.y),
          timestamp,
        };
      
      case 'selector:validate':
        return {
          success: true,
          data: highlighter.validateSelector(command.selector),
          timestamp,
        };
      
      // ==================== 通用 ====================
      case 'status':
        return { success: true, data: getStatus(), timestamp };
      
      case 'reset':
        reset();
        return { success: true, data: { message: 'All modules reset' }, timestamp };
      
      default:
        return { 
          success: false, 
          error: `Unknown command: ${(command as any).cmd}`, 
          timestamp 
        };
    }
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp,
    };
  }
}

/**
 * 设置 MCP Bridge 事件监听
 * 监听来自 Tauri 后端的调试命令
 */
export async function setupMCPBridge() {
  // 检查 Tauri API 是否可用
  if (typeof window === 'undefined') return;
  
  const hasTauri = Boolean(
    (window as any).__TAURI_INTERNALS__ ||
    (window as any).__TAURI_IPC__
  );
  
  if (!hasTauri) {
    console.log('[MCP-Debug] Tauri not detected, bridge not initialized');
    return;
  }
  
  try {
    const { listen, emit } = await import('@tauri-apps/api/event');
    
    // 监听调试命令
    await listen<{ correlationId: string; command: MCPDebugCommand }>('mcp-debug-command', async (event) => {
      const { correlationId, command } = event.payload;
      
      console.log('[MCP-Debug] Received command:', command.cmd);
      
      const response = await handleCommand(command);
      
      // 发送响应
      await emit('mcp-debug-response', {
        correlationId,
        ...response,
      });
      
      await emit(`mcp-debug-response:${correlationId}`, {
        correlationId,
        ...response,
      });
    });
    
    console.log('[MCP-Debug] Bridge initialized, listening for commands');
  } catch (error: unknown) {
    console.warn('[MCP-Debug] Failed to setup bridge:', error);
  }
}

export const bridge = {
  getStatus,
  reset,
  handleCommand,
  setupMCPBridge,
};

export default bridge;
