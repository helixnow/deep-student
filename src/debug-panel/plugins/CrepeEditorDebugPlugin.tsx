/**
 * Crepe 编辑器调试插件
 * 全面监控 Crepe 编辑器的完整生命周期，用于诊断无法编辑等问题
 * 
 * 监控范围：
 * - 初始化流程（container, Crepe实例, create()）
 * - 依赖加载（Prism, Milkdown插件）
 * - DOM 状态（data-ready, contentEditable, pointer-events）
 * - 编辑器事件（focus, blur, markdownUpdated）
 * - 错误捕获
 */

import React from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { 
  Copy, FloppyDisk, Warning, CheckCircle, Funnel, 
  Clipboard, Trash, ArrowClockwise, Eye, Code 
} from '@phosphor-icons/react';
import { showGlobalNotification } from '../../components/UnifiedNotification';
import { serveDebugChannel } from '@/shared/debug/bus';
import { CREPE_EDITOR_DEBUG_CHANNEL } from '@/shared/debug/channels/crepeEditor';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import {
  CATEGORY_LABELS, LEVEL_COLORS, LEVEL_ICONS,
  type DOMSnapshot, type DebugLog, type EventCategory, type LogLevel,
} from './crepeEditor/model';
import { captureDOMSnapshot, emitCrepeDebug } from './crepeEditor/report';
import { useCrepeDebugFeed } from './crepeEditor/useCrepeDebugFeed';
import { diagnose, logStats } from './crepeEditor/diagnosis';
import { copiedLog, exportData, exportFileName } from './crepeEditor/copy';

export type { CrepeDebugEventDetail } from './crepeEditor/model';
export { captureDOMSnapshot, emitCrepeDebug };

// ============ 插件组件 ============

const CrepeEditorDebugPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActive, isActivated }) => {
  const [logs, setLogs] = React.useState<DebugLog[]>([]);
  const [selectedCategory, setSelectedCategory] = React.useState<EventCategory | 'all'>('all');
  const [selectedLevel, setSelectedLevel] = React.useState<LogLevel | 'all'>('all');
  const [keyword, setKeyword] = React.useState('');
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [liveSnapshot, setLiveSnapshot] = React.useState<DOMSnapshot | null>(null);
  const logContainerRef = React.useRef<HTMLDivElement>(null);

  const append = React.useCallback((entry: Omit<DebugLog, 'id'>) => {
    setLogs(prev => {
      const next = [...prev, { ...entry, id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }];
      return next.slice(-500);
    });
  }, []);

  useCrepeDebugFeed(isActivated, append);

  // 定时刷新 DOM 快照
  React.useEffect(() => {
    if (!isActivated) return;

    const interval = setInterval(() => {
      setLiveSnapshot(captureDOMSnapshot());
    }, 1000);

    return () => clearInterval(interval);
  }, [isActivated]);

  // 自动滚动
  React.useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const clearLogs = React.useCallback(() => {
    setLogs([]);
  }, []);

  const filteredLogs = React.useMemo(() => {
    return logs.filter(log => {
      if (errorsOnly && log.level !== 'error' && log.level !== 'warning') return false;
      if (selectedCategory !== 'all' && log.category !== selectedCategory) return false;
      if (selectedLevel !== 'all' && log.level !== selectedLevel) return false;
      if (keyword && !JSON.stringify(log).toLowerCase().includes(keyword.toLowerCase())) return false;
      return true;
    });
  }, [logs, errorsOnly, selectedCategory, selectedLevel, keyword]);

  const copyLog = React.useCallback((log: DebugLog) => {
    const text = JSON.stringify(copiedLog(log), null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', '日志已复制到剪贴板');
    }).catch(console.error);
  }, []);
  
  const copyAllLogs = React.useCallback(() => {
    const text = JSON.stringify(filteredLogs.map(log => copiedLog(log)), null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', `已复制 ${filteredLogs.length} 条日志到剪贴板`);
    }).catch(console.error);
  }, [filteredLogs]);

  const exportLogs = React.useCallback(() => {
    const data = exportData(logs, liveSnapshot);
    
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName();
    a.click();
    URL.revokeObjectURL(url);
  }, [logs, liveSnapshot]);

  // 手动触发快照
  const triggerSnapshot = React.useCallback(() => {
    const domSnapshot = captureDOMSnapshot();
    setLiveSnapshot(domSnapshot);
    append({
      ts: Date.now(),
      category: 'snapshot',
      level: 'info',
      message: '手动触发 DOM 快照',
      domSnapshot,
    });
  }, [append]);

  // 诊断分析
  const diagnosis = React.useMemo(() => diagnose(liveSnapshot, logs), [liveSnapshot, logs]);

  const stats = React.useMemo(() => logStats(logs), [logs]);

  if (!isActivated) return null;

  return (
    <div className="p-4 space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Code size={20} />
          Crepe 编辑器调试
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={triggerSnapshot}
            className="px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm bg-cyan-500 text-white rounded hover:bg-cyan-600"
            title="手动捕获 DOM 快照"
          >
            <Eye size={16} className="inline mr-1" />
            快照
          </button>
          <button
            onClick={() => setErrorsOnly(!errorsOnly)}
            className={`px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm rounded ${errorsOnly ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-700'}`}
            title="仅显示错误和警告"
          >
            <Funnel size={16} />
          </button>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm rounded ${autoScroll ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-700'}`}
            title="自动滚动到底部"
          >
            自动滚动
          </button>
          <button
            onClick={copyAllLogs}
            className="px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
            disabled={filteredLogs.length === 0}
            title="复制所有日志到剪贴板"
          >
            <Clipboard size={16} />
          </button>
          <button
            onClick={exportLogs}
            className="px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm bg-indigo-500 text-white rounded hover:bg-indigo-600"
            disabled={logs.length === 0}
            title="导出日志为JSON文件"
          >
            <FloppyDisk size={16} />
          </button>
          <button
            onClick={clearLogs}
            className="px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm bg-gray-500 text-white rounded hover:bg-gray-600"
            title="清空日志"
          >
            <Trash size={16} />
          </button>
        </div>
      </div>

      {/* 实时 DOM 快照 & 诊断 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* DOM 快照 */}
        <div className="border rounded-lg p-3 bg-slate-50">
          <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
            <Eye size={16} />
            实时 DOM 快照
          </div>
          {liveSnapshot ? (
            <div className="text-xs font-mono space-y-1">
              <div className={liveSnapshot.wrapperExists ? 'text-green-600' : 'text-red-600'}>
                wrapper: {liveSnapshot.wrapperExists ? '✓' : '✗'}
              </div>
              <div className={liveSnapshot.dataReady === 'true' ? 'text-green-600' : 'text-red-600'}>
                data-ready: {liveSnapshot.dataReady ?? 'null'}
              </div>
              <div className={liveSnapshot.milkdownExists ? 'text-green-600' : 'text-red-600'}>
                .milkdown: {liveSnapshot.milkdownExists ? '✓' : '✗'}
              </div>
              <div className={liveSnapshot.proseMirrorExists ? 'text-green-600' : 'text-red-600'}>
                .ProseMirror: {liveSnapshot.proseMirrorExists ? '✓' : '✗'}
              </div>
              <div className={liveSnapshot.contentEditable === 'true' ? 'text-green-600' : 'text-orange-600'}>
                contentEditable: {liveSnapshot.contentEditable ?? 'null'}
              </div>
              <div className={liveSnapshot.pointerEvents !== 'none' ? 'text-green-600' : 'text-red-600'}>
                pointer-events: {liveSnapshot.pointerEvents}
              </div>
              <div className="text-gray-500">
                opacity: {liveSnapshot.opacity}
              </div>
              <div className="text-gray-500">
                children: {liveSnapshot.childCount}
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-500">等待快照...</div>
          )}
        </div>

        {/* 诊断结果 */}
        <div className={`border rounded-lg p-3 ${diagnosis?.isHealthy ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <div className="text-sm font-medium mb-2 flex items-center gap-2">
            {diagnosis?.isHealthy ? (
              <>
                <CheckCircle size={16} className="text-green-600" />
                <span className="text-green-700">状态正常</span>
              </>
            ) : (
              <>
                <Warning size={16} className="text-red-600" />
                <span className="text-red-700">检测到问题</span>
              </>
            )}
          </div>
          {diagnosis && !diagnosis.isHealthy && (
            <div className="space-y-2">
              <div className="text-xs space-y-1">
                {diagnosis.issues.map((issue, i) => (
                  <div key={i} className="text-red-700">{issue}</div>
                ))}
              </div>
              {diagnosis.hints.length > 0 && (
                <div className="text-xs text-gray-600 border-t pt-2 mt-2">
                  <div className="font-medium mb-1">建议：</div>
                  {diagnosis.hints.map((hint, i) => (
                    <div key={i}>• {hint}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          {diagnosis?.isHealthy && (
            <div className="text-xs text-green-600">编辑器各项指标正常</div>
          )}
        </div>
      </div>

      {/* 统计面板 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="p-3 bg-gray-100 rounded">
          <div className="text-xs text-gray-500">调试</div>
          <div className="text-lg font-semibold text-gray-600">{stats.counts.debug}</div>
        </div>
        <div className="p-3 bg-blue-100 rounded">
          <div className="text-xs text-blue-600">信息</div>
          <div className="text-lg font-semibold text-blue-700">{stats.counts.info}</div>
        </div>
        <div className="p-3 bg-yellow-100 rounded">
          <div className="text-xs text-yellow-600">警告</div>
          <div className="text-lg font-semibold text-yellow-700">{stats.counts.warning}</div>
        </div>
        <div className="p-3 bg-red-100 rounded">
          <div className="text-xs text-red-600">错误</div>
          <div className="text-lg font-semibold text-red-700">{stats.counts.error}</div>
        </div>
      </div>

      {/* 分类统计 */}
      <div className="border rounded-lg p-3 bg-gradient-to-r from-purple-50 to-blue-50">
        <div className="text-sm font-medium text-gray-700 mb-2">事件分类统计</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(CATEGORY_LABELS).map(([key, { label, color }]) => {
            const count = stats.categoryStats[key] || 0;
            return (
              <button
                key={key}
                onClick={() => setSelectedCategory(selectedCategory === key ? 'all' : key as EventCategory)}
                className={`px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-xs rounded-full transition-all ${
                  selectedCategory === key 
                    ? 'ring-2 ring-offset-1' 
                    : 'opacity-75 hover:opacity-100'
                }`}
                style={{ 
                  backgroundColor: `${color}20`, 
                  color: color,
                }}
              >
                {label}: {count}
              </button>
            );
          })}
        </div>
      </div>

      {/* 过滤器 */}
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-gray-600 mb-1">搜索关键词</label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索消息、详情..."
            className="w-full px-3 py-1.5 [@media(pointer:coarse)]:min-h-11 text-sm [@media(pointer:coarse)]:text-[16px] border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        
        <div className="min-w-[150px]">
          <label className="block text-xs text-gray-600 mb-1">事件分类</label>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value as any)}
            className="w-full px-3 py-1.5 [@media(pointer:coarse)]:min-h-11 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">全部分类</option>
            {Object.entries(CATEGORY_LABELS).map(([key, { label }]) => (
              <option key={key} value={key}>{label} ({stats.categoryStats[key] || 0})</option>
            ))}
          </select>
        </div>

        <div className="min-w-[120px]">
          <label className="block text-xs text-gray-600 mb-1">日志级别</label>
          <select
            value={selectedLevel}
            onChange={(e) => setSelectedLevel(e.target.value as any)}
            className="w-full px-3 py-1.5 [@media(pointer:coarse)]:min-h-11 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">全部级别</option>
            <option value="debug">调试</option>
            <option value="info">信息</option>
            <option value="warning">警告</option>
            <option value="error">错误</option>
          </select>
        </div>
      </div>

      {/* 日志列表 */}
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 flex items-center justify-between">
          <span>日志记录 ({filteredLogs.length} / {logs.length})</span>
        </div>
        
        <div ref={logContainerRef} className="max-h-[400px] overflow-auto">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <div className="mb-2">{logs.length === 0 ? '暂无日志记录' : '没有符合过滤条件的日志'}</div>
              <div className="text-xs text-gray-400">
                请打开笔记模块并选择一条笔记，观察编辑器初始化日志
              </div>
            </div>
          ) : (
            <div className="divide-y">
              {filteredLogs.map((log) => {
                const Icon = LEVEL_ICONS[log.level];
                const categoryInfo = CATEGORY_LABELS[log.category];
                const CategoryIcon = categoryInfo?.icon || ArrowClockwise;
                
                return (
                  <div key={log.id} className="p-3 hover:bg-gray-50">
                    <div className="flex items-start gap-3">
                      <Icon 
                        size={20} className="mt-0.5 flex-shrink-0" 
                        style={{ color: LEVEL_COLORS[log.level] }}
                      />
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs text-gray-500 font-mono">
                            {new Date(log.ts).toLocaleTimeString(undefined, { 
                              hour12: false, 
                              hour: '2-digit', 
                              minute: '2-digit', 
                              second: '2-digit',
                            })}.{String(log.ts % 1000).padStart(3, '0')}
                          </span>
                          <span className="px-2 py-0.5 text-xs rounded flex items-center gap-1" style={{ 
                            backgroundColor: `${categoryInfo?.color || '#64748b'}20`,
                            color: categoryInfo?.color || '#64748b'
                          }}>
                            <CategoryIcon size={12} />
                            {categoryInfo?.label || log.category}
                          </span>
                          <span className="px-2 py-0.5 text-xs rounded" style={{ 
                            backgroundColor: `${LEVEL_COLORS[log.level]}20`,
                            color: LEVEL_COLORS[log.level]
                          }}>
                            {log.level.toUpperCase()}
                          </span>
                        </div>
                        
                        <div className="text-sm text-gray-800 mb-1 font-medium">
                          {log.message}
                        </div>
                        
                        {log.details && Object.keys(log.details).length > 0 && (
                          <details className="text-xs mt-2">
                            <summary className="cursor-pointer text-gray-600 hover:text-gray-800 [@media(pointer:coarse)]:min-h-11">
                              查看详细信息 ({Object.keys(log.details).length} 项)
                            </summary>
                            <pre className="mt-2 p-2 bg-gray-100 rounded overflow-auto text-xs max-h-48">
                              {JSON.stringify(log.details, null, 2)}
                            </pre>
                          </details>
                        )}
                        
                        {log.domSnapshot && (
                          <details className="text-xs mt-2">
                            <summary className="cursor-pointer text-orange-600 hover:text-orange-800 [@media(pointer:coarse)]:min-h-11">
                              DOM 快照
                            </summary>
                            <pre className="mt-2 p-2 bg-orange-50 rounded overflow-auto text-xs max-h-48">
                              {JSON.stringify(log.domSnapshot, null, 2)}
                            </pre>
                          </details>
                        )}

                        {log.editorSnapshot && (
                          <details className="text-xs mt-2">
                            <summary className="cursor-pointer text-blue-600 hover:text-blue-800 [@media(pointer:coarse)]:min-h-11">
                              编辑器快照
                            </summary>
                            <pre className="mt-2 p-2 bg-blue-50 rounded overflow-auto text-xs max-h-48">
                              {JSON.stringify(log.editorSnapshot, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                      
                      <button
                        onClick={() => copyLog(log)}
                        className="p-1 text-gray-400 hover:text-gray-600 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                        title="复制日志"
                      >
                        <Copy size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 使用说明 */}
      <div className="text-xs text-gray-500 p-3 bg-gray-50 rounded-lg">
        <div className="font-medium mb-1">调试提示：</div>
        <ul className="list-disc list-inside space-y-0.5">
          <li>打开笔记模块，选择一条笔记，观察编辑器初始化日志</li>
          <li>检查「实时 DOM 快照」中的各项状态是否为绿色</li>
          <li>关注 <code className="bg-gray-200 px-1 rounded">data-ready</code> 和 <code className="bg-gray-200 px-1 rounded">contentEditable</code> 属性</li>
          <li>错误日志会显示 Prism/Milkdown 相关的加载失败信息</li>
          <li>点击「快照」按钮手动捕获当前 DOM 状态</li>
        </ul>
      </div>
    </div>
  );
};

serveDebugChannel(CREPE_EDITOR_DEBUG_CHANNEL, { emitCrepeDebug, captureDOMSnapshot });

export default CrepeEditorDebugPlugin;
