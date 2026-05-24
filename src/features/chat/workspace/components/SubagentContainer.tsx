/**
 * 🆕 2026-01-20: SubagentContainer
 * 
 * 子代理执行容器组件
 * 在时间线上展示子代理任务时，提供可折叠的容器来显示子代理的执行过程（助手消息）
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { 
  CaretDown, 
  CaretRight, 
  CircleNotch, 
  Robot, 
  CheckCircle, 
  XCircle, 
  Clock,
  ArrowSquareOut,
  ArrowClockwise,
} from '@phosphor-icons/react';

import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { TextShimmer } from '../../components/ui/TextShimmer';
import { useWorkspaceStore } from '../workspaceStore';
import type { AgentStatus } from '../types';
// 🧪 测试插件日志
import {
  logContainerMount,
  logContainerUnmount,
  logContainerExpand,
  logContainerCollapse,
  logMessagesLoadStart,
  logMessagesLoadComplete,
  logMessagesLoadError,
  logStatusChange,
  logViewFullSession,
  logAutoRefresh,
} from '../../debug/subagentTestPlugin';

// 🔧 P1-2: 实时刷新间隔（毫秒）
const REFRESH_INTERVAL_MS = 2000;
// 🔧 P3-1: 防抖延迟（毫秒）
const DEBOUNCE_DELAY_MS = 300;

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface BackendMessage {
  id: string;
  role: string;
  blockIds: string[];
  timestamp: number;
}

interface BackendBlock {
  id: string;
  messageId: string;
  // 🔧 P4: 与后端 MessageBlock 对齐，后端使用 #[serde(rename = "type")]
  type: string;
  content?: string;
  toolOutput?: unknown;
}

interface LoadSessionResponse {
  session: unknown;
  messages: BackendMessage[];
  blocks: BackendBlock[];
  state?: unknown;
}

interface SubagentContainerProps {
  /** 子代理会话 ID */
  subagentSessionId: string;
  /** 点击查看完整会话的回调 */
  onViewFullSession?: (sessionId: string) => void;
}

export const SubagentContainer: React.FC<SubagentContainerProps> = ({
  subagentSessionId,
  onViewFullSession,
}) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // 🔧 P3-1: 请求版本号，用于取消过时请求
  const requestVersionRef = useRef(0);
  
  // 从 Store 获取子代理状态
  const agents = useWorkspaceStore((s) => s.agents);
  const agent = agents.find((a) => a.sessionId === subagentSessionId);
  const status: AgentStatus = agent?.status || 'idle';
  const skillId = agent?.skillId;

  // 🧪 测试插件：组件挂载/卸载日志
  useEffect(() => {
    logContainerMount(subagentSessionId);
    return () => {
      logContainerUnmount(subagentSessionId);
    };
  }, [subagentSessionId]);

  // 加载子代理会话的消息
  // 🔧 P3-1: 使用版本号机制取消过时请求
  const loadMessages = useCallback(async () => {
    if (!isExpanded) return;
    
    // 递增版本号，使之前的请求过时
    const currentVersion = ++requestVersionRef.current;
    
    setLoading(true);
    setError(null);
    
    // 🧪 测试插件：记录加载开始
    logMessagesLoadStart(subagentSessionId);
    
    try {
      const response = await invoke<LoadSessionResponse>('chat_v2_load_session', {
        sessionId: subagentSessionId,
      });
      
      // 🔧 P3-1: 检查请求是否已过时
      if (currentVersion !== requestVersionRef.current) {
        console.log('[SubagentContainer] Request cancelled (outdated version)');
        return;
      }
      
      // 消息内容存储在 blocks 中，需要通过 blockIds 关联
      const blockMap = new Map<string, BackendBlock>();
      for (const block of response.blocks) {
        blockMap.set(block.id, block);
      }
      
      const convertedMessages: DisplayMessage[] = response.messages.map(m => {
        let content = '';
        for (const blockId of m.blockIds) {
          const block = blockMap.get(blockId);
          if (block?.content) {
            content += block.content;
          }
        }
        
        return {
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: content || t('workspace.subagent.noContent', '[无内容]'),
          timestamp: m.timestamp,
        };
      });
      
      // 只显示助手消息（子代理执行过程）
      const assistantMessages = convertedMessages.filter(m => m.role === 'assistant');
      setMessages(assistantMessages);
      
      // 🧪 测试插件：记录加载完成
      logMessagesLoadComplete(subagentSessionId, assistantMessages.length);
    } catch (e: unknown) {
      // 🔧 P3-1: 只有当前版本的请求才设置错误
      if (currentVersion === requestVersionRef.current) {
        console.error('[SubagentContainer] Failed to load messages:', e);
        setError(String(e));
        // 🧪 测试插件：记录加载失败
        logMessagesLoadError(subagentSessionId, String(e));
      }
    } finally {
      // 🔧 P3-1: 只有当前版本的请求才清除 loading
      if (currentVersion === requestVersionRef.current) {
        setLoading(false);
      }
    }
  }, [subagentSessionId, isExpanded, t]);

  // 🔧 P3-1: 展开时防抖加载消息
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  useEffect(() => {
    if (isExpanded) {
      // 清除之前的防抖定时器
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      // 防抖延迟加载
      debounceTimerRef.current = setTimeout(() => {
        loadMessages();
      }, DEBOUNCE_DELAY_MS);
    }
    
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [isExpanded, loadMessages]);

  // sessionId 变化时清空旧数据
  useEffect(() => {
    setMessages([]);
    setError(null);
    setIsExpanded(false);
  }, [subagentSessionId]);

  // 🔧 P1-2: 实时刷新机制 - 当展开且状态为 running 时定期刷新
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  useEffect(() => {
    // 清理之前的定时器
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }
    
    // 只有展开且状态为 running 时才启动定时刷新
    if (isExpanded && status === 'running') {
      refreshIntervalRef.current = setInterval(() => {
        loadMessages();
      }, REFRESH_INTERVAL_MS);
    }
    
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
  }, [isExpanded, status, loadMessages]);

  // 🔧 P1-2: 状态变为 completed/failed 时最后刷新一次
  const prevStatusRef = useRef<AgentStatus>(status);
  useEffect(() => {
    // 🧪 测试插件：记录状态变化
    if (prevStatusRef.current !== status) {
      logStatusChange(subagentSessionId, prevStatusRef.current, status);
    }
    
    if (
      isExpanded &&
      prevStatusRef.current === 'running' &&
      (status === 'completed' || status === 'failed')
    ) {
      // 状态刚刚从 running 变为 completed/failed，最后刷新一次
      loadMessages();
    }
    prevStatusRef.current = status;
  }, [status, isExpanded, loadMessages, subagentSessionId]);

  // 状态图标 - 只在错误状态显示图标
  const StatusIcon = () => {
    switch (status) {
      case 'running':
        return null;
      case 'completed':
        return null;
      case 'failed':
        return <XCircle size={16} className="text-red-500" />;
      default:
        return null;
    }
  };

  // 状态文案
  const statusLabel = {
    idle: t('workspace.subagent.idle', '等待中'),
    running: t('workspace.subagent.running', '执行中'),
    completed: t('workspace.subagent.completed', '已完成'),
    failed: t('workspace.subagent.failed', '失败'),
  }[status];

  // 截取消息内容
  const truncateContent = (content: string, maxLen = 500): string => {
    if (content.length <= maxLen) return content;
    return content.slice(0, maxLen) + '...';
  };

  return (
    <div className="mt-2 border rounded-lg overflow-hidden bg-card/50">
      {/* 头部 - 可点击展开/收起 */}
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={() => {
          const newExpanded = !isExpanded;
          setIsExpanded(newExpanded);
          // 🧪 测试插件：记录展开/收起
          if (newExpanded) {
            logContainerExpand(subagentSessionId);
          } else {
            logContainerCollapse(subagentSessionId);
          }
        }}
        className="w-full !justify-start gap-2 !p-2.5 text-left"
      >
        {/* 折叠图标 */}
        {isExpanded ? (
          <CaretDown size={16} className="text-muted-foreground flex-shrink-0" />
        ) : (
          <CaretRight size={16} className="text-muted-foreground flex-shrink-0" />
        )}
        
        {/* 子代理图标和名称 */}
        <Robot size={16} className="text-primary flex-shrink-0" />
        <span className="text-sm font-medium">
          {skillId || t('workspace.subagent.title', '子代理')}
        </span>
        
        {/* 状态指示 */}
        <StatusIcon />
        {status === 'running' ? (
          <TextShimmer
            className="text-xs text-muted-foreground"
            duration={1.5}
            spread={3}
          >
            {statusLabel}
          </TextShimmer>
        ) : (
          <span className="text-xs text-muted-foreground">{statusLabel}</span>
        )}
        
        {/* 占位 */}
        <div className="flex-1" />
        
        {/* 查看完整会话按钮 */}
        {onViewFullSession && (
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              // 🧪 测试插件：记录查看完整会话
              logViewFullSession(subagentSessionId);
              onViewFullSession(subagentSessionId);
            }}
          >
            <ArrowSquareOut size={12} className="mr-1" />
            {t('workspace.viewFull', '查看完整')}
          </NotionButton>
        )}
      </NotionButton>

      {/* 展开的内容区域 */}
      {isExpanded && (
        <div className="border-t bg-muted/20">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <CircleNotch size={20} className="animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                {t('workspace.subagent.loading', '加载中...')}
              </span>
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-destructive text-center">
              {t('workspace.loadError', '加载失败')}: {error}
            </div>
          ) : messages.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground text-center">
              {status === 'running' 
                ? t('workspace.subagent.processing', '正在处理任务...')
                : t('workspace.subagent.noOutput', '暂无输出')}
            </div>
          ) : (
            <CustomScrollArea className="max-h-80">
              <div className="p-3 space-y-3">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className="text-sm bg-background rounded-lg p-3 border"
                  >
                    <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap break-words">
                      {truncateContent(msg.content)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-2">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ))}
              </div>
            </CustomScrollArea>
          )}
        </div>
      )}
    </div>
  );
};

export default SubagentContainer;
