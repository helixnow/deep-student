/**
 * ThinkingBlockDebugPlugin - 思维链块保存流程调试插件
 * 
 * 监听 thinking 块从流式生成到数据库保存的完整流程
 * 用于诊断 "刷新后 thinking 丢失" 问题
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { Separator } from '../../components/ui/shad/Separator';
import { Copy, Trash2, Brain, Database, Zap, RefreshCw, Radio } from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { sessionManager } from '../../chat-v2/core/session';
import { useStreamingSessions } from '../../chat-v2/hooks/useStreamingSessions';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
// =============================================================================
// 类型定义
// =============================================================================

interface ThinkingEvent {
  id: string;
  timestamp: string;
  stage: 'stream' | 'collect' | 'save' | 'load';
  type: string;
  data: Record<string, unknown>;
}

interface BlockInfo {
  id: string;
  type: string;
  status: string;
  contentLength: number;
  hasContent: boolean;
}

// =============================================================================
// 组件
// =============================================================================

const ThinkingBlockDebugPlugin: React.FC<DebugPanelPluginProps> = () => {
  const [events, setEvents] = useState<ThinkingEvent[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [dbBlocks, setDbBlocks] = useState<BlockInfo[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true); // 自动跟随流式会话
  const unlistenRef = useRef<UnlistenFn | null>(null);
  
  // 使用 hook 自动监听流式会话
  const streamingSessions = useStreamingSessions(); // 事件驱动，无需轮询
  const allSessions = sessionManager.getAllSessionIds();

  // 添加事件
  const addEvent = useCallback((stage: ThinkingEvent['stage'], type: string, data: Record<string, unknown>) => {
    const event: ThinkingEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString().slice(11, 23),
      stage,
      type,
      data,
    };
    setEvents(prev => [...prev.slice(-99), event]); // 保留最近 100 条
  }, []);

  // 开始监听指定会话
  const startListeningSession = useCallback(async (sessionId: string) => {
    // 先停止之前的监听
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    
    if (!sessionId) {
      addEvent('stream', 'error', { message: '会话 ID 为空' });
      return;
    }

    setCurrentSessionId(sessionId);
    addEvent('stream', 'session_changed', { sessionId });

    // 监听 chat_v2_event_{sessionId}
    const eventChannel = `chat_v2_event_${sessionId}`;
    addEvent('stream', 'listening', { channel: eventChannel });

    try {
      const unlisten = await listen<{
        type: string;
        phase: string;
        messageId?: string;
        blockId?: string;
        block_id?: string;
        chunk?: string;
        content?: string;
        sequenceId?: number;
      }>(eventChannel, (event) => {
        const { type, phase, messageId, blockId, block_id, chunk, content } = event.payload;
        const actualBlockId = blockId || block_id;
        const actualContent = chunk || content || ''; // 后端用 chunk 字段
        
        // 只关注 thinking 相关事件
        if (type === 'thinking') {
          addEvent('stream', `${type}_${phase}`, {
            blockId: actualBlockId,
            messageId,
            contentLength: actualContent.length,
            contentPreview: actualContent.slice(0, 100),
          });
        }
        
        // 记录所有块类型（用于对比）
        if (phase === 'start' || phase === 'end') {
          addEvent('stream', `${type}_${phase}`, {
            blockId,
            messageId,
            type,
          });
        }
      });

      unlistenRef.current = unlisten;
      setIsListening(true);
      addEvent('stream', 'started', { sessionId });
    } catch (error) {
      addEvent('stream', 'error', { message: String(error) });
    }
  }, [addEvent]);

  // 停止监听
  const stopListening = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setIsListening(false);
    addEvent('stream', 'stopped', {});
  }, [addEvent]);

  // 从数据库加载块信息
  const loadBlocksFromDb = useCallback(async () => {
    if (!currentSessionId) {
      addEvent('load', 'error', { message: '请先开始监听会话' });
      return;
    }
    const sessionId = currentSessionId;

    try {
      addEvent('load', 'loading', { sessionId });
      
      const response = await invoke<{
        session: unknown;
        messages: Array<{ id: string; blockIds: string[] }>;
        blocks: Array<{
          id: string;
          type: string;
          status: string;
          content: string | null;
        }>;
      }>('chat_v2_load_session', { sessionId });

      const blockInfos: BlockInfo[] = response.blocks.map(b => ({
        id: b.id,
        type: b.type,
        status: b.status,
        contentLength: b.content?.length ?? 0,
        hasContent: !!b.content && b.content.length > 0,
      }));

      setDbBlocks(blockInfos);

      // 统计 thinking 块
      const thinkingBlocks = blockInfos.filter(b => b.type === 'thinking');
      
      addEvent('load', 'loaded', {
        totalBlocks: blockInfos.length,
        thinkingBlocks: thinkingBlocks.length,
        thinkingWithContent: thinkingBlocks.filter(b => b.hasContent).length,
        allTypes: [...new Set(blockInfos.map(b => b.type))],
      });
    } catch (error) {
      addEvent('load', 'error', { message: String(error) });
    }
  }, [currentSessionId, addEvent]);

  // 清除日志
  const clearEvents = useCallback(() => {
    setEvents([]);
    setDbBlocks([]);
  }, []);

  // 复制日志
  const copyLogs = useCallback(() => {
    const text = events.map(e => 
      `[${e.timestamp}] [${e.stage}] ${e.type}: ${JSON.stringify(e.data)}`
    ).join('\n');
    copyTextToClipboard(text);
  }, [events]);

  // 自动跟随流式会话
  useEffect(() => {
    if (!autoFollow) return;
    
    // 当有新的流式会话时，自动切换并开始监听
    const newStreamingSession = streamingSessions[0];
    if (newStreamingSession && newStreamingSession !== currentSessionId) {
      addEvent('stream', 'auto_follow', { 
        newSession: newStreamingSession,
        oldSession: currentSessionId 
      });
      void startListeningSession(newStreamingSession);
    }
  }, [streamingSessions, currentSessionId, autoFollow, addEvent, startListeningSession]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  // 获取阶段颜色
  const getStageColor = (stage: string) => {
    switch (stage) {
      case 'stream': return 'bg-blue-500';
      case 'collect': return 'bg-yellow-500';
      case 'save': return 'bg-green-500';
      case 'load': return 'bg-purple-500';
      default: return 'bg-gray-500';
    }
  };

  return (
    <div className="p-4 space-y-4 h-full overflow-auto">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Brain className="w-5 h-5" />
            Thinking 块调试
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 自动跟随状态 */}
          <div className="space-y-2">
            {/* 自动跟随开关 */}
            <div className="flex items-center gap-2">
              <Button 
                size="sm" 
                variant={autoFollow ? 'default' : 'outline'}
                onClick={() => setAutoFollow(!autoFollow)}
              >
                <Radio className={`w-4 h-4 mr-1 ${autoFollow ? 'animate-pulse' : ''}`} />
                {autoFollow ? '自动跟随中' : '自动跟随'}
              </Button>
              {streamingSessions.length > 0 && (
                <Badge variant="default" className="animate-pulse">
                  {streamingSessions.length} 个活跃流
                </Badge>
              )}
            </div>
            
            {/* 当前监听状态 */}
            {currentSessionId && (
              <div className="text-xs text-muted-foreground">
                当前监听: <code className="bg-muted px-1 rounded text-xs">{currentSessionId}</code>
                {isListening && <Badge variant="outline" className="ml-1">监听中</Badge>}
              </div>
            )}
            
            {/* 所有会话列表 */}
            <div className="text-xs text-muted-foreground">
              所有会话 ({allSessions.length}): 
              {allSessions.slice(0, 3).map(id => (
                <code key={id} className="ml-1 bg-muted px-1 rounded">{id.slice(0, 15)}...</code>
              ))}
              {allSessions.length > 3 && <span className="ml-1">...</span>}
            </div>
          </div>
          
          {/* 控制按钮 */}
          <div className="flex flex-wrap gap-2">
            {isListening ? (
              <Button size="sm" variant="destructive" onClick={stopListening}>
                停止监听
              </Button>
            ) : (
              <Button size="sm" disabled={!currentSessionId && streamingSessions.length === 0}>
                <Zap className="w-4 h-4 mr-1" />
                等待流式会话...
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={loadBlocksFromDb}>
              <Database className="w-4 h-4 mr-1" />
              从 DB 加载
            </Button>
            <Button size="sm" variant="outline" onClick={clearEvents}>
              <Trash2 className="w-4 h-4 mr-1" />
              清除
            </Button>
            <Button size="sm" variant="outline" onClick={copyLogs}>
              <Copy className="w-4 h-4 mr-1" />
              复制
            </Button>
          </div>

          {/* 当前会话 */}
          {currentSessionId && (
            <div className="text-sm text-muted-foreground">
              会话: <code className="text-xs">{currentSessionId}</code>
            </div>
          )}

          {/* DB 块统计 */}
          {dbBlocks.length > 0 && (
            <div className="p-2 bg-muted rounded text-sm">
              <div className="font-medium mb-1">数据库块统计:</div>
              <div className="grid grid-cols-2 gap-1 text-xs">
                <span>总块数: {dbBlocks.length}</span>
                <span>Thinking: {dbBlocks.filter(b => b.type === 'thinking').length}</span>
                <span>Content: {dbBlocks.filter(b => b.type === 'content').length}</span>
                <span>RAG: {dbBlocks.filter(b => b.type === 'rag').length}</span>
              </div>
              {/* 显示 thinking 块详情 */}
              {dbBlocks.filter(b => b.type === 'thinking').map(b => (
                <div key={b.id} className="mt-1 text-xs p-1 bg-background rounded">
                  <span className="font-mono">{b.id.slice(0, 12)}...</span>
                  <Badge variant={b.hasContent ? 'default' : 'destructive'} className="ml-1 text-xs">
                    {b.hasContent ? `${b.contentLength} chars` : '无内容!'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* 事件日志 */}
      <div className="space-y-1">
        <div className="text-sm font-medium flex items-center gap-2">
          事件日志 <Badge variant="outline">{events.length}</Badge>
        </div>
        <div className="max-h-[400px] overflow-auto space-y-1">
          {events.length === 0 ? (
            <div className="text-sm text-muted-foreground p-2">
              点击"开始监听"并发送消息来捕获事件
            </div>
          ) : (
            events.map(event => (
              <div
                key={event.id}
                className="text-xs p-2 bg-muted rounded font-mono"
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{event.timestamp}</span>
                  <Badge className={`${getStageColor(event.stage)} text-white text-xs`}>
                    {event.stage}
                  </Badge>
                  <span className="font-semibold">{event.type}</span>
                </div>
                <pre className="mt-1 text-xs overflow-auto whitespace-pre-wrap text-muted-foreground">
                  {JSON.stringify(event.data, null, 2)}
                </pre>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

// 导出插件元数据
export const pluginMeta = {
  id: 'thinking-block-debug',
  name: 'Thinking 块调试',
  icon: Brain,
  description: '监听 thinking 块流式生成和数据库保存流程',
};

export default ThinkingBlockDebugPlugin;
