/**
 * Chat V2 - 睡眠块组件
 *
 * 显示主代理的睡眠状态，等待子代理完成任务后唤醒。
 * 支持：
 * - 嵌入完整的子代理聊天视图（复用 ChatContainer）
 * - 手动唤醒按钮
 * - 持久化状态（从数据库加载时仍可渲染）
 *
 * 核心设计：
 * - 子代理的渲染与主代理完全相同
 * - 使用 ChatContainer 组件（showInputBar=false）
 */

import React, { useState, useMemo, useEffect } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import {
  Moon,
  Sun,
  CaretDown,
  CaretRight,
  Clock,
  CheckCircle,
  CircleNotch,
  WarningCircle,
  XCircle,
  UsersThree,
  Chat,
  Robot,
  ArrowsOut,
  ArrowsIn,
} from '@phosphor-icons/react';

import type { BlockComponentProps } from '../../registry/blockRegistry';
import { blockRegistry } from '../../registry/blockRegistry';
import { ChatContainer } from '../../components/ChatContainer';
import { cn } from '@/utils/cn';
// 🆕 2026-01-21: 导入 workspace store，用于获取所有 worker 代理作为回退
// 🔧 parseAgentStatus：事件裸 string 状态统一经类型守卫解析，替代裸 cast
import { useWorkspaceStore, parseAgentStatus } from '../../workspace/workspaceStore';
import type { AgentStatus } from '../../workspace/types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { manualWake } from '../../workspace/api';
import {
  preheatSubagentSession,
  shouldPreheatSubagentSession,
} from './sessionPreheat';

// ============================================================================
// 类型定义
// ============================================================================

/** 唤醒条件 */
type WakeCondition =
  | { type: 'any_message' }
  | { type: 'result_message' }
  | { type: 'all_completed' }
  | { type: 'timeout'; ms: number };

/** 睡眠状态 */
type SleepStatus = 'sleeping' | 'awakened' | 'timeout' | 'cancelled';

/** 睡眠块输入数据（支持 snake_case 和 camelCase，因为后端 schema 使用 snake_case） */
export interface SleepBlockInput {
  // snake_case (后端 schema 格式)
  workspace_id?: string;
  awaiting_agents?: string[];
  wake_condition?: WakeCondition | string;
  timeout_ms?: number;
  // camelCase (兼容旧格式)
  workspaceId?: string;
  awaitingAgents?: string[];
  wakeCondition?: WakeCondition;
  timeoutMs?: number;
}

/** 睡眠块输出数据 */
export interface SleepBlockOutput {
  sleep_id: string;
  workspace_id: string;
  coordinator_session_id: string;
  awaiting_agents: string[];
  wake_condition: WakeCondition;
  status: SleepStatus;
  created_at: string;
  awakened_at?: string;
  awakened_by?: string;
  awaken_message?: string;
}

/** 子代理信息（用于嵌入视图）
 * 🔧 status 直接复用工作区 AgentStatus 联合类型（含 queued/cancelled/interrupted/closed），
 * 事件裸 string 一律经 parseAgentStatus 解析后写入，杜绝裸 cast 塞入未知值
 */
interface SubagentInfo {
  sessionId: string;
  skillId?: string;
  status: AgentStatus;
  lastMessage?: string;
}

// ============================================================================
// 子代理嵌入视图组件（复用完整聊天视图）
// ============================================================================

interface SubagentEmbedItemProps {
  agent: SubagentInfo;
  isCollapsed: boolean;
  onToggle: () => void;
}

/**
 * 子代理嵌入视图
 * 
 * 核心设计：直接复用 ChatContainer，实现与主代理完全相同的渲染
 */
const SubagentEmbedItem: React.FC<SubagentEmbedItemProps> = ({
  agent,
  isCollapsed,
  onToggle,
}) => {
  const { t } = useTranslation(['chatV2', 'workspace']);
  const [isFullHeight, setIsFullHeight] = useState(false);

  // 🔧 P25 修复：子代理嵌入视图首次渲染时主动预热 Store 和 Adapter
  useEffect(() => {
    if (!shouldPreheatSubagentSession(agent.sessionId, isCollapsed)) return;

    const sessionId = agent.sessionId;
    let cancelled = false;
    console.log(`[SleepBlock:SubagentEmbed] [PREHEAT] Starting preheat for session: ${sessionId}`);
    void preheatSubagentSession(sessionId, () => cancelled).catch((error: unknown) => {
      console.error(`[SleepBlock:SubagentEmbed] [PREHEAT] Failed to preheat session: ${sessionId}`, error);
    });
    return () => {
      cancelled = true;
    };
  }, [agent.sessionId, isCollapsed]);

  const statusIcon = useMemo(() => {
    switch (agent.status) {
      case 'running':
        return <CircleNotch size={14} className="text-primary animate-spin" />;
      case 'queued':
        return <Clock size={14} className="text-primary" />;
      case 'completed':
        return <CheckCircle size={14} className="text-success" />;
      case 'failed':
        return <WarningCircle size={14} className="text-destructive" />;
      case 'cancelled':
      case 'interrupted':
        return <XCircle size={14} className="text-warning" />;
      case 'closed':
        return <XCircle size={14} className="text-muted-foreground" />;
      default:
        return <Clock size={14} className="text-muted-foreground" />;
    }
  }, [agent.status]);

  const statusText = useMemo(() => {
    switch (agent.status) {
      case 'running':
        return t('sleep.subagent.running');
      case 'queued':
        return t('workspace:sleep.subagent.queued');
      case 'completed':
        return t('sleep.subagent.completed');
      case 'failed':
        return t('sleep.subagent.failed');
      case 'cancelled':
        return t('workspace:sleep.subagent.cancelled');
      case 'interrupted':
        return t('workspace:sleep.subagent.interrupted');
      case 'closed':
        return t('workspace:sleep.subagent.closed');
      default:
        return t('sleep.subagent.idle');
    }
  }, [agent.status, t]);

  const skillName = agent.skillId || t('sleep.unknownSkill');

  // 🆕 P33 UI优化：简化子代理项结构
  return (
    <div className="border-t border-border/30">
      {/* 紧凑头部行 */}
      <DsButton
        variant="ghost"
        size="sm"
        onClick={onToggle}
        className="w-full !justify-start gap-2 !px-3 !py-2 text-left"
      >
        {isCollapsed ? (
          <CaretRight size={14} className="text-muted-foreground" />
        ) : (
          <CaretDown size={14} className="text-muted-foreground" />
        )}
        <Robot size={14} className="text-primary" />
        <span className="text-sm font-medium truncate">{skillName}</span>
        <div className="flex items-center gap-1 ml-auto">
          {statusIcon}
          <span className="text-xs text-muted-foreground">{statusText}</span>
        </div>
        {/* 用 span 避免 button 嵌套（同 NoteToolPreview 范式），并放开强制尺寸保证触控目标 */}
        {!isCollapsed && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setIsFullHeight(!isFullHeight);
            }}
            onMouseDown={(e) => { e.stopPropagation(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                setIsFullHeight(!isFullHeight);
              }
            }}
            className="p-1.5 rounded hover:bg-[var(--interactive-hover)] transition-colors cursor-pointer relative z-10 flex-shrink-0 after:absolute after:-inset-2 after:content-['']"
            aria-label={t('sleep.toggleSize')}
          >
            {isFullHeight ? (
              <ArrowsIn size={14} className="text-muted-foreground" />
            ) : (
              <ArrowsOut size={14} className="text-muted-foreground" />
            )}
          </span>
        )}
      </DsButton>

      {/* 嵌入聊天视图 - 无额外边框；高度用视口相对值封顶，避免小屏嵌套滚动超出可视范围 */}
      {!isCollapsed && (
        <div className={cn("overflow-hidden", isFullHeight ? "h-[min(450px,60vh)]" : "h-[min(250px,40vh)]")}>
          <ChatContainer
            key={agent.sessionId}
            sessionId={agent.sessionId}
            showInputBar={false}
            className="h-full"
          />
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 睡眠块主组件
// ============================================================================

/** 终态集合：等待进度摘要里计入"已完成"的状态 */
const TERMINAL_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'completed', 'failed', 'cancelled', 'interrupted', 'closed',
]);

const SleepBlockComponent: React.FC<BlockComponentProps> = React.memo(({ block, store }) => {
  const { t } = useTranslation(['chatV2', 'workspace']);
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [isWaking, setIsWaking] = useState(false);
  const [subagentProgress, setSubagentProgress] = useState<Map<string, SubagentInfo>>(new Map());
  
  // 🆕 P33: 运行时状态（用于实时更新唤醒状态）
  const [runtimeStatus, setRuntimeStatus] = useState<SleepStatus | null>(null);
  const [runtimeAwakenedBy, setRuntimeAwakenedBy] = useState<string | null>(null);
  const [runtimeAwakenMessage, setRuntimeAwakenMessage] = useState<string | null>(null);

  // 从块数据获取睡眠信息
  const sleepInput = block.toolInput as unknown as SleepBlockInput | undefined;
  const sleepOutput = block.toolOutput as unknown as SleepBlockOutput | undefined;

  const sleepId = sleepOutput?.sleep_id;
  // 🔧 2026-01-21: 同时支持 snake_case（后端 schema）和 camelCase
  const workspaceId = sleepInput?.workspace_id || sleepInput?.workspaceId || sleepOutput?.workspace_id;
  const awaitingAgents = sleepOutput?.awaiting_agents || sleepInput?.awaiting_agents || sleepInput?.awaitingAgents || [];
  // 🆕 P33: 优先使用运行时状态，否则使用块数据
  const status = runtimeStatus || sleepOutput?.status || 'sleeping';
  const awakenedBy = runtimeAwakenedBy || sleepOutput?.awakened_by;
  const awakenMessage = runtimeAwakenMessage || sleepOutput?.awaken_message;
  const createdAt = sleepOutput?.created_at;
  const awakenedAt = sleepOutput?.awakened_at;

  // 监听子代理事件和唤醒事件
  useEffect(() => {
    if (!workspaceId) return;

    // listen() 是异步的：组件可能在注册完成前卸载，
    // 用 cancelled 标记确保晚到的 unlisten 也会被立即执行，避免监听器泄漏
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const register = (unlisten: () => void) => {
      if (cancelled) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    };

    const setupListeners = async () => {
      // Agent 状态变化
      const unlisten1 = await listen<{
        workspace_id: string;
        session_id: string;
        status: string;
      }>('workspace_agent_status_changed', (event) => {
        if (event.payload.workspace_id === workspaceId) {
          setSubagentProgress((prev) => {
            const next = new Map(prev);
            const existing = next.get(event.payload.session_id) || {
              sessionId: event.payload.session_id,
              status: 'idle' as const,
            };
            next.set(event.payload.session_id, {
              ...existing,
              // 🔧 裸 cast → 类型守卫：未知状态回退 'idle' 而不是污染联合类型
              status: parseAgentStatus(event.payload.status),
            });
            return next;
          });
        }
      });
      register(unlisten1);

      // 消息接收
      const unlisten2 = await listen<{
        workspace_id: string;
        message: {
          sender_session_id: string;
          content: string;
          message_type: string;
        };
      }>('workspace_message_received', (event) => {
        if (event.payload.workspace_id === workspaceId) {
          const msg = event.payload.message;
          setSubagentProgress((prev) => {
            const next = new Map(prev);
            const existing = next.get(msg.sender_session_id) || {
              sessionId: msg.sender_session_id,
              status: 'running' as const,
            };
            next.set(msg.sender_session_id, {
              ...existing,
              lastMessage: msg.content.slice(0, 100),
            });
            return next;
          });
        }
      });
      register(unlisten2);
      
      // 🆕 P33: 监听唤醒事件，实时更新睡眠块状态
      // 事件名与后端 emitter.rs 中的 COORDINATOR_AWAKENED 对应
      const unlisten3 = await listen<{
        workspace_id: string;
        coordinator_session_id: string;
        sleep_id: string;
        awakened_by: string;
        awaken_message?: string;
        wake_reason: string;
      }>('workspace_coordinator_awakened', (event) => {
        console.log('[SleepBlock] Received coordinator_awakened event:', event.payload);
        // 唤醒匹配：workspace_id 必须相等（已收紧）；sleepId 仅在 toolOutput 尚未落地的
        // 窗口期未知，此时同一 workspace 的其它睡眠块唤醒事件仍可能被误接受——
        // 该局限在 sleep_id 持久化后自然消失
        if (event.payload.workspace_id === workspaceId && (!sleepId || event.payload.sleep_id === sleepId)) {
          setRuntimeStatus('awakened');
          setRuntimeAwakenedBy(event.payload.awakened_by);
          if (event.payload.awaken_message) {
            setRuntimeAwakenMessage(event.payload.awaken_message);
          }
        }
      });
      register(unlisten3);
    };

    setupListeners();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [workspaceId, sleepId]);

  // 手动唤醒
  const handleManualWake = async () => {
    if (!sleepId || !workspaceId) return;
    setIsWaking(true);
    try {
      const result = await manualWake(workspaceId, sleepId);
      if (result?.success) {
        showGlobalNotification('success', t('sleep.wakeSuccess'));
      } else {
        showGlobalNotification('warning', t('sleep.wakeNoop'));
      }
    } catch (error: unknown) {
      console.error('[SleepBlock] Manual wake failed:', error);
      const msg = error instanceof Error ? error.message : String(error);
      showGlobalNotification('error', t('sleep.wakeFailed', { msg, defaultValue: 'Wake failed: {{msg}}' }));
    } finally {
      setIsWaking(false);
    }
  };

  // 切换子代理展开状态
  const toggleAgent = (sessionId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  // 状态图标和颜色
  const statusConfig = useMemo(() => {
    switch (status) {
      case 'sleeping':
        return {
          icon: <Moon className="w-4 h-4" />,
          bgColor: 'bg-indigo-50 dark:bg-indigo-900/20',
          borderColor: 'border-indigo-200 dark:border-indigo-800',
          textColor: 'text-indigo-700 dark:text-indigo-300',
          label: t('sleep.status.sleeping'),
        };
      case 'awakened':
        return {
          icon: <Sun className="w-4 h-4" />,
          bgColor: 'bg-success/10',
          borderColor: 'border-success/30',
          textColor: 'text-success',
          label: t('sleep.status.awakened'),
        };
      case 'timeout':
        return {
          icon: <Clock className="w-4 h-4" />,
          bgColor: 'bg-warning/10',
          borderColor: 'border-warning/30',
          textColor: 'text-warning',
          label: t('sleep.status.timeout'),
        };
      case 'cancelled':
        return {
          icon: <WarningCircle size={16} />,
          bgColor: 'bg-danger/10',
          borderColor: 'border-danger/30',
          textColor: 'text-danger',
          label: t('sleep.status.cancelled'),
        };
      default:
        return {
          icon: <Moon className="w-4 h-4" />,
          bgColor: 'bg-muted/30',
          borderColor: 'border-border/50',
          textColor: 'text-muted-foreground',
          label: t('sleep.status.unknown'),
        };
    }
  }, [status, t]);

  // 🆕 2026-01-21: 从 workspace store 获取所有 worker 代理作为回退
  const workspaceAgents = useWorkspaceStore((state) => state.agents);
  const workspaceWorkerSessionIds = useMemo(() => {
    // 获取当前 workspace 中所有非 coordinator 的代理 sessionId
    return workspaceAgents
      .filter((a) => a.workspaceId === workspaceId && a.role !== 'coordinator')
      .map((a) => a.sessionId);
  }, [workspaceAgents, workspaceId]);

  // 合并 awaitingAgents 和 subagentProgress
  // 🔧 P17 修复：优先使用 toolOutput 中的 awaiting_agents（支持刷新后恢复）
  // 回退顺序：toolOutput.awaiting_agents > toolInput > workspaceStore
  const agents = useMemo(() => {
    const result: SubagentInfo[] = [];
    
    // 确定代理 sessionId 列表的优先级
    // 1. 首先使用 sleepOutput.awaiting_agents（刷新后仍可用）
    // 2. 其次使用 sleepInput 中的 awaiting_agents
    // 3. 最后回退到 workspace store 中的 worker 代理
    let agentSessionIds: string[] = [];
    if (awaitingAgents.length > 0) {
      agentSessionIds = awaitingAgents;
    } else if (workspaceWorkerSessionIds.length > 0) {
      agentSessionIds = workspaceWorkerSessionIds;
    }
    
    console.log('[SleepBlock] agents source:', {
      awaitingAgents,
      workspaceWorkerSessionIds,
      finalSessionIds: agentSessionIds,
    });
    
    for (const sessionId of agentSessionIds) {
      const progress = subagentProgress.get(sessionId);
      // 尝试从 workspace store 获取更多信息
      const wsAgent = workspaceAgents.find((a) => a.sessionId === sessionId);
      result.push(
        progress || {
          sessionId,
          skillId: wsAgent?.skillId,
          // wsAgent.status 本就是 AgentStatus，SubagentInfo 复用同一联合类型后无需 cast
          status: wsAgent?.status ?? 'idle',
        }
      );
    }
    return result;
  }, [awaitingAgents, workspaceWorkerSessionIds, subagentProgress, workspaceAgents]);

  // 🆕 等待进度摘要：终态（completed/failed/cancelled/interrupted/closed）计入"已完成"
  const terminalCount = useMemo(
    () => agents.filter((a) => TERMINAL_AGENT_STATUSES.has(a.status)).length,
    [agents]
  );

  // 🆕 P33 UI优化：简化结构，减少嵌套
  return (
    <div className={cn(
      "rounded-lg border overflow-hidden",
      statusConfig.borderColor,
      status === 'sleeping' ? 'bg-card' : statusConfig.bgColor
    )}>
      {/* 紧凑头部：状态 + 子代理数 + 唤醒按钮 */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 cursor-pointer",
          status === 'sleeping' ? statusConfig.bgColor : 'bg-transparent'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className={statusConfig.textColor}>{statusConfig.icon}</div>
        <span className={`text-sm font-medium ${statusConfig.textColor}`}>
          {statusConfig.label}
        </span>
        {agents.length > 0 && (
          <span className="text-xs text-muted-foreground">
            ({agents.length})
          </span>
        )}
        {/* 🆕 等待进度摘要（仅睡眠中显示）：M/N 已完成 */}
        {status === 'sleeping' && agents.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {t('workspace:sleep.progress', { done: terminalCount, total: agents.length })}
          </span>
        )}
        <div className="flex-1" />
        {status === 'sleeping' && (
          <DsButton
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleManualWake();
            }}
            disabled={isWaking}
            className="bg-white dark:bg-gray-800"
          >
            {isWaking ? <CircleNotch size={12} className="animate-spin" /> : t('sleep.wakeButton')}
          </DsButton>
        )}
        {isExpanded ? (
          <CaretDown size={16} className="text-muted-foreground" />
        ) : (
          <CaretRight size={16} className="text-muted-foreground" />
        )}
      </div>

      {/* 展开内容：直接显示子代理列表，无额外包装 */}
      {isExpanded && (
        <>
          {/* 子代理列表 - 直接渲染，无外层容器 */}
          {agents.map((agent) => (
            <SubagentEmbedItem
              key={agent.sessionId}
              agent={agent}
              isCollapsed={!expandedAgents.has(agent.sessionId)}
              onToggle={() => toggleAgent(agent.sessionId)}
            />
          ))}

          {/* 唤醒信息 + 元信息合并为底部栏 */}
          <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border/30 bg-muted/20 text-2xs text-muted-foreground">
            {status === 'awakened' && awakenedBy && (
              <>
                <Chat size={12} className="text-success" />
                <span className="text-success">
                  {t('sleep.awakenedBy', { agent: awakenedBy.slice(-8) })}
                </span>
                {awakenMessage && <span className="truncate max-w-[150px]">{awakenMessage}</span>}
                <span className="text-border">|</span>
              </>
            )}
            {createdAt && (
              <span>{new Date(createdAt).toLocaleTimeString()}</span>
            )}
            {awakenedAt && (
              <>
                <span>→</span>
                <span>{new Date(awakenedAt).toLocaleTimeString()}</span>
              </>
            )}
            {sleepId && <span className="font-mono ml-auto">{sleepId.slice(-12)}</span>}
          </div>
        </>
      )}
    </div>
  );
});

// ============================================================================
// 注册块类型
// ============================================================================

blockRegistry.register('sleep', {
  type: 'sleep',
  component: SleepBlockComponent,
  onAbort: 'keep-content',
});

export default SleepBlockComponent;
