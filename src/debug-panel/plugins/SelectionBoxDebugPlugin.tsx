import React, { useState, useEffect, useRef } from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { Trash, Copy, Play, Pause, Square, Cursor } from '@phosphor-icons/react';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

interface SelectionEvent {
  id: string;
  type: 'mouse_down' | 'mouse_move' | 'mouse_up' | 'selection_start' | 'selection_end' | 'render_position';
  timestamp: number;
  // 光标位置
  clientX?: number;
  clientY?: number;
  // 框选框位置
  boxStartX?: number;
  boxStartY?: number;
  boxEndX?: number;
  boxEndY?: number;
  // 偏移量
  offsetX?: number;
  offsetY?: number;
  // 选中数量
  selectedCount?: number;
  // 渲染位置相关
  expectedLeft?: number;
  expectedTop?: number;
  expectedWidth?: number;
  expectedHeight?: number;
  actualLeft?: number;
  actualTop?: number;
  actualWidth?: number;
  actualHeight?: number;
  renderOffsetX?: number;
  renderOffsetY?: number;
}

/**
 * 框选调试插件
 * 
 * 用于监听光标和框选框之间的偏移
 */
export default function SelectionBoxDebugPlugin({ isActive, isActivated }: DebugPanelPluginProps) {
  const [events, setEvents] = useState<SelectionEvent[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [showOnlyMove, setShowOnlyMove] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActivated) return;

    const handleSelectionDebug = (e: CustomEvent<SelectionEvent>) => {
      if (isPaused) return;
      
      const event: SelectionEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ...e.detail,
      };
      
      setEvents(prev => [event, ...prev].slice(0, 200)); // 保留最近 200 条
    };

    window.addEventListener('selection-box-debug', handleSelectionDebug as EventListener);
    return () => {
      window.removeEventListener('selection-box-debug', handleSelectionDebug as EventListener);
    };
  }, [isActivated, isPaused]);

  const clearEvents = () => setEvents([]);
  
  const copyToClipboard = () => {
    const filteredEvents = showOnlyMove 
      ? events.filter(e => e.type === 'mouse_move' || e.type === 'render_position')
      : events;
    
    const text = filteredEvents.map(e => {
      const time = new Date(e.timestamp).toLocaleTimeString(undefined, {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }) + '.' + String(new Date(e.timestamp).getMilliseconds()).padStart(3, '0');
      
      if (e.type === 'render_position') {
        return `[${time}] ${e.type}: expected=(${e.expectedLeft}, ${e.expectedTop}) actual=(${e.actualLeft}, ${e.actualTop}) render_offset=(${e.renderOffsetX}, ${e.renderOffsetY})`;
      }
      
      let line = `[${time}] ${e.type}: cursor=(${e.clientX}, ${e.clientY})`;
      if (e.boxEndX !== undefined && e.boxEndY !== undefined) {
        line += ` box_end=(${e.boxEndX}, ${e.boxEndY})`;
      }
      if (e.offsetX !== undefined && e.offsetY !== undefined) {
        line += ` offset=(${e.offsetX}, ${e.offsetY})`;
      }
      if (e.selectedCount !== undefined) {
        line += ` selected=${e.selectedCount}`;
      }
      return line;
    }).join('\n');
    
    copyTextToClipboard(text);
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

  const getEventColor = (type: string) => {
    switch (type) {
      case 'mouse_down': return 'bg-blue-500/10 border-blue-500/30';
      case 'mouse_move': return 'bg-gray-500/10 border-gray-500/30';
      case 'mouse_up': return 'bg-purple-500/10 border-purple-500/30';
      case 'selection_start': return 'bg-green-500/10 border-green-500/30';
      case 'selection_end': return 'bg-orange-500/10 border-orange-500/30';
      case 'render_position': return 'bg-pink-500/10 border-pink-500/30';
      default: return 'bg-gray-500/10 border-gray-500/30';
    }
  };

  const filteredEvents = showOnlyMove 
    ? events.filter(e => e.type === 'mouse_move')
    : events;

  // 计算平均偏移
  const moveEvents = events.filter(e => e.type === 'mouse_move' && e.offsetX !== undefined);
  const avgOffsetX = moveEvents.length > 0 
    ? Math.round(moveEvents.reduce((sum, e) => sum + (e.offsetX || 0), 0) / moveEvents.length)
    : 0;
  const avgOffsetY = moveEvents.length > 0 
    ? Math.round(moveEvents.reduce((sum, e) => sum + (e.offsetY || 0), 0) / moveEvents.length)
    : 0;

  if (!isActive) return null;

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Square size={20} className="text-primary" />
          <span className="font-medium">框选调试</span>
          <span className="text-xs text-muted-foreground">({filteredEvents.length} 事件)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowOnlyMove(!showOnlyMove)}
            className={`px-2 py-1 text-xs rounded ${showOnlyMove ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            title="只显示 mouse_move 事件"
          >
            仅Move
          </button>
          <button
            onClick={() => setIsPaused(!isPaused)}
            className={`p-1.5 rounded hover:bg-muted ${isPaused ? 'text-yellow-500' : 'text-muted-foreground'}`}
            title={isPaused ? '继续记录' : '暂停记录'}
          >
            {isPaused ? <Play size={16} /> : <Pause size={16} />}
          </button>
          <button
            onClick={copyToClipboard}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            title="复制日志"
          >
            <Copy size={16} />
          </button>
          <button
            onClick={clearEvents}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            title="清除日志"
          >
            <Trash size={16} />
          </button>
        </div>
      </div>

      {/* Stats */}
      {moveEvents.length > 0 && (
        <div className="p-3 border-b border-border bg-yellow-500/10">
          <div className="text-xs">
            <p className="font-medium mb-1 text-yellow-600 dark:text-yellow-400">📊 偏移统计：</p>
            <p>平均偏移: X={avgOffsetX}px, Y={avgOffsetY}px</p>
            <p className="mt-1 text-muted-foreground">
              如果偏移不为 0，说明框选框端点与光标位置不一致
            </p>
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="p-3 border-b border-border bg-blue-500/10">
        <div className="text-xs text-blue-600 dark:text-blue-400">
          <p className="font-medium mb-1">📋 使用说明：</p>
          <p>1. 打开 Learning Hub 侧边栏（网格视图）</p>
          <p>2. 在空白区域按住鼠标拖拽进行框选</p>
          <p>3. 观察光标位置与框选框端点的偏移</p>
        </div>
      </div>

      {/* Event List */}
      <div ref={containerRef} className="flex-1 overflow-auto p-2 space-y-1">
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Cursor size={48} className="mb-2 opacity-30" />
            <p className="text-sm">等待框选事件...</p>
            <p className="text-xs mt-1">在 Learning Hub 网格视图中拖拽框选</p>
          </div>
        ) : (
          filteredEvents.map((event) => (
            <div
              key={event.id}
              className={`p-2 rounded border text-xs font-mono ${getEventColor(event.type)}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold">{event.type}</span>
                <span className="text-muted-foreground ml-auto">
                  {formatTime(event.timestamp)}
                </span>
              </div>
              <div className="pl-2 space-y-0.5 text-muted-foreground">
                {event.type === 'render_position' ? (
                  <>
                    <div>
                      <span className="text-foreground">期望位置:</span>{' '}
                      <span className="text-blue-500">({event.expectedLeft}, {event.expectedTop})</span>
                    </div>
                    <div>
                      <span className="text-foreground">实际位置:</span>{' '}
                      <span className="text-green-500">({event.actualLeft}, {event.actualTop})</span>
                    </div>
                    <div>
                      <span className="text-foreground">渲染偏移:</span>{' '}
                      <span className={event.renderOffsetX === 0 && event.renderOffsetY === 0 ? 'text-green-500' : 'text-red-500 font-bold'}>
                        ({event.renderOffsetX}, {event.renderOffsetY})
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    {event.clientX !== undefined && (
                      <div>
                        <span className="text-foreground">光标:</span>{' '}
                        <span className="text-blue-500">({event.clientX}, {event.clientY})</span>
                      </div>
                    )}
                    {event.boxEndX !== undefined && event.boxEndY !== undefined && (
                      <div>
                        <span className="text-foreground">框端点:</span>{' '}
                        <span className="text-green-500">({event.boxEndX}, {event.boxEndY})</span>
                      </div>
                    )}
                    {event.offsetX !== undefined && event.offsetY !== undefined && (
                      <div>
                        <span className="text-foreground">偏移:</span>{' '}
                        <span className={event.offsetX === 0 && event.offsetY === 0 ? 'text-green-500' : 'text-yellow-500'}>
                          ({event.offsetX}, {event.offsetY})
                        </span>
                      </div>
                    )}
                    {event.selectedCount !== undefined && (
                      <div>
                        <span className="text-foreground">选中:</span>{' '}
                        <span className="text-purple-500">{event.selectedCount} 项</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="p-2 border-t border-border bg-muted/20 text-xs">
        <div className="flex justify-between text-muted-foreground">
          <span>总事件: {events.length}</span>
          <span>Move: {events.filter(e => e.type === 'mouse_move').length}</span>
          <span>平均偏移: ({avgOffsetX}, {avgOffsetY})</span>
        </div>
      </div>
    </div>
  );
}
