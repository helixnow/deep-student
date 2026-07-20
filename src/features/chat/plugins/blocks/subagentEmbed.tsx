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
 * - 状态单一真相：useWorkspaceStore.agents 是子代理状态的权威来源；
 *   chat_v2_session_* 事件仅作为流式进行中的细粒度提示与回退
 */

import React, { useState, useMemo, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import {
  CaretDown,
  CaretRight,
  Robot,
  CheckCircle,
  CircleNotch,
  WarningCircle,
  XCircle,
  Clock,
  ArrowsOut,
  ArrowsIn,
} from '@phosphor-icons/react';

import type { BlockComponentProps } from '../../registry/blockRegistry';
import { blockRegistry } from '../../registry/blockRegistry';
import { ChatContainer } from '../../components/ChatContainer';
import { cn } from '@/utils/cn';
import {
  preheatSubagentSession,
  shouldPreheatSubagentSession,
} from './sessionPreheat';
// 🆕 P25: 导入子代理事件日志函数
import { addSubagentEventLog } from '../../debug/exportSessionDebug';
// 🆕 状态单一真相：从工作区 Store 订阅子代理状态
import { useWorkspaceStore } from '../../workspace/workspaceStore';
import type { AgentStatus } from '../../workspace/types';

// ============================================================================
// 数据读取（类型守卫，兼容新旧后端输出格式）
// ============================================================================

/**
 * 后端 subagent_call 的 toolOutput（snake_case）：
 * - 旧格式：{ agent_session_id, workspace_id, skill_id, status: "auto_starting", ... }
 * - 新格式：额外提供 session_id（与 agent_session_id 同值）、task_summary，
 *   且 status 直接为 "running"
 * toolInput 是 LLM 原始参数 { workspace_id, skill_id, task }（没有 sessionId）。
 * 历史上还存在过 camelCase 的 SubagentEmbedInput 形态，一并兼容。
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 依次尝试多个 key，返回第一个非空字符串 */
function readString(
  source: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'completed', 'failed', 'cancelled', 'interrupted', 'closed',
]);

/**
 * 归一化后端返回的子代理状态字符串
 * - "auto_starting"（旧格式）→ 'running'
 * - 未知值 → 'running' 并 console.warn（视为进行中，避免 UI 卡在无法识别的状态）
 */
function normalizeSubagentStatus(raw: unknown): AgentStatus | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  switch (raw) {
    case 'idle':
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
    case 'closed':
      return raw;
    case 'auto_starting':
      return 'running';
    default:
      console.warn(`[SubagentEmbed] Unknown subagent status "${raw}", treating as 'running'`);
      return 'running';
  }
}

// ============================================================================
// 子代理嵌入视图组件
// ============================================================================

const SubagentEmbedBlockComponent: React.FC<BlockComponentProps> = React.memo(({ block }) => {
  const { t } = useTranslation('chatV2');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isFullHeight, setIsFullHeight] = useState(false);

  // 从块数据安全读取子代理信息（兼容新旧格式）
  const input = asRecord(block.toolInput);
  // 实时路径 setBlockResult 已解包 { result, durationMs }，但历史数据可能保留包装，双重兼容
  const rawOutput = asRecord(block.toolOutput);
  const output = asRecord(rawOutput?.result) ?? rawOutput;

  const sessionId =
    readString(output, 'session_id', 'agent_session_id') ?? readString(input, 'sessionId');
  const skillId = readString(output, 'skill_id') ?? readString(input, 'skill_id', 'skillId');
  const taskSummary =
    readString(output, 'task_summary') ?? readString(input, 'task', 'taskSummary');
  const resultSummary = readString(output, 'result_summary');
  const createdAt = readString(output, 'created_at');
  const completedAt = readString(output, 'completed_at');
  const outputStatus = normalizeSubagentStatus(output?.status);

  // 🆕 状态单一真相：workspaceStore.agents 由 workspace_agent_status_changed 等事件维护
  // 选择器直接返回目标 agent 的 status（未变更时引用相同），避免无关更新触发重渲染
  const storeStatus = useWorkspaceStore((s) =>
    sessionId ? s.agents.find((a) => a.sessionId === sessionId)?.status : undefined
  );

  // chat_v2_session_* 事件仅作为"流式进行中"的细粒度提示；终态判断以 store 为准
  const [streamHint, setStreamHint] = useState<AgentStatus | undefined>(undefined);

  // 🔧 P25 修复：子代理嵌入视图首次渲染时主动预热 Store 和 Adapter
  // 这确保 ChatContainer 渲染时 isDataLoaded=true，避免显示空白
  useEffect(() => {
    if (!shouldPreheatSubagentSession(sessionId, isCollapsed)) return;

    let cancelled = false;
    console.log(`[SubagentEmbed] [PREHEAT] Starting preheat for session: ${sessionId}`);
    addSubagentEventLog('preheat_start', sessionId, 'SubagentEmbed preheat starting');
    void preheatSubagentSession(sessionId, () => cancelled)
      .then(() => {
        if (!cancelled) {
          addSubagentEventLog('preheat_done', sessionId, 'SubagentEmbed preheat completed');
        }
      })
      .catch((error: unknown) => {
        console.error(`[SubagentEmbed] [PREHEAT] Failed to preheat session: ${sessionId}`, error);
        addSubagentEventLog('error', sessionId, 'SubagentEmbed preheat failed', error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, isCollapsed]);

  // 监听子代理会话事件（仅作为流式细粒度提示，终态以 workspaceStore 为准）
  useEffect(() => {
    if (!sessionId) return;

    // listen() 是异步的：组件可能在注册完成前卸载，
    // 用 cancelled 标记确保晚到的 unlisten 也会被立即执行，避免监听器泄漏
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      // 监听会话级事件通道：chat_v2_session_{sessionId}
      const eventChannel = `chat_v2_session_${sessionId}`;
      const fn = await listen<{
        sessionId: string;
        eventType: string;
        messageId?: string;
      }>(eventChannel, (event) => {
        const { eventType } = event.payload;
        console.log(`[SubagentEmbed] [EVENT] Received event: ${eventType} for session: ${sessionId}`);
        if (eventType === 'stream_start') {
          setStreamHint('running');
        } else if (eventType === 'stream_complete') {
          setStreamHint('completed');
        } else if (eventType === 'stream_error') {
          setStreamHint('failed');
        } else if (eventType === 'stream_cancelled') {
          setStreamHint('cancelled');
        }
      });
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    };

    setup();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId]);

  // 状态推导（优先级：store 单一真相 → 流式事件提示 → toolOutput 终态 → 块自身状态）
  const status: AgentStatus = useMemo(() => {
    if (storeStatus) return storeStatus;
    if (streamHint) return streamHint;
    if (outputStatus && TERMINAL_STATUSES.has(outputStatus)) return outputStatus;
    // 块自身仍在执行（subagent_call 工具尚未返回）→ 进行中
    if (block.status === 'pending' || block.status === 'running') return 'running';
    if (block.status === 'error') return 'failed';
    // 历史会话：store 已无该 agent 且无终态信息（如旧格式 "auto_starting"）→ 视为已结束
    return 'completed';
  }, [storeStatus, streamHint, outputStatus, block.status]);

  // 状态图标
  const statusIcon = useMemo(() => {
    switch (status) {
      case 'running':
        return <CircleNotch size={16} className="text-primary animate-spin" />;
      case 'queued':
        return <Clock size={16} className="text-primary" />;
      case 'completed':
        return <CheckCircle size={16} className="text-success" />;
      case 'failed':
        return <WarningCircle size={16} className="text-destructive" />;
      case 'cancelled':
      case 'interrupted':
        return <XCircle size={16} className="text-warning" />;
      case 'closed':
        return <XCircle size={16} className="text-muted-foreground" />;
      default:
        return <Clock size={16} className="text-muted-foreground" />;
    }
  }, [status]);

  // 状态文本
  const statusText = useMemo(() => {
    switch (status) {
      case 'running':
        return t('subagent.status.running');
      case 'queued':
        return t('subagent.status.queued');
      case 'completed':
        return t('subagent.status.completed');
      case 'failed':
        return t('subagent.status.failed');
      case 'cancelled':
        return t('subagent.status.cancelled');
      case 'interrupted':
        return t('subagent.status.interrupted');
      case 'closed':
        return t('subagent.status.closed');
      default:
        return t('subagent.status.idle');
    }
  }, [status, t]);

  // 卡片标题：优先任务摘要（截断），次选技能名，最后是会话 ID 尾巴
  const cardTitle = useMemo(() => {
    if (taskSummary) {
      const trimmed = taskSummary.trim();
      if (trimmed) {
        return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
      }
    }
    if (skillId) return skillId;
    if (sessionId) return `…${sessionId.slice(-8)}`;
    return t('subagent.unknownSkill');
  }, [taskSummary, skillId, sessionId, t]);

  // 实时路径：subagent_call 的 toolInput 没有 sessionId，工具返回前 output 也不存在。
  // 块仍在执行时显示"启动中"占位，而不是错误卡
  if (!sessionId) {
    const blockInProgress =
      block.isPreparing || block.status === 'pending' || block.status === 'running';
    if (blockInProgress) {
      return (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-border/50 bg-card">
          <Robot size={16} className="text-primary flex-shrink-0" />
          <span className="text-sm font-medium flex-1 truncate">{cardTitle}</span>
          <CircleNotch size={16} className="text-primary animate-spin flex-shrink-0" />
          <span className="text-xs text-muted-foreground flex-shrink-0">
            {t('subagent.status.running')}
          </span>
        </div>
      );
    }
    // 已结束但仍无 sessionId：数据确实缺失
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/5 border border-destructive/30">
        <WarningCircle size={16} className="text-destructive" />
        <span className="text-sm text-destructive">
          {t('subagent.noSessionId')}
        </span>
      </div>
    );
  }

  return (
    <div className={cn(
      "rounded-lg border border-border/50 bg-card overflow-hidden",
      status === 'running' && "ring-2 ring-primary/30"
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

        {/* 标题：任务摘要 > 技能名 > 会话 ID 尾巴 */}
        <span className="text-sm font-medium flex-1 truncate" title={taskSummary || skillId || sessionId}>
          {cardTitle}
        </span>

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
        <div className="px-3 pb-2 text-xs text-success line-clamp-2">
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
            <CheckCircle size={12} className="text-success" />
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
