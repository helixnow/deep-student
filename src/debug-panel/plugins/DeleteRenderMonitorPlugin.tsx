import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { CHAT_DELETE_RENDER_EVENT, type ChatDeleteRenderEventDetail } from '../events';

const MAX_EVENTS = 80;

const formatDuration = (ms: number) => `${ms.toFixed(0)} ms`;

const DeleteRenderMonitorPlugin: React.FC<DebugPanelPluginProps> = ({ isActive, isActivated }) => {
  const bufferRef = useRef<ChatDeleteRenderEventDetail[]>([]);
  const [events, setEvents] = useState<ChatDeleteRenderEventDetail[]>([]);

  useEffect(() => {
    if (!isActivated) return;
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<ChatDeleteRenderEventDetail>).detail;
      bufferRef.current = [...bufferRef.current, detail].slice(-MAX_EVENTS);
      if (isActive) {
        setEvents(bufferRef.current.slice());
      }
    };
    window.addEventListener(CHAT_DELETE_RENDER_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(CHAT_DELETE_RENDER_EVENT, handler as EventListener);
    };
  }, [isActive]);

  useEffect(() => {
    if (!isActivated) return;
    if (isActive) {
      setEvents(bufferRef.current.slice());
    }
  }, [isActive, isActivated]);

  const grouped = useMemo(() => {
    const map = new Map<string, ChatDeleteRenderEventDetail>();
    for (const evt of bufferRef.current) {
      map.set(evt.trackingId, evt);
    }
    return Array.from(map.values()).sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));
  }, [events]);

  const clearLogs = useCallback(() => {
    bufferRef.current = [];
    setEvents([]);
  }, []);

  const copyLogs = useCallback(() => {
    try {
      const payload = JSON.stringify(bufferRef.current, null, 2);
      void navigator.clipboard.writeText(payload);
    } catch (err) {
      console.error('[DeleteRenderMonitor] 复制失败', err);
    }
  }, []);

  if (!isActivated) return null;

  return (
    <div className="debug-plugin-section space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            删除动作触发后，每次 `chatHistory` 引用变化都会记录一次渲染，帮助确认是否存在额外的全局刷新。
          </p>
          <p className="text-xs text-muted-foreground">
            事件来源：`{CHAT_DELETE_RENDER_EVENT}`。最多保留 {MAX_EVENTS} 条最新记录。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="text-xs px-2 py-1 border rounded hover:bg-muted disabled:opacity-50"
            onClick={copyLogs}
            disabled={bufferRef.current.length === 0}
          >
            复制 JSON
          </button>
          <button
            className="text-xs px-2 py-1 border rounded hover:bg-muted disabled:opacity-50"
            onClick={clearLogs}
            disabled={bufferRef.current.length === 0}
          >
            清空
          </button>
        </div>
      </div>
      <div className="overflow-auto border rounded-lg">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted text-left">
              <th className="px-2 py-1">Tracking ID</th>
              <th className="px-2 py-1">Stable ID</th>
              <th className="px-2 py-1">渲染次数</th>
              <th className="px-2 py-1">是否已移除</th>
              <th className="px-2 py-1">耗时</th>
              <th className="px-2 py-1">chatHistory 长度</th>
              <th className="px-2 py-1">时间</th>
            </tr>
          </thead>
          <tbody>
            {grouped.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2 py-3 text-center text-muted-foreground">
                  暂无记录，执行删除操作后会自动捕获渲染次数。
                </td>
              </tr>
            ) : (
              grouped.map(evt => (
                <tr key={`${evt.trackingId}-${evt.renderCount}`} className="border-t">
                  <td className="px-2 py-1 font-mono">{evt.trackingId}</td>
                  <td className="px-2 py-1 font-mono">{evt.stableId || 'local'}</td>
                  <td className="px-2 py-1">{evt.renderCount}</td>
                  <td className="px-2 py-1">{evt.removed ? '是' : '否'}</td>
                  <td className="px-2 py-1">{formatDuration(evt.durationMs)}</td>
                  <td className="px-2 py-1">{evt.chatHistoryLength}</td>
                  <td className="px-2 py-1">{new Date(evt.timestamp).toLocaleTimeString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

DeleteRenderMonitorPlugin.displayName = 'DeleteRenderMonitorPlugin';

export default DeleteRenderMonitorPlugin;
