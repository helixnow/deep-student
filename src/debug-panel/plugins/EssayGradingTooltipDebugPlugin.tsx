/**
 * 作文批改 Tooltip 调试插件
 * 
 * 功能：
 * - 监听 Tooltip 的生命周期（mount/unmount/render）
 * - 捕获 DOM 状态快照（尺寸、位置、计算样式）
 * - 监听相关事件和状态变化
 * - 提供日志展示和一键复制功能
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';

interface LogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  category: 'lifecycle' | 'dom' | 'style' | 'event' | 'snapshot';
  message: string;
  data?: Record<string, unknown>;
}

interface TooltipSnapshot {
  id: string;
  timestamp: number;
  triggerRect: DOMRect | null;
  contentRect: DOMRect | null;
  triggerStyles: Record<string, string>;
  contentStyles: Record<string, string>;
  portalContainer: string | null;
  zIndex: string;
  visibility: string;
  overflow: string;
  position: string;
  html: string;
}

// 全局日志收集器
const globalLogs: LogEntry[] = [];
const globalSnapshots: TooltipSnapshot[] = [];
const listeners = new Set<() => void>();

const notify = () => listeners.forEach(fn => fn());

const addLog = (entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
  globalLogs.push({
    ...entry,
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  });
  if (globalLogs.length > 500) globalLogs.shift();
  notify();
};

const addSnapshot = (snapshot: Omit<TooltipSnapshot, 'id' | 'timestamp'>) => {
  globalSnapshots.push({
    ...snapshot,
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  });
  if (globalSnapshots.length > 50) globalSnapshots.shift();
  notify();
};

// 导出用于外部调用的日志函数
export const tooltipDebugLog = (
  level: LogEntry['level'],
  category: LogEntry['category'],
  message: string,
  data?: Record<string, unknown>
) => {
  addLog({ level, category, message, data });
};

// DOM 检测工具
const captureTooltipSnapshot = () => {
  // 查找所有 Radix Tooltip Content 元素
  const tooltipContents = document.querySelectorAll('[data-radix-popper-content-wrapper], [role="tooltip"]');
  
  tooltipContents.forEach((el, index) => {
    const contentEl = el as HTMLElement;
    const computedStyle = window.getComputedStyle(contentEl);
    
    // 获取 trigger 元素（通过 aria 关系或父元素）
    const triggerId = contentEl.getAttribute('aria-describedby') || 
                      contentEl.closest('[data-state]')?.getAttribute('id');
    const triggerEl = triggerId ? document.getElementById(triggerId) : null;
    
    const snapshot: Omit<TooltipSnapshot, 'id' | 'timestamp'> = {
      triggerRect: triggerEl?.getBoundingClientRect() || null,
      contentRect: contentEl.getBoundingClientRect(),
      triggerStyles: triggerEl ? {
        display: window.getComputedStyle(triggerEl).display,
        position: window.getComputedStyle(triggerEl).position,
      } : {},
      contentStyles: {
        display: computedStyle.display,
        position: computedStyle.position,
        width: computedStyle.width,
        height: computedStyle.height,
        minWidth: computedStyle.minWidth,
        maxWidth: computedStyle.maxWidth,
        minHeight: computedStyle.minHeight,
        maxHeight: computedStyle.maxHeight,
        padding: computedStyle.padding,
        margin: computedStyle.margin,
        overflow: computedStyle.overflow,
        overflowX: computedStyle.overflowX,
        overflowY: computedStyle.overflowY,
        zIndex: computedStyle.zIndex,
        visibility: computedStyle.visibility,
        opacity: computedStyle.opacity,
        backgroundColor: computedStyle.backgroundColor,
        border: computedStyle.border,
        boxSizing: computedStyle.boxSizing,
        transform: computedStyle.transform,
        top: computedStyle.top,
        left: computedStyle.left,
        right: computedStyle.right,
        bottom: computedStyle.bottom,
      },
      portalContainer: contentEl.parentElement?.tagName || null,
      zIndex: computedStyle.zIndex,
      visibility: computedStyle.visibility,
      overflow: computedStyle.overflow,
      position: computedStyle.position,
      html: contentEl.outerHTML.slice(0, 2000), // 限制长度
    };
    
    addSnapshot(snapshot);
    
    addLog({
      level: 'info',
      category: 'snapshot',
      message: `捕获 Tooltip #${index + 1} 快照`,
      data: {
        contentRect: snapshot.contentRect,
        zIndex: snapshot.zIndex,
        visibility: snapshot.visibility,
        overflow: snapshot.overflow,
        width: snapshot.contentStyles.width,
        height: snapshot.contentStyles.height,
        maxWidth: snapshot.contentStyles.maxWidth,
      },
    });
    
    // 检测潜在问题
    const rect = snapshot.contentRect;
    if (rect) {
      if (rect.width < 50 || rect.height < 20) {
        addLog({
          level: 'error',
          category: 'dom',
          message: `⚠️ Tooltip 尺寸异常：${rect.width}x${rect.height}px`,
          data: { rect },
        });
      }
      
      // 检查是否被裁剪
      const parent = contentEl.parentElement;
      if (parent) {
        const parentRect = parent.getBoundingClientRect();
        const parentStyle = window.getComputedStyle(parent);
        if (parentStyle.overflow !== 'visible' && 
            (rect.right > parentRect.right || rect.bottom > parentRect.bottom)) {
          addLog({
            level: 'error',
            category: 'style',
            message: `⚠️ Tooltip 内容被父容器裁剪`,
            data: { 
              contentRect: rect, 
              parentRect, 
              parentOverflow: parentStyle.overflow 
            },
          });
        }
      }
    }
  });
  
  if (tooltipContents.length === 0) {
    addLog({
      level: 'debug',
      category: 'dom',
      message: '未发现任何 Tooltip 元素',
    });
  }
};

// MutationObserver 监听 DOM 变化
let observer: MutationObserver | null = null;

const startObserving = () => {
  if (observer) return;
  
  observer = new MutationObserver((mutations) => {
    let tooltipRelated = false;
    
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          if (node.matches('[data-radix-popper-content-wrapper], [role="tooltip"]') ||
              node.querySelector('[data-radix-popper-content-wrapper], [role="tooltip"]')) {
            tooltipRelated = true;
            addLog({
              level: 'info',
              category: 'lifecycle',
              message: 'Tooltip 元素已添加到 DOM',
              data: { 
                tagName: node.tagName, 
                className: node.className,
                id: node.id,
              },
            });
          }
        }
      });
      
      mutation.removedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          if (node.matches('[data-radix-popper-content-wrapper], [role="tooltip"]') ||
              node.querySelector('[data-radix-popper-content-wrapper], [role="tooltip"]')) {
            addLog({
              level: 'info',
              category: 'lifecycle',
              message: 'Tooltip 元素已从 DOM 移除',
            });
          }
        }
      });
    });
    
    if (tooltipRelated) {
      // 延迟捕获快照，等待渲染完成
      setTimeout(captureTooltipSnapshot, 50);
    }
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'data-state'],
  });
  
  addLog({
    level: 'info',
    category: 'lifecycle',
    message: '开始监听 Tooltip DOM 变化',
  });
};

const stopObserving = () => {
  if (observer) {
    observer.disconnect();
    observer = null;
    addLog({
      level: 'info',
      category: 'lifecycle',
      message: '停止监听 Tooltip DOM 变化',
    });
  }
};

const EssayGradingTooltipDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  isActive,
  isActivated,
}) => {
  const [logs, setLogs] = useState<LogEntry[]>([...globalLogs]);
  const [snapshots, setSnapshots] = useState<TooltipSnapshot[]>([...globalSnapshots]);
  const [isObserving, setIsObserving] = useState(false);
  const [filter, setFilter] = useState<LogEntry['category'] | 'all'>('all');
  const [levelFilter, setLevelFilter] = useState<LogEntry['level'] | 'all'>('all');
  const [selectedSnapshot, setSelectedSnapshot] = useState<TooltipSnapshot | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const update = () => {
      setLogs([...globalLogs]);
      setSnapshots([...globalSnapshots]);
    };
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  
  useEffect(() => {
    if (isActivated && !isObserving) {
      startObserving();
      setIsObserving(true);
    }
  }, [isActivated, isObserving]);
  
  useEffect(() => {
    return () => {
      stopObserving();
    };
  }, []);
  
  const handleClear = useCallback(() => {
    globalLogs.length = 0;
    globalSnapshots.length = 0;
    setLogs([]);
    setSnapshots([]);
    setSelectedSnapshot(null);
  }, []);
  
  const handleManualCapture = useCallback(() => {
    addLog({
      level: 'info',
      category: 'event',
      message: '手动触发快照捕获',
    });
    captureTooltipSnapshot();
  }, []);
  
  const handleCopyLogs = useCallback(() => {
    const filteredLogs = logs.filter(log => {
      if (filter !== 'all' && log.category !== filter) return false;
      if (levelFilter !== 'all' && log.level !== levelFilter) return false;
      return true;
    });
    
    const text = filteredLogs.map(log => {
      const time = new Date(log.timestamp).toISOString();
      const data = log.data ? `\n  Data: ${JSON.stringify(log.data, null, 2)}` : '';
      return `[${time}] [${log.level.toUpperCase()}] [${log.category}] ${log.message}${data}`;
    }).join('\n\n');
    
    navigator.clipboard.writeText(text);
    addLog({
      level: 'info',
      category: 'event',
      message: `已复制 ${filteredLogs.length} 条日志到剪贴板`,
    });
  }, [logs, filter, levelFilter]);
  
  const handleCopySnapshot = useCallback((snapshot: TooltipSnapshot) => {
    const text = JSON.stringify(snapshot, null, 2);
    navigator.clipboard.writeText(text);
    addLog({
      level: 'info',
      category: 'event',
      message: '已复制快照到剪贴板',
    });
  }, []);
  
  const handleCopyAll = useCallback(() => {
    const report = {
      timestamp: new Date().toISOString(),
      logs: logs,
      snapshots: snapshots,
      summary: {
        totalLogs: logs.length,
        errorCount: logs.filter(l => l.level === 'error').length,
        warnCount: logs.filter(l => l.level === 'warn').length,
        snapshotCount: snapshots.length,
      },
    };
    navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    addLog({
      level: 'info',
      category: 'event',
      message: '已复制完整诊断报告到剪贴板',
    });
  }, [logs, snapshots]);
  
  const filteredLogs = logs.filter(log => {
    if (filter !== 'all' && log.category !== filter) return false;
    if (levelFilter !== 'all' && log.level !== levelFilter) return false;
    return true;
  });
  
  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error': return 'text-red-400';
      case 'warn': return 'text-yellow-400';
      case 'info': return 'text-blue-400';
      case 'debug': return 'text-slate-400';
    }
  };
  
  const getCategoryColor = (category: LogEntry['category']) => {
    switch (category) {
      case 'lifecycle': return 'bg-purple-500/20 text-purple-300';
      case 'dom': return 'bg-green-500/20 text-green-300';
      case 'style': return 'bg-amber-500/20 text-amber-300';
      case 'event': return 'bg-blue-500/20 text-blue-300';
      case 'snapshot': return 'bg-cyan-500/20 text-cyan-300';
    }
  };
  
  if (!isActive) return null;
  
  return (
    <div className="flex flex-col h-full text-slate-100">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 p-2 border-b border-slate-700/50 bg-slate-800/50">
        <button
          onClick={handleManualCapture}
          className="px-2 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 rounded transition-colors"
        >
          📸 捕获快照
        </button>
        <button
          onClick={() => {
            if (isObserving) {
              stopObserving();
              setIsObserving(false);
            } else {
              startObserving();
              setIsObserving(true);
            }
          }}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            isObserving 
              ? 'bg-green-600 hover:bg-green-500' 
              : 'bg-slate-600 hover:bg-slate-500'
          }`}
        >
          {isObserving ? '🟢 监听中' : '⚪ 已暂停'}
        </button>
        <div className="flex-1" />
        <select
          value={filter}
          onChange={e => setFilter(e.target.value as typeof filter)}
          className="px-2 py-1 text-xs bg-slate-700 border border-slate-600 rounded"
        >
          <option value="all">全部分类</option>
          <option value="lifecycle">生命周期</option>
          <option value="dom">DOM</option>
          <option value="style">样式</option>
          <option value="event">事件</option>
          <option value="snapshot">快照</option>
        </select>
        <select
          value={levelFilter}
          onChange={e => setLevelFilter(e.target.value as typeof levelFilter)}
          className="px-2 py-1 text-xs bg-slate-700 border border-slate-600 rounded"
        >
          <option value="all">全部级别</option>
          <option value="error">错误</option>
          <option value="warn">警告</option>
          <option value="info">信息</option>
          <option value="debug">调试</option>
        </select>
        <button
          onClick={handleCopyLogs}
          className="px-2 py-1 text-xs bg-slate-600 hover:bg-slate-500 rounded transition-colors"
        >
          📋 复制日志
        </button>
        <button
          onClick={handleCopyAll}
          className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 rounded transition-colors"
        >
          📄 复制报告
        </button>
        <button
          onClick={handleClear}
          className="px-2 py-1 text-xs bg-red-600/80 hover:bg-red-500 rounded transition-colors"
        >
          🗑️ 清空
        </button>
      </div>
      
      {/* 状态摘要 */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] bg-slate-800/30 border-b border-slate-700/30">
        <span className="text-slate-400">
          日志: <span className="text-slate-200">{filteredLogs.length}</span>
        </span>
        <span className="text-red-400">
          错误: <span className="text-red-300">{logs.filter(l => l.level === 'error').length}</span>
        </span>
        <span className="text-yellow-400">
          警告: <span className="text-yellow-300">{logs.filter(l => l.level === 'warn').length}</span>
        </span>
        <span className="text-cyan-400">
          快照: <span className="text-cyan-300">{snapshots.length}</span>
        </span>
      </div>
      
      {/* 主内容区 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 日志列表 */}
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {filteredLogs.length === 0 ? (
            <div className="text-center text-slate-500 py-8">
              <p className="text-sm">暂无日志</p>
              <p className="text-xs mt-1">点击"捕获快照"或在作文批改页面悬停标记来生成日志</p>
            </div>
          ) : (
            filteredLogs.map(log => (
              <div
                key={log.id}
                className="p-2 bg-slate-800/50 rounded border border-slate-700/30 hover:border-slate-600/50 transition-colors"
              >
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-slate-500">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded ${getCategoryColor(log.category)}`}>
                    {log.category}
                  </span>
                  <span className={getLevelColor(log.level)}>
                    [{log.level.toUpperCase()}]
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-200">{log.message}</div>
                {log.data && (
                  <pre className="mt-1 p-1.5 text-[10px] bg-slate-900/50 rounded overflow-x-auto text-slate-400">
                    {JSON.stringify(log.data, null, 2)}
                  </pre>
                )}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
        
        {/* 快照面板 */}
        <div className="w-72 border-l border-slate-700/50 flex flex-col">
          <div className="p-2 text-xs font-semibold text-slate-300 bg-slate-800/30 border-b border-slate-700/30">
            快照列表 ({snapshots.length})
          </div>
          <div className="flex-1 overflow-auto p-1 space-y-1">
            {snapshots.map(snap => (
              <div
                key={snap.id}
                onClick={() => setSelectedSnapshot(snap)}
                className={`p-2 text-[10px] rounded cursor-pointer transition-colors ${
                  selectedSnapshot?.id === snap.id
                    ? 'bg-cyan-600/30 border border-cyan-500/50'
                    : 'bg-slate-800/50 border border-slate-700/30 hover:bg-slate-700/50'
                }`}
              >
                <div className="text-slate-400">
                  {new Date(snap.timestamp).toLocaleTimeString()}
                </div>
                <div className="text-slate-200 mt-0.5">
                  尺寸: {snap.contentRect?.width.toFixed(0)}x{snap.contentRect?.height.toFixed(0)}px
                </div>
                <div className="text-slate-400 mt-0.5">
                  z-index: {snap.zIndex}
                </div>
              </div>
            ))}
          </div>
          
          {/* 快照详情 */}
          {selectedSnapshot && (
            <div className="border-t border-slate-700/50 p-2 max-h-48 overflow-auto">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-semibold text-slate-300">快照详情</span>
                <button
                  onClick={() => handleCopySnapshot(selectedSnapshot)}
                  className="px-1.5 py-0.5 text-[9px] bg-slate-600 hover:bg-slate-500 rounded"
                >
                  复制
                </button>
              </div>
              <pre className="text-[9px] text-slate-400 overflow-x-auto">
                {JSON.stringify({
                  contentRect: selectedSnapshot.contentRect,
                  contentStyles: selectedSnapshot.contentStyles,
                  zIndex: selectedSnapshot.zIndex,
                  visibility: selectedSnapshot.visibility,
                  overflow: selectedSnapshot.overflow,
                }, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default EssayGradingTooltipDebugPlugin;
