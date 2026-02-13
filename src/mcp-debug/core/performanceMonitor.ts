/**
 * 性能监控模块
 * 监控内存使用、FPS、长任务和渲染性能
 */

import type { PerformanceMetrics, LongTask, RenderTiming, PerformanceMonitorState } from '../types';

// 生成唯一 ID
const generateId = () => `perf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// 模块状态
const state: PerformanceMonitorState = {
  enabled: false,
  metrics: [],
  longTasks: [],
  renderTimings: [],
  sampleInterval: 1000,
  maxSamples: 300,
};

// 定时器和观察器引用
let metricsInterval: number | null = null;
let longTaskObserver: PerformanceObserver | null = null;
let frameCount = 0;
let lastFrameTime = 0;
let rafId: number | null = null;

/**
 * 获取内存信息
 */
function getMemoryInfo(): PerformanceMetrics['memory'] | undefined {
  // Chrome/Edge 特有 API
  const memory = (performance as any).memory;
  if (memory) {
    return {
      usedJSHeapSize: memory.usedJSHeapSize,
      totalJSHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
    };
  }
  return undefined;
}

/**
 * 计算 FPS
 */
function measureFPS() {
  const now = performance.now();
  frameCount++;
  
  if (!rafId) return;
  
  rafId = requestAnimationFrame(measureFPS);
}

/**
 * 获取当前 FPS
 */
function getCurrentFPS(): number {
  const now = performance.now();
  const elapsed = now - lastFrameTime;
  const fps = elapsed > 0 ? Math.round((frameCount * 1000) / elapsed) : 0;
  
  // 重置计数
  frameCount = 0;
  lastFrameTime = now;
  
  return fps;
}

/**
 * 获取 DOM 节点数量
 */
function getDOMNodeCount(): number {
  return document.getElementsByTagName('*').length;
}

/**
 * 获取事件监听器数量（近似值）
 */
function getEventListenerCount(): number {
  // 这是一个近似值，实际上无法准确获取
  // 可以通过 getEventListeners (仅 DevTools) 获取
  let count = 0;
  
  // 遍历常见事件类型
  const eventTypes = ['click', 'mousedown', 'mouseup', 'mousemove', 'keydown', 'keyup', 'scroll', 'input', 'change'];
  
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Element;
    for (const type of eventTypes) {
      // 检查内联事件处理器
      if ((node as any)[`on${type}`]) {
        count++;
      }
    }
  }
  
  return count;
}

/**
 * 采集性能指标
 */
function collectMetrics() {
  if (!state.enabled) return;
  
  const metrics: PerformanceMetrics = {
    timestamp: Date.now(),
    memory: getMemoryInfo(),
    fps: getCurrentFPS(),
    domNodes: getDOMNodeCount(),
    eventListeners: getEventListenerCount(),
  };
  
  state.metrics.push(metrics);
  
  // 限制最大数量
  while (state.metrics.length > state.maxSamples) {
    state.metrics.shift();
  }
  
  // 触发事件
  window.dispatchEvent(new CustomEvent('mcp-debug:performance', { detail: metrics }));
}

/**
 * 处理长任务
 */
function handleLongTask(entries: PerformanceObserverEntryList) {
  if (!state.enabled) return;
  
  for (const entry of entries.getEntries()) {
    const longTask: LongTask = {
      id: generateId(),
      startTime: entry.startTime,
      duration: entry.duration,
      name: entry.name,
      attribution: (entry as any).attribution?.map((attr: any) => ({
        name: attr.name,
        containerType: attr.containerType,
        containerSrc: attr.containerSrc,
      })),
    };
    
    state.longTasks.push(longTask);
    
    // 限制最大数量
    while (state.longTasks.length > state.maxSamples) {
      state.longTasks.shift();
    }
    
    // 触发事件
    window.dispatchEvent(new CustomEvent('mcp-debug:longtask', { detail: longTask }));
  }
}

/**
 * 启动长任务观察器
 */
function startLongTaskObserver() {
  if (longTaskObserver) return;
  
  try {
    longTaskObserver = new PerformanceObserver(handleLongTask);
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch (e: unknown) {
    console.warn('[MCP-Debug] Long task observation not supported');
  }
}

/**
 * 停止长任务观察器
 */
function stopLongTaskObserver() {
  if (longTaskObserver) {
    longTaskObserver.disconnect();
    longTaskObserver = null;
  }
}

/**
 * 启动 FPS 测量
 */
function startFPSMeasurement() {
  if (rafId) return;
  
  frameCount = 0;
  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(measureFPS);
}

/**
 * 停止 FPS 测量
 */
function stopFPSMeasurement() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

/**
 * 启动性能监控
 */
export function start(interval?: number) {
  if (state.enabled) return;
  
  state.enabled = true;
  state.sampleInterval = interval || 1000;
  
  // 启动 FPS 测量
  startFPSMeasurement();
  
  // 启动长任务观察
  startLongTaskObserver();
  
  // 启动定时采集
  metricsInterval = window.setInterval(collectMetrics, state.sampleInterval);
  
  // 立即采集一次
  collectMetrics();
  
  console.log(`[MCP-Debug] Performance monitor started (interval: ${state.sampleInterval}ms)`);
}

/**
 * 停止性能监控
 */
export function stop() {
  if (!state.enabled) return;
  
  state.enabled = false;
  
  // 停止定时采集
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
  
  // 停止 FPS 测量
  stopFPSMeasurement();
  
  // 停止长任务观察
  stopLongTaskObserver();
  
  console.log('[MCP-Debug] Performance monitor stopped');
}

/**
 * 获取性能数据
 */
export function get() {
  return {
    metrics: [...state.metrics],
    longTasks: [...state.longTasks],
    renderTimings: [...state.renderTimings],
  };
}

/**
 * 获取最新的性能指标
 */
export function getLatest(): PerformanceMetrics | undefined {
  return state.metrics[state.metrics.length - 1];
}

/**
 * 获取性能摘要
 */
export function getSummary() {
  const metrics = state.metrics;
  if (metrics.length === 0) {
    return null;
  }
  
  const memoryValues = metrics.filter(m => m.memory).map(m => m.memory!.usedJSHeapSize);
  const fpsValues = metrics.filter(m => m.fps !== undefined).map(m => m.fps!);
  const domValues = metrics.filter(m => m.domNodes !== undefined).map(m => m.domNodes!);
  
  return {
    samples: metrics.length,
    timeRange: {
      start: metrics[0].timestamp,
      end: metrics[metrics.length - 1].timestamp,
    },
    memory: memoryValues.length > 0 ? {
      min: Math.min(...memoryValues),
      max: Math.max(...memoryValues),
      avg: memoryValues.reduce((a, b) => a + b, 0) / memoryValues.length,
      current: memoryValues[memoryValues.length - 1],
    } : undefined,
    fps: fpsValues.length > 0 ? {
      min: Math.min(...fpsValues),
      max: Math.max(...fpsValues),
      avg: Math.round(fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length),
      current: fpsValues[fpsValues.length - 1],
    } : undefined,
    domNodes: domValues.length > 0 ? {
      min: Math.min(...domValues),
      max: Math.max(...domValues),
      current: domValues[domValues.length - 1],
    } : undefined,
    longTasks: {
      count: state.longTasks.length,
      totalDuration: state.longTasks.reduce((sum, t) => sum + t.duration, 0),
    },
  };
}

/**
 * 清除数据
 */
export function clear() {
  state.metrics = [];
  state.longTasks = [];
  state.renderTimings = [];
}

/**
 * 触发垃圾回收（如果支持）
 */
export function gc() {
  // 只在开发工具打开时可用
  if (typeof (window as any).gc === 'function') {
    (window as any).gc();
    console.log('[MCP-Debug] Garbage collection triggered');
    return true;
  }
  console.warn('[MCP-Debug] GC not available. Run Chrome with --expose-gc flag');
  return false;
}

/**
 * 添加渲染计时（供 React Profiler 使用）
 */
export function addRenderTiming(timing: RenderTiming) {
  if (!state.enabled) return;
  
  state.renderTimings.push(timing);
  
  // 限制最大数量
  while (state.renderTimings.length > state.maxSamples) {
    state.renderTimings.shift();
  }
}

/**
 * 获取状态
 */
export function getState(): PerformanceMonitorState {
  return {
    ...state,
    metrics: [...state.metrics],
    longTasks: [...state.longTasks],
    renderTimings: [...state.renderTimings],
  };
}

export const performanceMonitor = {
  start,
  stop,
  get,
  getLatest,
  getSummary,
  clear,
  gc,
  addRenderTiming,
  getState,
};

export default performanceMonitor;
