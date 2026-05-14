import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Switch } from '@/components/ui/shad/Switch';

export interface StreamResponseMonitorPluginProps {
  visible: boolean;
  isActive: boolean;
  isActivated: boolean;
  onClose: () => void;
  currentStreamId?: string;
}

interface StreamChunk {
  streamId: string;
  channel: 'data' | 'reasoning';
  content: string;
  timestamp: number;
  isComplete?: boolean;
}

const StreamResponseMonitorPlugin: React.FC<StreamResponseMonitorPluginProps> = ({
  visible,
  isActive,
  isActivated,
  currentStreamId,
}) => {
  const { t } = useTranslation('common');
  const [chunks, setChunks] = useState<StreamChunk[]>([]);
  const [accumulatedContent, setAccumulatedContent] = useState<Map<string, string>>(new Map());
  const [activeStreams, setActiveStreams] = useState<Set<string>>(new Set());
  const unlistenersRef = useRef<Map<string, UnlistenFn[]>>(new Map());
  const contentRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filterStreamId, setFilterStreamId] = useState<string>('');

  // 监听所有 chat_stream_*_data 和 chat_stream_*_reasoning 事件
  useEffect(() => {
    if (!isActivated) {
      // 清理所有监听器
      unlistenersRef.current.forEach((unlisteners) => {
        unlisteners.forEach((unlisten) => {
          try {
            unlisten();
          } catch (e) {
            console.warn('Failed to unlisten:', e);
          }
        });
      });
      unlistenersRef.current.clear();
      return;
    }

    // 动态监听所有匹配的事件
    // 由于 Tauri 不支持通配符监听，我们需要通过其他方式
    // 这里我们监听已知的事件模式，或者使用全局事件

    // 方案：监听所有可能的 chat_stream 事件
    // 由于无法预知所有 stream ID，我们使用一个全局监听机制
    // 通过监听 window 上的自定义事件来捕获流式响应

    const handleStreamEvent = (event: CustomEvent) => {
      const detail = event.detail;
      if (!detail) return;

      // 检查是否是流式内容事件（content 或 reasoning channel）
      const channel = detail.channel;
      if (channel !== 'content' && channel !== 'reasoning') return;

      const eventName = detail.eventName || '';
      // 匹配 chat_stream_{id}_data 或 chat_stream_{id}_reasoning
      const streamIdMatch = eventName.match(/chat_stream_([^_]+)_(data|reasoning)/);
      if (!streamIdMatch) return;

      const [, streamId] = streamIdMatch;
      const payload = detail.payload || {};

      // 过滤：如果指定了 currentStreamId，只显示匹配的流
      if (currentStreamId && streamId !== currentStreamId) return;
      if (filterStreamId && streamId !== filterStreamId) return;

      const content = payload.content || '';
      if (!content && !payload.is_complete) return;

      // 🎯 思维链专用日志
      if (channel === 'reasoning') {
        console.log('[StreamResponseMonitor] 📝 收到思维链分片', {
          streamId,
          eventName,
          chunkLength: content.length,
          chunkPreview: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
          isComplete: payload.is_complete,
          chunkId: payload.chunk_id,
          targetMessageId: detail.targetMessageId,
          timestamp: detail.ts || Date.now(),
        });
      }

      const chunk: StreamChunk = {
        streamId,
        channel: channel as 'data' | 'reasoning',
        content,
        timestamp: detail.ts || Date.now(),
        isComplete: payload.is_complete,
      };

      setChunks((prev) => {
        const newChunks = [...prev, chunk];
        // 限制最大数量，避免内存溢出
        if (newChunks.length > 10000) {
          return newChunks.slice(-5000);
        }
        return newChunks;
      });

      // 累积内容
      setAccumulatedContent((prev) => {
        const key = `${streamId}_${channel}`;
        const existing = prev.get(key) || '';
        const updated = new Map(prev);
        const newAccumulated = existing + content;
        updated.set(key, newAccumulated);
        
        // 🎯 思维链累积日志
        if (channel === 'reasoning') {
          console.log('[StreamResponseMonitor] 📊 思维链累积更新', {
            streamId,
            key,
            previousLength: existing.length,
            chunkLength: content.length,
            newAccumulatedLength: newAccumulated.length,
            isComplete: payload.is_complete,
            accumulatedPreview: newAccumulated.slice(0, 200) + (newAccumulated.length > 200 ? '...' : ''),
          });
        }
        
        return updated;
      });

      setActiveStreams((prev) => {
        const updated = new Set(prev);
        updated.add(streamId);
        return updated;
      });
    };

    // 监听全局流式事件
    window.addEventListener('DSTU_STREAM_EVENT', handleStreamEvent as EventListener);

    return () => {
      window.removeEventListener('DSTU_STREAM_EVENT', handleStreamEvent as EventListener);
    };
  }, [isActivated, currentStreamId, filterStreamId]);

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [chunks.length, autoScroll]);

  // 清空内容
  const handleClear = () => {
    setChunks([]);
    setAccumulatedContent(new Map());
    setActiveStreams(new Set());
  };

  // 获取累积的完整内容
  const getAccumulatedText = (streamId: string): string => {
    const dataKey = `${streamId}_data`;
    const reasoningKey = `${streamId}_reasoning`;
    const data = accumulatedContent.get(dataKey) || '';
    const reasoning = accumulatedContent.get(reasoningKey) || '';
    // 不区分思维链和正文，合并显示
    return reasoning + data;
  };

  // 获取显示的流列表
  const displayStreams = Array.from(activeStreams).filter(
    (id) => !filterStreamId || id === filterStreamId
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* 工具栏 */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '8px 12px',
          borderBottom: '1px solid #1e293b',
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={handleClear}
          style={{
            fontSize: 12,
            color: '#e2e8f0',
            background: '#334155',
            border: '1px solid #475569',
            borderRadius: 4,
            padding: '4px 8px',
            cursor: 'pointer',
          }}
        >
          清空
        </button>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: '#cbd5e1',
          }}
        >
          <Switch size="sm" checked={autoScroll} onCheckedChange={setAutoScroll} />
          自动滚动
        </label>
        <div style={{ flexGrow: 1 }} />
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          活跃流: {activeStreams.size} | 响应块: {chunks.length}
        </span>
        {currentStreamId && (
          <span style={{ fontSize: 11, color: '#60a5fa' }}>
            当前流: {currentStreamId}
          </span>
        )}
      </div>

      {/* 流选择器 */}
      {activeStreams.size > 1 && (
        <div
          style={{
            padding: '8px 12px',
            borderBottom: '1px solid #1e293b',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <label style={{ fontSize: 12, color: '#cbd5e1' }}>筛选流:</label>
          <select
            value={filterStreamId}
            onChange={(e) => setFilterStreamId(e.target.value)}
            style={{
              fontSize: 12,
              background: '#334155',
              color: '#e2e8f0',
              border: '1px solid #475569',
              borderRadius: 4,
              padding: '4px 8px',
              minWidth: 200,
            }}
          >
            <option value="">全部流</option>
            {Array.from(activeStreams).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 内容显示区域 */}
      <div
        ref={contentRef}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
          lineHeight: 1.6,
          background: '#0b1220',
          color: '#e2e8f0',
        }}
      >
        {displayStreams.length === 0 ? (
          <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px 20px' }}>
            {chunks.length === 0
              ? '等待流式响应...开始一次对话以查看响应块。'
              : '没有匹配的流式响应。'}
          </div>
        ) : (
          displayStreams.map((streamId) => {
            const accumulated = getAccumulatedText(streamId);
            const streamChunks = chunks.filter((c) => c.streamId === streamId);
            const lastChunk = streamChunks[streamChunks.length - 1];

            return (
              <div
                key={streamId}
                style={{
                  marginBottom: '24px',
                  border: '1px solid #334155',
                  borderRadius: 6,
                  overflow: 'hidden',
                }}
              >
                {/* 流头部 */}
                <div
                  style={{
                    padding: '8px 12px',
                    background: '#1e293b',
                    borderBottom: '1px solid #334155',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ color: '#60a5fa', fontWeight: 500 }}>{streamId}</span>
                    <span style={{ color: '#94a3b8', fontSize: 11 }}>
                      块数: {streamChunks.length}
                    </span>
                    {lastChunk?.isComplete && (
                      <span
                        style={{
                          color: '#10b981',
                          fontSize: 11,
                          background: 'rgba(16, 185, 129, 0.1)',
                          padding: '2px 6px',
                          borderRadius: 4,
                        }}
                      >
                        已完成
                      </span>
                    )}
                  </div>
                  <span style={{ color: '#64748b', fontSize: 11 }}>
                    总长度: {accumulated.length} 字符
                  </span>
                </div>

                {/* 累积内容 */}
                <div
                  style={{
                    padding: '12px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    minHeight: '100px',
                    maxHeight: '600px',
                    overflow: 'auto',
                  }}
                >
                  {accumulated || (
                    <span style={{ color: '#64748b', fontStyle: 'italic' }}>暂无内容</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default StreamResponseMonitorPlugin;
