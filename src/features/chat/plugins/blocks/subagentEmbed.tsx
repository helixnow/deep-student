/**
 * Chat V2 - 子代理嵌入视图块
 *
 * 在主代理的聊天中嵌入子代理的完整聊天视图。
 * 
 * 核心设计原则：
 * - 子代理的渲染与主代理完全相同
 * - 复用 ChatContainer（设置 showInputBar=false）
 * - 支持折叠/展开
 * - 实时显示子代理的流式响应
 */

import React, { useState, useMemo, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  CaretDown,
  CaretRight,
  Robot,
  CheckCircle,
  CircleNotch,
  WarningCircle,
  Clock,
  ArrowsOut,
  ArrowsIn,
} from '@phosphor-icons/react';

import type { BlockComponentProps } from '../../registry/blockRegistry';
import { blockRegistry } from '../../registry/blockRegistry';
import { ChatContainer } from '../../components/ChatContainer';
import { cn } from '@/utils/cn';
// 🆕 P25: 导入子代理事件日志函数
import { addSubagentEventLog } from '../../debug/exportSessionDebug';

// ============================================================================
// 类型定义
// ============================================================================

/** 子代理状态 */
type SubagentStatus = 'idle' | 'running' | 'completed' | 'failed';

/** 子代理嵌入块输入数据 */
export interface SubagentEmbedInput {
  sessionId: string;        // 子代理的会话 ID
  workspaceId: string;      // 工作区 ID
  skillId?: string;         // 技能 ID
  taskSummary?: string;     // 任务摘要
}

/** 子代理嵌入块输出数据 */
export interface SubagentEmbedOutput {
  session_id: string;
  workspace_id: string;
  skill_id?: string;
  status: SubagentStatus;
  created_at: string;
  completed_at?: string;
  result_summary?: string;
}

// ============================================================================
// 子代理嵌入视图组件
// ============================================================================

const SubagentEmbedBlockComponent: React.FC<BlockComponentProps> = React.memo(({ block, store }) => {
  const { t } = useTranslation('chatV2');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isFullHeight, setIsFullHeight] = useState(false);
  const [status, setStatus] = useState<SubagentStatus>('idle');

  // 从块数据获取子代理信息
  const embedInput = block.toolInput as unknown as SubagentEmbedInput | undefined;
  const embedOutput = block.toolOutput as unknown as SubagentEmbedOutput | undefined;

  const sessionId = embedInput?.sessionId || embedOutput?.session_id;
  const workspaceId = embedInput?.workspaceId || embedOutput?.workspace_id;
  const skillId = embedInput?.skillId || embedOutput?.skill_id;
  const taskSummary = embedInput?.taskSummary;
  const resultSummary = embedOutput?.result_summary;
  const createdAt = embedOutput?.created_at;
  const completedAt = embedOutput?.completed_at;

  // 🔧 P25 修复：子代理嵌入视图首次渲染时主动预热 Store 和 Adapter
  // 这确保 ChatContainer 渲染时 isDataLoaded=true，避免显示空白
  useEffect(() => {
    if (!sessionId) return;

    const preheatSubagentSession = async () => {
      try {
        console.log(`[SubagentEmbed] [PREHEAT] Starting preheat for session: ${sessionId}`);
        addSubagentEventLog('preheat_start', sessionId, 'SubagentEmbed preheat starting');
        
        // 动态导入避免循环依赖
        const { sessionManager } = await import('../../core/session/sessionManager');
        const { adapterManager } = await import('../../adapters/AdapterManager');
        
        // 1. 获取或创建 Store
        const subagentStore = sessionManager.getOrCreate(sessionId);
        console.log(`[SubagentEmbed] [PREHEAT] Store created for session: ${sessionId}`);
        
        // 2. 获取或创建 Adapter 并等待 setup 完成
        const adapterEntry = await adapterManager.getOrCreate(sessionId, subagentStore);
        console.log(`[SubagentEmbed] [PREHEAT] Adapter ready for session: ${sessionId}, isReady: ${adapterEntry.isReady}`);
        
        // 3. 如果数据未加载，主动触发 loadSession
        const state = subagentStore.getState();
        if (!state.isDataLoaded) {
          console.log(`[SubagentEmbed] [PREHEAT] Triggering loadSession for session: ${sessionId}`);
          await state.loadSession(sessionId);
          console.log(`[SubagentEmbed] [PREHEAT] loadSession completed for session: ${sessionId}`);
        } else {
          console.log(`[SubagentEmbed] [PREHEAT] Data already loaded for session: ${sessionId}`);
        }
        addSubagentEventLog('preheat_done', sessionId, 'SubagentEmbed preheat completed');
      } catch (error: unknown) {
        console.error(`[SubagentEmbed] [PREHEAT] Failed to preheat session: ${sessionId}`, error);
        addSubagentEventLog('error', sessionId, 'SubagentEmbed preheat failed', error instanceof Error ? error.message : String(error));
      }
    };

    preheatSubagentSession();
  }, [sessionId]);

  // 监听子代理会话事件（状态变化）
  useEffect(() => {
    if (!sessionId) return;

    let unlisten: (() => void) | undefined;

    const setup = async () => {
      // 监听会话级事件通道：chat_v2_session_{sessionId}
      const eventChannel = `chat_v2_session_${sessionId}`;
      unlisten = await listen<{
        sessionId: string;
        eventType: string;
        messageId?: string;
      }>(eventChannel, (event) => {
        const { eventType } = event.payload;
        console.log(`[SubagentEmbed] [EVENT] Received event: ${eventType} for session: ${sessionId}`);
        if (eventType === 'stream_start') {
          setStatus('running');
        } else if (eventType === 'stream_complete') {
          setStatus('completed');
        } else if (eventType === 'stream_error') {
          setStatus('failed');
        }
      });
    };

    setup();

    return () => {
      unlisten?.();
    };
  }, [sessionId]);

  // 从 embedOutput 同步状态
  useEffect(() => {
    if (embedOutput?.status) {
      setStatus(embedOutput.status);
    }
  }, [embedOutput?.status]);

  // 状态图标
  const statusIcon = useMemo(() => {
    switch (status) {
      case 'running':
        return <CircleNotch size={16} className="text-blue-500 animate-spin" />;
      case 'completed':
        return <CheckCircle size={16} className="text-green-500" />;
      case 'failed':
        return <WarningCircle size={16} className="text-red-500" />;
      default:
        return <Clock size={16} className="text-muted-foreground" />;
    }
  }, [status]);

  // 状态文本
  const statusText = useMemo(() => {
    switch (status) {
      case 'running':
        return t('subagent.status.running');
      case 'completed':
        return t('subagent.status.completed');
      case 'failed':
        return t('subagent.status.failed');
      default:
        return t('subagent.status.idle');
    }
  }, [status, t]);

  // 技能显示名称
  const skillName = skillId || t('subagent.unknownSkill');

  // 如果没有 sessionId，显示错误状态
  if (!sessionId) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
        <WarningCircle size={16} className="text-red-500" />
        <span className="text-sm text-red-700 dark:text-red-300">
          {t('subagent.noSessionId')}
        </span>
      </div>
    );
  }

  return (
    <div className={cn(
      "rounded-lg border border-border/50 bg-card overflow-hidden",
      status === 'running' && "ring-2 ring-blue-500/30"
    )}>
      {/* 头部：可点击折叠 */}
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full !justify-start gap-2 !p-3 text-left"
      >
        {/* 折叠图标 */}
        {isCollapsed ? (
          <CaretRight size={16} className="text-muted-foreground flex-shrink-0" />
        ) : (
          <CaretDown size={16} className="text-muted-foreground flex-shrink-0" />
        )}

        {/* 代理图标 */}
        <Robot size={16} className="text-primary flex-shrink-0" />

        {/* 技能名称 */}
        <span className="text-sm font-medium flex-1 truncate">{skillName}</span>

        {/* 状态 */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {statusIcon}
          <span className="text-xs text-muted-foreground">{statusText}</span>
        </div>

        {/* 高度切换按钮（仅展开时显示） */}
        {!isCollapsed && (
          <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); setIsFullHeight(!isFullHeight); }} className="!h-6 !w-6" aria-label={isFullHeight ? t('subagent.collapse') : t('subagent.expand')} title={isFullHeight ? t('subagent.collapse') : t('subagent.expand')}>
            {isFullHeight ? <ArrowsIn size={14} className="text-muted-foreground" /> : <ArrowsOut size={14} className="text-muted-foreground" />}
          </NotionButton>
        )}
      </NotionButton>

      {/* 任务摘要（折叠时显示） */}
      {isCollapsed && taskSummary && (
        <div className="px-3 pb-2 text-xs text-muted-foreground line-clamp-1">
          {taskSummary}
        </div>
      )}

      {/* 结果摘要（折叠且完成时显示） */}
      {isCollapsed && status === 'completed' && resultSummary && (
        <div className="px-3 pb-2 text-xs text-green-700 dark:text-green-400 line-clamp-2">
          {resultSummary}
        </div>
      )}

      {/* 嵌入的聊天视图（展开时显示） */}
      {!isCollapsed && (
        <div
          className={cn(
            "border-t border-border/50 overflow-hidden",
            isFullHeight ? "h-[600px]" : "h-[300px]"
          )}
        >
          {/* 
            核心复用：使用 ChatContainer 渲染子代理的完整聊天视图
            - showInputBar=false 隐藏输入栏
            - 子代理 sessionId 作为 key 确保独立 Store
          */}
          <ChatContainer
            key={sessionId}
            sessionId={sessionId}
            showInputBar={false}
            className="h-full"
          />
        </div>
      )}

      {/* 底部元信息 */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border/30 bg-muted/20 text-[10px] text-muted-foreground">
        {createdAt && (
          <div className="flex items-center gap-1">
            <Clock size={12} />
            <span>{new Date(createdAt).toLocaleTimeString()}</span>
          </div>
        )}
        {completedAt && (
          <div className="flex items-center gap-1">
            <CheckCircle size={12} className="text-green-500" />
            <span>{new Date(completedAt).toLocaleTimeString()}</span>
          </div>
        )}
        <span className="font-mono">{sessionId.slice(-12)}</span>
      </div>
    </div>
  );
});

// ============================================================================
// 注册块类型
// ============================================================================

blockRegistry.register('subagent_embed', {
  type: 'subagent_embed',
  component: SubagentEmbedBlockComponent,
  onAbort: 'keep-content',
});

export default SubagentEmbedBlockComponent;
