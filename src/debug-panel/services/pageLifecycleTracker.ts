/**
 * 页面生命周期追踪服务
 * 
 * 监控侧边栏各页面的挂载/卸载/显示/隐藏状态，
 * 用于诊断保活机制是否生效和页面重新加载问题。
 */

import { debugLog } from '../debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export type PageLifecycleEvent = 
  | 'mount'         // 组件首次挂载
  | 'unmount'       // 组件卸载
  | 'show'          // 页面变为可见（currentView 匹配）
  | 'hide'          // 页面变为隐藏
  | 'data_load'     // 数据加载开始
  | 'data_ready'    // 数据加载完成
  | 'reset'         // 状态重置
  | 'effect_run'    // useEffect 执行
  | 'view_switch'   // 视图切换（App.tsx 层级）
  | 'render_start'  // 渲染开始
  | 'render_end'    // 渲染结束
  | 'sidebar_click' // 侧边栏点击
  | 'custom'        // 自定义事件
  | 'view_evict';   // 视图驱逐

export interface PageLifecycleLog {
  id: string;
  timestamp: number;
  pageId: string;
  pageName: string;
  event: PageLifecycleEvent;
  detail?: string;
  stack?: string;
  duration?: number;  // 用于 data_load 类事件的耗时
}

type Listener = (logs: PageLifecycleLog[]) => void;

class PageLifecycleTracker {
  private logs: PageLifecycleLog[] = [];
  private listeners: Set<Listener> = new Set();
  private maxLogs = 500;
  private idCounter = 0;
  private pageStates: Map<string, {
    mounted: boolean;
    visible: boolean;
    mountCount: number;
    lastMountTime?: number;
    lastShowTime?: number;
    dataLoadStartTime?: number;
  }> = new Map();

  /**
   * 记录页面生命周期事件
   */
  log(
    pageId: string,
    pageName: string,
    event: PageLifecycleEvent,
    detail?: string,
    options?: { duration?: number; captureStack?: boolean }
  ): void {
    const now = Date.now();
    const id = `pl_${++this.idCounter}_${now}`;
    
    // 更新页面状态
    this.updatePageState(pageId, event, now, options?.duration);
    
    const logEntry: PageLifecycleLog = {
      id,
      timestamp: now,
      pageId,
      pageName,
      event,
      detail,
      duration: options?.duration,
    };
    
    // 捕获调用栈（可选）
    if (options?.captureStack) {
      try {
        logEntry.stack = new Error().stack?.split('\n').slice(2, 6).join('\n');
      } catch {}
    }
    
    this.logs.push(logEntry);
    
    // 限制日志数量
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
    
    // 控制台输出
    const emoji = this.getEventEmoji(event);
    const color = this.getEventColor(event);
    console.log(
      `%c${emoji} [PageLifecycle] ${pageName} | ${event}${detail ? ` | ${detail}` : ''}${options?.duration ? ` | ${options.duration}ms` : ''}`,
      `color: ${color}; font-weight: bold;`
    );
    
    // 通知监听器
    this.notifyListeners();
  }

  private updatePageState(
    pageId: string,
    event: PageLifecycleEvent,
    timestamp: number,
    duration?: number
  ): void {
    let state = this.pageStates.get(pageId);
    if (!state) {
      state = { mounted: false, visible: false, mountCount: 0 };
      this.pageStates.set(pageId, state);
    }
    
    switch (event) {
      case 'mount':
        state.mounted = true;
        state.mountCount++;
        state.lastMountTime = timestamp;
        break;
      case 'unmount':
        state.mounted = false;
        break;
      case 'show':
        state.visible = true;
        state.lastShowTime = timestamp;
        break;
      case 'hide':
        state.visible = false;
        break;
      case 'data_load':
        state.dataLoadStartTime = timestamp;
        break;
      case 'data_ready':
        state.dataLoadStartTime = undefined;
        break;
    }
  }

  private getEventEmoji(event: PageLifecycleEvent): string {
    const emojiMap: Record<PageLifecycleEvent, string> = {
      mount: '🟢',
      unmount: '🔴',
      show: '👁️',
      hide: '🙈',
      data_load: '⏳',
      data_ready: '✅',
      reset: '🔄',
      effect_run: '⚡',
      view_switch: '🔀',
      render_start: '🎬',
      render_end: '🏁',
      sidebar_click: '👆',
      custom: '📌',
      view_evict: '🗑️',
    };
    return emojiMap[event] || '📋';
  }

  private getEventColor(event: PageLifecycleEvent): string {
    const colorMap: Record<PageLifecycleEvent, string> = {
      mount: '#22c55e',
      unmount: '#ef4444',
      show: '#3b82f6',
      hide: '#6b7280',
      data_load: '#f59e0b',
      data_ready: '#10b981',
      reset: '#8b5cf6',
      effect_run: '#06b6d4',
      view_switch: '#f97316',
      render_start: '#a855f7',
      render_end: '#22d3ee',
      sidebar_click: '#14b8a6',
      custom: '#ec4899',
      view_evict: '#f43f5e',
    };
    return colorMap[event] || '#9ca3af';
  }

  /**
   * 获取所有日志
   */
  getLogs(): PageLifecycleLog[] {
    return [...this.logs];
  }

  /**
   * 获取页面状态摘要
   */
  getPageStates(): Map<string, {
    mounted: boolean;
    visible: boolean;
    mountCount: number;
    lastMountTime?: number;
    lastShowTime?: number;
  }> {
    return new Map(this.pageStates);
  }

  /**
   * 生成诊断报告
   */
  generateReport(): string {
    const lines: string[] = [
      '=== 页面生命周期诊断报告 ===',
      `生成时间: ${new Date().toISOString()}`,
      '',
      '--- 页面状态摘要 ---',
    ];
    
    // 页面状态
    this.pageStates.forEach((state, pageId) => {
      const status = state.mounted ? (state.visible ? '✅ 可见' : '🟡 隐藏(保活)') : '❌ 未挂载';
      const mountInfo = state.mountCount > 1 
        ? `⚠️ 挂载次数: ${state.mountCount}（可能存在重挂载问题）` 
        : `挂载次数: ${state.mountCount}`;
      lines.push(`${pageId}: ${status} | ${mountInfo}`);
    });
    
    lines.push('', '--- 最近事件日志 (最新20条) ---');
    
    // 最近事件
    const recentLogs = this.logs.slice(-20);
    recentLogs.forEach(log => {
      const time = new Date(log.timestamp).toISOString().slice(11, 23);
      const durationStr = log.duration ? ` (${log.duration}ms)` : '';
      lines.push(`[${time}] ${log.pageName} | ${log.event}${durationStr}${log.detail ? ` | ${log.detail}` : ''}`);
    });
    
    // 问题检测
    lines.push('', '--- 潜在问题检测 ---');
    let problemCount = 0;
    
    this.pageStates.forEach((state, pageId) => {
      if (state.mountCount > 1) {
        problemCount++;
        lines.push(`⚠️ ${pageId}: 挂载了 ${state.mountCount} 次，保活机制可能未生效`);
      }
    });
    
    // 检查频繁的 data_load 事件
    const dataLoadCounts = new Map<string, number>();
    this.logs.forEach(log => {
      if (log.event === 'data_load') {
        dataLoadCounts.set(log.pageId, (dataLoadCounts.get(log.pageId) || 0) + 1);
      }
    });
    dataLoadCounts.forEach((count, pageId) => {
      if (count > 3) {
        problemCount++;
        lines.push(`⚠️ ${pageId}: 数据加载了 ${count} 次，可能存在重复加载问题`);
      }
    });
    
    if (problemCount === 0) {
      lines.push('✅ 未检测到明显问题');
    }
    
    return lines.join('\n');
  }

  /**
   * 清空日志
   */
  clear(): void {
    this.logs = [];
    this.pageStates.clear();
    this.notifyListeners();
    console.log('%c[PageLifecycle] 日志已清空', 'color: #9ca3af;');
  }

  /**
   * 订阅日志更新
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const logs = this.getLogs();
    this.listeners.forEach(listener => {
      try {
        listener(logs);
      } catch (e) {
        console.error('[PageLifecycle] Listener error:', e);
      }
    });
  }
}

// 单例导出
export const pageLifecycleTracker = new PageLifecycleTracker();

// 挂载到 window 供调试
if (typeof window !== 'undefined') {
  (window as any).__PAGE_LIFECYCLE_TRACKER__ = pageLifecycleTracker;
}
