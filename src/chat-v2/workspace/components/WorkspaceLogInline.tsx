/**
 * WorkspaceLogInline - 工作区日志内联组件
 *
 * 显示工作区消息日志，附着在消息底部而非侧边栏。
 * 用于调试和追踪多代理协作的工作情况。
 *
 * @module workspace/components/WorkspaceLogInline
 */

import React, { useState, useMemo } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Copy,
  Check,
  User,
  Bot,
  Bug,
} from 'lucide-react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { cn } from '@/utils/cn';
import { useShallow } from 'zustand/react/shallow';
import { useWorkspaceStore } from '../workspaceStore';
import type { WorkspaceMessage, MessageType } from '../types';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types';
import { copyDebugInfoToClipboard } from '../../debug/exportSessionDebug';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 消息类型配置
// ============================================================================

const messageTypeConfig: Record<MessageType, { i18nKey: string; className: string; icon: string }> = {
  task: { 
    i18nKey: 'workspace.messageType.task', 
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
    icon: '📋',
  },
  progress: { 
    i18nKey: 'workspace.messageType.progress', 
    className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300',
    icon: '⏳',
  },
  result: { 
    i18nKey: 'workspace.messageType.result', 
    className: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300',
    icon: '✅',
  },
  query: { 
    i18nKey: 'workspace.messageType.query', 
    className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300',
    icon: '❓',
  },
  correction: { 
    i18nKey: 'workspace.messageType.correction', 
    className: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
    icon: '🔧',
  },
  broadcast: { 
    i18nKey: 'workspace.messageType.broadcast', 
    className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    icon: '📢',
  },
};

// ============================================================================
// 消息类型标签组件
// ============================================================================

interface MessageTypeBadgeProps {
  type: MessageType;
}

const MessageTypeBadge: React.FC<MessageTypeBadgeProps> = ({ type }) => {
  const { t } = useTranslation('chatV2');
  const config = messageTypeConfig[type];
  return (
    <span className={cn('px-1.5 py-0.5 text-[10px] font-medium rounded inline-flex items-center gap-0.5', config.className)}>
      <span>{config.icon}</span>
      <span>{t(config.i18nKey)}</span>
    </span>
  );
};

// ============================================================================
// 单条消息组件
// ============================================================================

interface LogMessageItemProps {
  message: WorkspaceMessage;
  agents: Map<string, { role: string; skillId?: string }>;
}

const LogMessageItem: React.FC<LogMessageItemProps> = ({ message, agents }) => {
  const { t } = useTranslation(['chatV2', 'skills']);
  const senderInfo = agents.get(message.senderSessionId);
  const targetInfo = message.targetSessionId ? agents.get(message.targetSessionId) : null;

  const shortSenderId = message.senderSessionId.slice(-6);
  const shortTargetId = message.targetSessionId?.slice(-6);

  const time = new Date(message.createdAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const getSenderName = () => {
    if (!senderInfo) return shortSenderId;
    if (senderInfo.role === 'coordinator') return t('chatV2:workspace.agent.coordinator');
    if (senderInfo.skillId) {
      const skillName = t(`skills:builtinNames.${senderInfo.skillId}`, { defaultValue: '' });
      return skillName || senderInfo.skillId;
    }
    return shortSenderId;
  };

  const getTargetName = () => {
    if (!shortTargetId) return null;
    if (!targetInfo) return shortTargetId;
    if (targetInfo.role === 'coordinator') return t('chatV2:workspace.agent.coordinator');
    if (targetInfo.skillId) {
      const skillName = t(`skills:builtinNames.${targetInfo.skillId}`, { defaultValue: '' });
      return skillName || targetInfo.skillId;
    }
    return shortTargetId;
  };

  return (
    <div className="py-2 border-b border-border/30 last:border-0">
      {/* 头部信息 */}
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="text-[10px] text-muted-foreground font-mono">{time}</span>
        <MessageTypeBadge type={message.messageType} />
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {senderInfo?.role === 'coordinator' ? (
            <User className="w-3 h-3" />
          ) : (
            <Bot className="w-3 h-3" />
          )}
          <span className="font-medium">{getSenderName()}</span>
          {getTargetName() && (
            <>
              <span className="mx-0.5">→</span>
              {targetInfo?.role === 'coordinator' ? (
                <User className="w-3 h-3" />
              ) : (
                <Bot className="w-3 h-3" />
              )}
              <span className="font-medium">{getTargetName()}</span>
            </>
          )}
          {!message.targetSessionId && message.messageType === 'broadcast' && (
            <span className="text-[10px] text-muted-foreground/70">({t('chatV2:workspace.messageType.broadcast')})</span>
          )}
        </div>
      </div>
      {/* 消息内容 */}
      <div className="text-sm text-foreground/90 pl-1 whitespace-pre-wrap break-words">
        {message.content}
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export interface WorkspaceLogInlineProps {
  /** 自定义类名 */
  className?: string;
  /** 默认展开状态 */
  defaultExpanded?: boolean;
  /** 最大显示消息数 */
  maxMessages?: number;
  /** Chat Store （用于复制完整调试信息） */
  store?: StoreApi<ChatStore>;
}

export const WorkspaceLogInline: React.FC<WorkspaceLogInlineProps> = ({
  className,
  defaultExpanded = false,
  maxMessages = 20,
  store,
}) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const [debugCopied, setDebugCopied] = useState(false);

  // 从 Store 获取工作区数据
  const { workspace, agents, messages } = useWorkspaceStore(
    useShallow((state) => ({
      workspace: state.workspace,
      agents: state.agents,
      messages: state.messages,
    }))
  );

  // 🔧 P21 修复：按 workspaceId 过滤 agents
  const filteredAgents = useMemo(() => {
    if (!workspace?.id) return [];
    return agents.filter((a) => a.workspaceId === workspace.id);
  }, [agents, workspace?.id]);

  // 构建 Agent Map 便于查找
  const agentMap = useMemo(() => {
    const map = new Map<string, { role: string; skillId?: string }>();
    for (const agent of filteredAgents) {
      map.set(agent.sessionId, { role: agent.role, skillId: agent.skillId });
    }
    return map;
  }, [filteredAgents]);

  // 🔧 P21 修复：按 workspaceId 过滤消息
  const filteredMessages = useMemo(() => {
    if (!workspace?.id) return [];
    return messages.filter((m) => m.workspaceId === workspace.id);
  }, [messages, workspace?.id]);

  // 按时间倒序并截断
  const sortedMessages = useMemo(() => {
    return filteredMessages
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, maxMessages);
  }, [filteredMessages, maxMessages]);

  // 复制日志到剪贴板
  const handleCopyLog = async () => {
    if (copied) return;

    const logText = sortedMessages
      .map((msg) => {
        const time = new Date(msg.createdAt).toLocaleString();
        const sender = msg.senderSessionId.slice(-6);
        const target = msg.targetSessionId ? ` → ${msg.targetSessionId.slice(-6)}` : '';
        return `[${time}] [${msg.messageType}] ${sender}${target}\n${msg.content}`;
      })
      .join('\n\n');

    try {
      await copyTextToClipboard(logText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error: unknown) {
      console.error('[WorkspaceLogInline] Copy failed:', error);
    }
  };

  // 🆕 复制完整调试信息（思维链 + 工具调用 + 内容 + 工作区日志）
  const handleCopyDebugInfo = async () => {
    if (debugCopied || !store) return;
    try {
      await copyDebugInfoToClipboard(store, 'text');
      setDebugCopied(true);
      showGlobalNotification('success', t('debug.copySuccessDesc'), t('debug.copySuccess'));
      setTimeout(() => setDebugCopied(false), 2000);
    } catch (error: unknown) {
      showGlobalNotification('error', t('debug.copyFailed'));
    }
  };

  // 没有工作区或消息时不显示
  if (!workspace || filteredMessages.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'mt-3 rounded-lg border border-border/50 bg-muted/20 overflow-hidden',
        className
      )}
    >
      {/* 头部 - 可折叠 */}
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">
            {t('workspace.log.title')}
          </span>
          <span className="text-xs text-muted-foreground">
            ({filteredMessages.length})
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* 🆕 复制完整调试信息按钮 */}
          {store && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleCopyDebugInfo(); }} aria-label={t('debug.copyDebugInfo')} title={t('debug.copyDebugInfo')}>
              {debugCopied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Bug className="w-3.5 h-3.5" />}
            </NotionButton>
          )}
          {/* 复制日志按钮 */}
          <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleCopyLog(); }} aria-label={t('workspace.log.copy')} title={t('workspace.log.copy')}>
            {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          </NotionButton>
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* 消息列表 */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-border/30"
          >
            <div className="max-h-80 overflow-y-auto px-3">
              {sortedMessages.map((msg) => (
                <LogMessageItem
                  key={msg.id}
                  message={msg}
                  agents={agentMap}
                />
              ))}
            </div>
            {filteredMessages.length > maxMessages && (
              <div className="px-3 py-1.5 text-center text-[10px] text-muted-foreground border-t border-border/30">
                {t('workspace.log.moreMessages', {
                  count: filteredMessages.length - maxMessages,
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default WorkspaceLogInline;
