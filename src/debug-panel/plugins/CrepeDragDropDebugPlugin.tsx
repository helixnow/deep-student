/**
 * Crepe 编辑器拖放调试插件
 * 全面监控拖放功能的完整生命周期，用于诊断拖放无法工作的问题
 * 
 * 监控范围：
 * - 拖放事件：dragstart, dragover, dragenter, dragleave, drop, dragend
 * - BlockService 状态：active node, selection, dragging
 * - ProseMirror 状态：view.dragging, selection
 * - DOM 属性：draggable, data-dragging
 * - 事件传播：是否被阻止、目标元素
 */

import React from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  Copy, Clipboard, Trash, Play, Pause, Eye,
  Warning, CheckCircle, XCircle, DotsSixVertical,
  Target
} from '@phosphor-icons/react';
import { showGlobalNotification } from '../../components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { EVENT_COLORS, EVENT_ICONS, type DiagnosisResult, type DragEventLog, type DragEventType } from './crepeDragDrop/model';
import {
  captureBlockHandleState, captureDOMState, captureEditorState, detectIssues, getElementPath, resolveTargetElement,
} from './crepeDragDrop/capture';
import { diagnoseLogs, probeEditor } from './crepeDragDrop/diagnosis';

export { CREPE_DRAG_DEBUG_EVENT, type CrepeDragDebugEventDetail } from './crepeDragDrop/model';

// ============ 插件组件 ============

const CrepeDragDropDebugPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActive, isActivated }) => {
  const [logs, setLogs] = React.useState<DragEventLog[]>([]);
  const [isRecording, setIsRecording] = React.useState(true);
  const [selectedEventTypes, setSelectedEventTypes] = React.useState<Set<DragEventType>>(new Set([
    'dragstart', 'dragover', 'dragenter', 'dragleave', 'drop', 'dragend', 'mousedown', 'mouseup'
  ]));
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [showIssuesOnly, setShowIssuesOnly] = React.useState(false);
  const logContainerRef = React.useRef<HTMLDivElement>(null);
  const listenersRef = React.useRef<Map<string, EventListener>>(new Map());

  const append = React.useCallback((entry: Omit<DragEventLog, 'id'>) => {
    if (!isRecording) return;
    setLogs(prev => {
      const next = [...prev, { ...entry, id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }];
      return next.slice(-300);
    });
  }, [isRecording]);

  // 设置事件监听
  React.useEffect(() => {
    if (!isActivated) return;

    console.log('[CrepeDragDropDebug] 插件激活，开始监听事件...');
    
    // 在 block handle 上添加调试监听器
    let cleanupBlockHandleDebug: (() => void) | undefined;
    const setupBlockHandleDebug = (): (() => void) => {
      const blockHandle = document.querySelector('.milkdown-block-handle');
      if (blockHandle) {
        console.log('[CrepeDragDropDebug] Block handle found, adding debug listeners');
        console.log('[CrepeDragDropDebug] Block handle draggable:', (blockHandle as HTMLElement).draggable);
        console.log('[CrepeDragDropDebug] Block handle children:', blockHandle.children.length);
        
        // 监听 block handle 自身的事件
        const debugMousedown = (e: Event) => {
          console.log('[CrepeDragDropDebug] Block handle mousedown (direct):', e.target);
        };
        const debugDragstart = (e: Event) => {
          console.log('[CrepeDragDropDebug] Block handle dragstart (direct):', e.target, (e as DragEvent).dataTransfer);
        };
        blockHandle.addEventListener('mousedown', debugMousedown, { capture: true });
        blockHandle.addEventListener('dragstart', debugDragstart, { capture: true });
        
        return () => {
          blockHandle.removeEventListener('mousedown', debugMousedown, { capture: true });
          blockHandle.removeEventListener('dragstart', debugDragstart, { capture: true });
        };
      } else {
        console.warn('[CrepeDragDropDebug] Block handle not found, retrying in 1s...');
        // RUST-FIX(RF-W19-crepe-drag-block-handle-retry-leak): 原实现只留第一次的清理，面板关闭后重试与后挂的监听器都停不下来
        const timer = setTimeout(() => {
          cleanupBlockHandleDebug = setupBlockHandleDebug();
        }, 1000);
        return () => clearTimeout(timer);
      }
    };
    
    cleanupBlockHandleDebug = setupBlockHandleDebug();

    const eventTypes: DragEventType[] = [
      'mousedown', 'mouseup', 'pointerdown', 'pointerup',
      'dragstart', 'drag', 'dragover', 'dragenter', 'dragleave', 'drop', 'dragend'
    ];

    const createHandler = (type: DragEventType, phase: 'capture' | 'bubble') => {
      return (e: Event) => {
        const event = e as DragEvent | MouseEvent | PointerEvent;
        const elementTarget = resolveTargetElement(event.target);

        // 只监听与编辑器相关的事件
        const isEditorRelated = elementTarget?.closest('.crepe-editor-wrapper') || 
                                elementTarget?.closest('.milkdown-block-handle') ||
                                elementTarget?.closest('.milkdown');
        
        // 对于 drag 相关事件，即使不在编辑器内也要记录（因为可能是拖拽过程中）
        const isDragEvent = ['dragstart', 'drag', 'dragover', 'dragenter', 'dragleave', 'drop', 'dragend'].includes(type);
        
        // 对于 mouse/pointer 事件，也要记录 block handle 上的
        const isMouseEvent = ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].includes(type);
        const isOnBlockHandle = elementTarget?.closest('.milkdown-block-handle');
        
        if (!elementTarget && !isDragEvent) return;
        if (!isEditorRelated && !isDragEvent && !(isMouseEvent && isOnBlockHandle)) return;
        
        // 跳过频繁的 drag 和 dragover 事件（节流）
        if ((type === 'drag' || type === 'dragover') && Math.random() > 0.1) return;

        console.log(`[CrepeDragDropDebug] 捕获事件: ${type}`, { target: elementTarget?.tagName, className: elementTarget?.className });

        const editorState = captureEditorState();
        const blockHandleState = captureBlockHandleState();
        const domState = captureDOMState();
        const issues = detectIssues(event, type, editorState, blockHandleState, domState);

        let dataTransfer: DragEventLog['dataTransfer'] | undefined;
        if ('dataTransfer' in event && event.dataTransfer) {
          dataTransfer = {
            effectAllowed: event.dataTransfer.effectAllowed,
            dropEffect: event.dataTransfer.dropEffect,
            types: Array.from(event.dataTransfer.types),
            hasData: event.dataTransfer.types.length > 0,
          };
        }

        append({
          ts: Date.now(),
          type,
          phase,
          target: getElementPath(elementTarget),
          currentTarget: getElementPath(resolveTargetElement(event.currentTarget as EventTarget)),
          relatedTarget: 'relatedTarget' in event ? getElementPath(resolveTargetElement((event as DragEvent).relatedTarget as EventTarget)) : undefined,
          clientX: event.clientX,
          clientY: event.clientY,
          dataTransfer,
          defaultPrevented: event.defaultPrevented,
          propagationStopped: false,
          immediatePropagationStopped: false,
          editorState,
          blockHandleState,
          domState,
          issues,
        });
      };
    };

    // 在 capture 阶段监听 - 使用 document 来捕获所有事件
    eventTypes.forEach(type => {
      const captureHandler = createHandler(type, 'capture');
      const key = `${type}-capture`;
      listenersRef.current.set(key, captureHandler as EventListener);
      window.addEventListener(type, captureHandler, { capture: true, passive: true });
    });

    // 记录初始化
    const domState = captureDOMState();
    console.log('[CrepeDragDropDebug] 初始 DOM 状态:', domState);
    
    append({
      ts: Date.now(),
      type: 'dragstart',
      phase: 'capture',
      target: 'system',
      currentTarget: 'system',
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      domState,
      issues: ['📍 拖放调试插件已激活，等待拖放操作...'],
    });

    return () => {
      console.log('[CrepeDragDropDebug] 清理事件监听器');
      cleanupBlockHandleDebug?.();
      listenersRef.current.forEach((handler, key) => {
        const [type] = key.split('-');
        window.removeEventListener(type, handler, { capture: true });
      });
      listenersRef.current.clear();
    };
  }, [isActivated, append]);

  // 自动滚动
  React.useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const clearLogs = React.useCallback(() => setLogs([]), []);

  // 运行完整诊断
  const runDiagnosis = React.useCallback(() => {
    const results = probeEditor();
    
    // 添加到日志
    append({
      ts: Date.now(),
      type: 'dragstart',
      phase: 'capture',
      target: 'diagnosis',
      currentTarget: 'diagnosis',
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      domState: captureDOMState(),
      issues: results,
    });
    
    showGlobalNotification('info', '诊断完成，请查看日志');
  }, [append]);

  const filteredLogs = React.useMemo(() => {
    return logs.filter(log => {
      if (!selectedEventTypes.has(log.type)) return false;
      if (showIssuesOnly && log.issues.length === 0) return false;
      return true;
    });
  }, [logs, selectedEventTypes, showIssuesOnly]);

  const copyAllLogs = React.useCallback(() => {
    const text = JSON.stringify(filteredLogs.map(log => ({
      timestamp: new Date(log.ts).toISOString(),
      ...log,
    })), null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', `已复制 ${filteredLogs.length} 条日志`);
    }).catch(console.error);
  }, [filteredLogs]);

  const copyLog = React.useCallback((log: DragEventLog) => {
    const text = JSON.stringify({
      timestamp: new Date(log.ts).toISOString(),
      ...log,
    }, null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', '日志已复制');
    }).catch(console.error);
  }, []);

  // 诊断分析
  const diagnosis = React.useMemo((): DiagnosisResult[] => diagnoseLogs(logs), [logs]);

  const stats = React.useMemo(() => {
    const counts: Record<DragEventType, number> = {} as any;
    const issueCount = logs.filter(l => l.issues.length > 0).length;
    
    logs.forEach(log => {
      counts[log.type] = (counts[log.type] || 0) + 1;
    });
    
    return { counts, issueCount };
  }, [logs]);

  const toggleEventType = (type: DragEventType) => {
    setSelectedEventTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  if (!isActivated) return null;

  return (
    <div className="p-4 space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <DotsSixVertical size={20} />
          Crepe 拖放调试
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setIsRecording(!isRecording)}
            className={`px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm rounded flex items-center gap-1 ${
              isRecording ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-700'
            }`}
          >
            {isRecording ? <Pause size={16} /> : <Play size={16} />}
            {isRecording ? '录制中' : '已暂停'}
          </button>
          <button
            onClick={() => setShowIssuesOnly(!showIssuesOnly)}
            className={`px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm rounded ${showIssuesOnly ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-700'}`}
          >
            <Warning size={16} />
          </button>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm rounded ${autoScroll ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-700'}`}
          >
            自动滚动
          </button>
          <button
            onClick={runDiagnosis}
            className="px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm bg-purple-500 text-white rounded hover:bg-purple-600 flex items-center gap-1"
          >
            <Target size={16} />
            运行诊断
          </button>
          <button
            onClick={copyAllLogs}
            className="px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
            disabled={filteredLogs.length === 0}
          >
            <Clipboard size={16} />
          </button>
          <button
            onClick={clearLogs}
            className="px-3 py-1 [@media(pointer:coarse)]:min-h-11 text-sm bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            <Trash size={16} />
          </button>
        </div>
      </div>

      {/* 诊断面板 */}
      <div className="border rounded-lg p-3 bg-gradient-to-r from-slate-50 to-blue-50">
        <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
          <Eye size={16} />
          实时诊断
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
          {diagnosis.map((d, i) => (
            <div
              key={i}
              className={`p-2 rounded text-xs ${
                d.status === 'ok' ? 'bg-green-100 border-green-300' :
                d.status === 'warning' ? 'bg-yellow-100 border-yellow-300' :
                'bg-red-100 border-red-300'
              } border`}
            >
              <div className="font-medium flex items-center gap-1">
                {d.status === 'ok' ? <CheckCircle size={12} className="text-green-600" /> :
                 d.status === 'warning' ? <Warning size={12} className="text-yellow-600" /> :
                 <XCircle size={12} className="text-red-600" />}
                {d.category}
              </div>
              <div className="text-gray-700 mt-0.5">{d.message}</div>
              {d.details && <div className="text-gray-500 mt-0.5">{d.details}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* 事件类型过滤 */}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(EVENT_COLORS) as DragEventType[]).map(type => (
          <button
            key={type}
            onClick={() => toggleEventType(type)}
            className={`px-2 py-1 [@media(pointer:coarse)]:min-h-11 text-xs rounded-full transition-all ${
              selectedEventTypes.has(type) ? 'ring-2 ring-offset-1' : 'opacity-50'
            }`}
            style={{ 
              backgroundColor: `${EVENT_COLORS[type]}20`,
              color: EVENT_COLORS[type],
            }}
          >
            {type}: {stats.counts[type] || 0}
          </button>
        ))}
      </div>

      {/* 统计 */}
      <div className="flex items-center gap-4 text-sm">
        <span className="text-gray-500">总计: {logs.length}</span>
        <span className="text-gray-500">已过滤: {filteredLogs.length}</span>
        <span className={`${stats.issueCount > 0 ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
          问题: {stats.issueCount}
        </span>
      </div>

      {/* 日志列表 */}
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700">
          事件日志
        </div>
        <div ref={logContainerRef} className="max-h-[400px] overflow-auto">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <div className="mb-2">暂无日志</div>
              <div className="text-xs text-gray-400">
                尝试拖拽编辑器中的 block handle（六个点图标）
              </div>
            </div>
          ) : (
            <div className="divide-y text-xs font-mono">
              {filteredLogs.map((log) => {
                const Icon = EVENT_ICONS[log.type];
                const color = EVENT_COLORS[log.type];
                
                return (
                  <div 
                    key={log.id} 
                    className={`p-2 hover:bg-gray-50 ${log.issues.length > 0 ? 'bg-red-50' : ''}`}
                  >
                    <div className="flex items-start gap-2">
                      <Icon size={16} className="mt-0.5 flex-shrink-0" style={{ color }} />
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-gray-500">
                            {new Date(log.ts).toLocaleTimeString(undefined, { 
                              hour12: false,
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}.{String(log.ts % 1000).padStart(3, '0')}
                          </span>
                          <span 
                            className="px-2 py-0.5 rounded font-medium"
                            style={{ backgroundColor: `${color}20`, color }}
                          >
                            {log.type}
                          </span>
                          <span className="text-gray-400">{log.phase}</span>
                          <span className="text-gray-500">({log.clientX}, {log.clientY})</span>
                          {log.defaultPrevented && (
                            <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-[10px]">
                              prevented
                            </span>
                          )}
                          {log.propagationStopped && (
                            <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded text-[10px]">
                              stopped
                            </span>
                          )}
                        </div>
                        
                        <div className="text-gray-600 mt-1 truncate" title={log.target}>
                          → {log.target}
                        </div>

                        {log.issues.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {log.issues.map((issue, i) => (
                              <div key={i} className="text-red-600">{issue}</div>
                            ))}
                          </div>
                        )}

                        {(log.dataTransfer || log.editorState || log.domState) && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-blue-600 hover:text-blue-800 [@media(pointer:coarse)]:min-h-11">
                              详细信息
                            </summary>
                            <div className="mt-1 p-2 bg-gray-100 rounded overflow-auto max-h-32">
                              {log.dataTransfer && (
                                <div className="mb-1">
                                  <span className="text-gray-500">dataTransfer:</span>{' '}
                                  {JSON.stringify(log.dataTransfer)}
                                </div>
                              )}
                              {log.editorState && (
                                <div className="mb-1">
                                  <span className="text-gray-500">editorState:</span>{' '}
                                  {JSON.stringify(log.editorState)}
                                </div>
                              )}
                              {log.domState && (
                                <div>
                                  <span className="text-gray-500">domState:</span>{' '}
                                  {JSON.stringify(log.domState)}
                                </div>
                              )}
                            </div>
                          </details>
                        )}
                      </div>

                      <button
                        onClick={() => copyLog(log)}
                        className="p-1 text-gray-400 hover:text-gray-600 flex-shrink-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                        title="复制日志"
                      >
                        <Copy size={12} />
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
        <div className="font-medium mb-1">调试步骤：</div>
        <ol className="list-decimal list-inside space-y-0.5">
          <li>在笔记编辑器中输入几行文本</li>
          <li>将鼠标悬停在某一行左侧，等待 block handle（+ 和 ⋮⋮）出现</li>
          <li>按住拖拽手柄（六个点），开始拖动</li>
          <li>观察日志中的 <code className="bg-gray-200 px-1 rounded">dragstart</code> 事件</li>
          <li>拖动到目标位置，观察 <code className="bg-gray-200 px-1 rounded">dragover</code> 是否有 <code className="bg-gray-200 px-1 rounded">prevented</code></li>
          <li>松开鼠标，观察是否有 <code className="bg-gray-200 px-1 rounded">drop</code> 事件</li>
          <li>检查「实时诊断」面板中的问题提示</li>
        </ol>
      </div>
    </div>
  );
};

export default CrepeDragDropDebugPlugin;
