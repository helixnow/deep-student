import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { Trash2, Copy, Play, Pause, FolderInput, FileText, Folder, AlertTriangle, CheckCircle } from 'lucide-react';

interface DragEvent {
  id: string;
  type: 'drag_start' | 'drag_end';
  activeId: string | number;
  overId?: string | number | null;
  timestamp: number;
  targetType?: string;
  targetName?: string;
  result?: 'success' | 'no_target' | 'same_id' | 'not_folder';
}

/**
 * Learning Hub Finder 拖放调试插件
 * 
 * 用于监听和调试 dnd-kit 拖放事件
 */
export default function FinderDragDropDebugPlugin({ isActive, isActivated }: DebugPanelPluginProps) {
  const { t } = useTranslation('debug_panel');
  const [events, setEvents] = useState<DragEvent[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActivated) return;

    const handleDragDebug = (e: CustomEvent<DragEvent>) => {
      if (isPaused) return;
      
      const event: DragEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ...e.detail,
      };
      
      setEvents(prev => [event, ...prev].slice(0, 100)); // 保留最近 100 条
    };

    window.addEventListener('finder-drag-debug', handleDragDebug as EventListener);
    return () => {
      window.removeEventListener('finder-drag-debug', handleDragDebug as EventListener);
    };
  }, [isActivated, isPaused]);

  const clearEvents = () => setEvents([]);
  
  const copyToClipboard = () => {
    const text = events.map(e => 
      `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.type}: active=${e.activeId}, over=${e.overId ?? 'null'}`
    ).join('\n');
    navigator.clipboard.writeText(text);
  };

  const getEventIcon = (event: DragEvent) => {
    if (event.type === 'drag_start') {
      return <Play className="w-4 h-4 text-blue-500" />;
    }
    if (event.overId === null) {
      return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    }
    return <CheckCircle className="w-4 h-4 text-green-500" />;
  };

  const formatTime = (ts: number) => {
    const date = new Date(ts);
    const timeStr = date.toLocaleTimeString(undefined, { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
    });
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${timeStr}.${ms}`;
  };

  if (!isActive) return null;

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <FolderInput className="w-5 h-5 text-primary" />
          <span className="font-medium">Finder 拖放调试</span>
          <span className="text-xs text-muted-foreground">({events.length} 事件)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsPaused(!isPaused)}
            className={`p-1.5 rounded hover:bg-muted ${isPaused ? 'text-yellow-500' : 'text-muted-foreground'}`}
            title={isPaused ? '继续记录' : '暂停记录'}
          >
            {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
          </button>
          <button
            onClick={copyToClipboard}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            title="复制日志"
          >
            <Copy className="w-4 h-4" />
          </button>
          <button
            onClick={clearEvents}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            title="清除日志"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Instructions */}
      <div className="p-3 border-b border-border bg-blue-500/10">
        <div className="text-xs text-blue-600 dark:text-blue-400">
          <p className="font-medium mb-1">📋 使用说明：</p>
          <p>1. 打开 Learning Hub 侧边栏</p>
          <p>2. 拖拽文件/笔记到文件夹上</p>
          <p>3. 观察下方日志中 DragEnd 的 overId 是否为目标文件夹 ID</p>
          <p className="mt-1 text-yellow-600 dark:text-yellow-400">
            ⚠️ 如果 overId 始终为 null，说明碰撞检测未识别到文件夹
          </p>
        </div>
      </div>

      {/* Event List */}
      <div ref={containerRef} className="flex-1 overflow-auto p-2 space-y-1">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <FolderInput className="w-12 h-12 mb-2 opacity-30" />
            <p className="text-sm">等待拖放事件...</p>
            <p className="text-xs mt-1">在 Learning Hub 中拖拽文件到文件夹</p>
          </div>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className={`p-2 rounded border text-xs font-mono ${
                event.type === 'drag_start' 
                  ? 'bg-blue-500/10 border-blue-500/30' 
                  : event.overId 
                    ? 'bg-green-500/10 border-green-500/30'
                    : 'bg-yellow-500/10 border-yellow-500/30'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                {getEventIcon(event)}
                <span className="font-semibold">
                  {event.type === 'drag_start' ? 'DragStart' : 'DragEnd'}
                </span>
                <span className="text-muted-foreground ml-auto">
                  {formatTime(event.timestamp)}
                </span>
              </div>
              <div className="pl-6 space-y-0.5 text-muted-foreground">
                <div>
                  <span className="text-foreground">activeId:</span>{' '}
                  <span className="text-blue-500">{String(event.activeId)}</span>
                </div>
                {event.type === 'drag_end' && (
                  <div>
                    <span className="text-foreground">overId:</span>{' '}
                    <span className={event.overId ? 'text-green-500' : 'text-yellow-500'}>
                      {event.overId ?? 'null (无目标)'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer - Quick Stats */}
      <div className="p-2 border-t border-border bg-muted/20 text-xs">
        <div className="flex justify-between text-muted-foreground">
          <span>
            开始: {events.filter(e => e.type === 'drag_start').length}
          </span>
          <span>
            成功放置: {events.filter(e => e.type === 'drag_end' && e.overId).length}
          </span>
          <span>
            未检测到目标: {events.filter(e => e.type === 'drag_end' && !e.overId).length}
          </span>
        </div>
      </div>
    </div>
  );
}
